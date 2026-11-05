import { canonicalize } from './integrity.js';

/**
 * One change in an OLS change set (used by `ols diff`, overlays, and `ols merge`).
 * Operations follow RFC 6902 semantics, but target an entity by ID (`path` relative to that
 * entity) or a package document by its package-relative path (`path` relative to the document).
 */
export type ChangeOperation = {
  op: 'add' | 'remove' | 'replace' | 'test';
  entity?: string;
  document?: string;
  path: string;
  value?: unknown;
};

export class ChangeError extends Error {
  /** Index of the failing operation within the change set, when known. */
  index?: number;
}

type Json = unknown;
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const escapeToken = (token: string) => token.replaceAll('~', '~0').replaceAll('/', '~1');
const equal = (a: Json, b: Json) => canonicalize(a) === canonicalize(b);
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ChangeError(`Invalid JSON Pointer "${pointer}".`);
  return pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (allowEnd && token === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new ChangeError(`"${token}" is not an array index.`);
  const index = Number(token);
  if (index > length || (!allowEnd && index === length)) throw new ChangeError(`Array index ${index} is out of range.`);
  return index;
}

/** Applies one RFC 6902 operation at `pointer` inside `document`; returns the (possibly new) document root. */
export function applyAtPointer(document: Json, op: ChangeOperation['op'], pointer: string, value?: Json): Json {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) {
    if (op === 'test') { if (!equal(document, value)) throw new ChangeError('Test failed at the document root.'); return document; }
    if (op === 'remove') throw new ChangeError('Cannot remove the document root.');
    return clone(value);
  }
  let parent: Json = document;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[arrayIndex(token, parent.length, false)];
    else if (isObject(parent) && token in parent) parent = parent[token];
    else throw new ChangeError(`Path ${pointer} does not exist.`);
  }
  const last = tokens.at(-1)!;
  if (Array.isArray(parent)) {
    const index = arrayIndex(last, parent.length, op === 'add');
    if (op === 'add') parent.splice(index, 0, clone(value));
    else if (op === 'remove') parent.splice(index, 1);
    else if (op === 'replace') parent[index] = clone(value);
    else if (!equal(parent[index], value)) throw new ChangeError(`Test failed at ${pointer}.`);
  } else if (isObject(parent)) {
    const exists = Object.prototype.hasOwnProperty.call(parent, last);
    if (op !== 'add' && !exists) throw new ChangeError(`Path ${pointer} does not exist.`);
    if (op === 'add' || op === 'replace') parent[last] = clone(value);
    else if (op === 'remove') delete parent[last];
    else if (!equal(parent[last], value)) throw new ChangeError(`Test failed at ${pointer}.`);
  } else {
    throw new ChangeError(`Path ${pointer} does not exist.`);
  }
  return document;
}

/** Pointers of every entity (object with a string `id`) in a document, keyed by ID (first occurrence wins). */
export function entityPointers(document: Json): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (value: Json, pointer: string) => {
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${pointer}/${i}`));
    else if (isObject(value)) {
      if (typeof value.id === 'string' && !found.has(value.id)) found.set(value.id, pointer);
      for (const [key, item] of Object.entries(value)) {
        if (key === '$ref' || (key === 'operations' && value.type === 'overlay')) continue;
        visit(item, `${pointer}/${escapeToken(key)}`);
      }
    }
  };
  visit(document, '');
  return found;
}

function uniqueIds(items: Json[]): string[] | undefined {
  const ids = items.map((item) => (isObject(item) && typeof item.id === 'string' ? item.id : undefined));
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) return undefined;
  return ids as string[];
}

/**
 * Deterministic structural diff. Objects compare member by member (sorted by code unit); arrays of
 * entities with unique IDs are matched by ID (removals, then nested changes, then insertions);
 * other arrays compare index by index when equally long and are replaced otherwise.
 */
export function diffValues(before: Json, after: Json, pointer = '', out: Array<{ op: ChangeOperation['op']; path: string; value?: Json }> = []) {
  if (equal(before, after)) return out;
  if (isObject(before) && isObject(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byCodeUnit)) {
      const path = `${pointer}/${escapeToken(key)}`;
      if (!(key in after)) out.push({ op: 'remove', path });
      else if (!(key in before)) out.push({ op: 'add', path, value: clone(after[key]) });
      else diffValues(before[key], after[key], path, out);
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const beforeIds = uniqueIds(before);
    const afterIds = uniqueIds(after);
    if (beforeIds && afterIds) {
      const kept = new Set(afterIds);
      const common = beforeIds.filter((id) => kept.has(id));
      const original = new Set(beforeIds);
      if (common.join('\u0000') === afterIds.filter((id) => original.has(id)).join('\u0000')) {
        for (let i = before.length - 1; i >= 0; i--) if (!kept.has(beforeIds[i]!)) out.push({ op: 'remove', path: `${pointer}/${i}` });
        beforeIds.forEach((id, i) => { if (kept.has(id)) diffValues(before[i], after[afterIds.indexOf(id)], `${pointer}/${i}`, out); });
        afterIds.forEach((id, j) => { if (!original.has(id)) out.push({ op: 'add', path: `${pointer}/${j}`, value: clone(after[j]) }); });
        return out;
      }
    } else if (before.length === after.length) {
      before.forEach((item, i) => diffValues(item, after[i], `${pointer}/${i}`, out));
      return out;
    }
  }
  out.push({ op: 'replace', path: pointer, value: clone(after) });
  return out;
}

/**
 * Re-addresses document-absolute operations to the innermost entity that strictly contains the
 * changed location (so removing or inserting an entity targets its container). Operations outside
 * any entity target the document.
 */
export function targetOperations(document: string, base: Json, operations: Array<{ op: ChangeOperation['op']; path: string; value?: Json }>): ChangeOperation[] {
  const pointers = [...entityPointers(base)].sort(([, a], [, b]) => b.length - a.length);
  return operations.map(({ op, path, value }) => {
    const owner = pointers.find(([, pointer]) => path.startsWith(`${pointer}/`));
    const change: ChangeOperation = owner ? { op, entity: owner[0], path: path.slice(owner[1].length) } : { op, document, path };
    if (op !== 'remove') change.value = value;
    return change;
  });
}

/** Locates an entity by ID across documents (sorted by path for determinism). */
export function findEntity(documents: Map<string, Json>, id: string): { document: string; pointer: string } | undefined {
  for (const name of [...documents.keys()].sort(byCodeUnit)) {
    const pointer = entityPointers(documents.get(name)).get(id);
    if (pointer !== undefined) return { document: name, pointer };
  }
  return undefined;
}

/** Applies a change set to a map of package-relative document paths to parsed documents (mutated in place). */
export function applyChanges(documents: Map<string, Json>, operations: ChangeOperation[]): void {
  operations.forEach((change, i) => {
    try {
      if (change.entity !== undefined) {
        const location = findEntity(documents, change.entity);
        if (!location) throw new ChangeError(`Entity ${change.entity} does not exist.`);
        documents.set(location.document, applyAtPointer(documents.get(location.document), change.op, location.pointer + change.path, change.value));
      } else if (change.document !== undefined) {
        if (change.path === '' && change.op === 'add') {
          if (documents.has(change.document)) throw new ChangeError(`Document ${change.document} already exists.`);
          documents.set(change.document, clone(change.value));
        } else if (change.path === '' && change.op === 'remove') {
          if (!documents.delete(change.document)) throw new ChangeError(`Document ${change.document} does not exist.`);
        } else {
          if (!documents.has(change.document)) throw new ChangeError(`Document ${change.document} does not exist.`);
          documents.set(change.document, applyAtPointer(documents.get(change.document), change.op, change.path, change.value));
        }
      } else {
        throw new ChangeError('An operation must target an entity or a document.');
      }
    } catch (error) {
      if (error instanceof ChangeError) {
        const wrapped = new ChangeError(`Operation ${i} (${change.op} ${change.entity ?? change.document}${change.path}): ${error.message}`);
        wrapped.index = i;
        throw wrapped;
      }
      throw error;
    }
  });
}

const targetKey = (change: ChangeOperation) => (change.entity !== undefined ? `entity:${change.entity}` : `document:${change.document}`);
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const arrayParent = (change: ChangeOperation) => {
  if (change.op !== 'add' && change.op !== 'remove') return undefined;
  const tokens = parsePointer(change.path);
  const last = tokens.at(-1);
  return last !== undefined && /^(-|0|[1-9][0-9]*)$/.test(last) ? change.path.slice(0, change.path.lastIndexOf('/')) : undefined;
};

export type MergeConflict = { ours?: ChangeOperation; theirs?: ChangeOperation; file?: string };

/**
 * Combines two change sets made against the same base. Identical operations are kept once.
 * Operations conflict when they target the same entity or document at overlapping paths, or
 * both insert into or remove from the same array.
 */
export function combineChanges(ours: ChangeOperation[], theirs: ChangeOperation[]): { operations: ChangeOperation[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const extra: ChangeOperation[] = [];
  for (const other of theirs) {
    if (ours.some((mine) => canonicalize(mine) === canonicalize(other))) continue;
    const clash = ours.find((mine) => {
      if (targetKey(mine) !== targetKey(other)) return false;
      if (overlaps(mine.path, other.path)) return true;
      const a = arrayParent(mine);
      return a !== undefined && a === arrayParent(other);
    });
    if (clash) conflicts.push({ ours: clash, theirs: other });
    else extra.push(other);
  }
  return { operations: [...ours, ...extra], conflicts };
}
