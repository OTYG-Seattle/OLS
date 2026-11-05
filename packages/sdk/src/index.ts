import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import Ajv2020Import, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { listSchemas, loadSchema } from '@openliturgy/schemas';
import type { Diagnostic, JsonValue, LoadedDocument, OlsDocument, ValidationLayer, ValidationReport } from '@openliturgy/types';
export type { Diagnostic, LoadedDocument, OlsDocument, ValidationReport } from '@openliturgy/types';
import { bytesDigest, canonicalDigest, isPackageRelativeUri, manifestFileEntries, packageDigest } from './integrity.js';
export * from './integrity.js';
import { ATTESTED_STATUSES, approvalSignatureMessage, type Keyring, packageSignatureMessage, type SignatureEntry, signMessage, trustedKey, verifySignature } from './trust.js';
export * from './trust.js';
import { applyChanges, ChangeError, type ChangeOperation, combineChanges, diffValues, escapeToken, type MergeConflict, targetOperations } from './changes.js';
export * from './changes.js';
type AjvLike = { addSchema(schema: object, id: string): void; getSchema(id: string): ValidateFunction | undefined };

const layerOrder: ValidationLayer[] = ['parse', 'schema-selection', 'structural', 'consistency', 'references', 'semantic'];
const normalizePath = (value: string) => value.replaceAll('\\', '/');
// Code-unit order (not localeCompare) so TypeScript and Python sort diagnostics identically.
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const diagnosticSort = (a: Diagnostic, b: Diagnostic) =>
  layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer) || compareText(a.source, b.source) ||
  compareText(a.jsonPointer, b.jsonPointer) || compareText(a.code, b.code);

export class SchemaRegistry {
  readonly schemas = new Map<string, Record<string, unknown>>();
  readonly validators = new Map<string, ValidateFunction>();
  private ajv: AjvLike;

  constructor() {
    const AjvConstructor = (Ajv2020Import as unknown as { default?: new (options: object) => AjvLike }).default ?? Ajv2020Import as unknown as new (options: object) => AjvLike;
    this.ajv = new AjvConstructor({ allErrors: true, strict: false });
  }

  static async bundled(): Promise<SchemaRegistry> {
    const registry = new SchemaRegistry();
    const addFormats = (addFormatsImport as unknown as { default?: (ajv: unknown) => void }).default ?? addFormatsImport as unknown as (ajv: unknown) => void;
    addFormats(registry.ajv);
    for (const filename of await listSchemas()) registry.add(await loadSchema(filename));
    return registry;
  }

  add(schema: Record<string, unknown>): void {
    const id = String(schema.$id ?? '');
    if (!id) throw new Error('Schema is missing $id');
    this.schemas.set(id, schema);
    this.ajv.addSchema(schema, id);
  }

  get(id: string): Record<string, unknown> | undefined { return this.schemas.get(id); }
  validate(id: string, value: unknown): ValidateFunction | undefined {
    const validator = this.ajv.getSchema(id);
    if (validator) validator(value);
    return validator;
  }

  async refresh(cacheDirectory: string, baseUrl = 'https://ols.otyg.org/schema/v1.0/'): Promise<void> {
    await mkdir(cacheDirectory, { recursive: true });
    for (const filename of await listSchemas()) {
      const metadataPath = resolve(cacheDirectory, `${filename}.metadata.json`);
      let metadata: Record<string, string> = {};
      try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')); } catch { /* first refresh */ }
      const response = await fetch(new URL(filename, baseUrl), { headers: metadata.etag ? { 'If-None-Match': metadata.etag } : {} });
      if (response.status === 304) continue;
      if (!response.ok) throw new Error(`Unable to refresh ${filename}: HTTP ${response.status}`);
      const body = await response.text();
      const schema = JSON.parse(body);
      if (schema.$id !== new URL(filename, baseUrl).href) throw new Error(`${filename}: unexpected $id`);
      await writeFile(resolve(cacheDirectory, filename), `${JSON.stringify(schema, null, 2)}\n`);
      await writeFile(metadataPath, `${JSON.stringify({ url: response.url, etag: response.headers.get('etag') ?? '', sha256: createHash('sha256').update(body).digest('hex'), retrievedAt: new Date().toISOString() }, null, 2)}\n`);
    }
  }
}

export async function loadDocument(source: string): Promise<LoadedDocument> {
  const rawText = await readFile(source, 'utf8');
  try {
    const raw = JSON.parse(rawText) as JsonValue;
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as OlsDocument : undefined;
    return { source: normalizePath(source), rawText, raw, data };
  } catch {
    return { source: normalizePath(source), rawText, raw: null };
  }
}

async function jsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === 'tests' || entry.name === DEFAULT_PACKAGES_DIRECTORY)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.expected.json')) files.push(path);
  }
  return files.sort();
}

export async function loadPackage(root: string): Promise<LoadedDocument[]> {
  const absolute = resolve(root);
  const files = await jsonFiles(absolute);
  const manifest = resolve(absolute, 'manifest.ols.json');
  files.sort((a, b) => Number(b === manifest) - Number(a === manifest) || a.localeCompare(b));
  return Promise.all(files.map(loadDocument));
}

function report(diagnostics: Diagnostic[], filesChecked: string[], schemaVersions: string[], skippedLayers: ValidationLayer[] = []): ValidationReport {
  diagnostics.sort(diagnosticSort);
  return { valid: !diagnostics.some((item) => item.severity === 'error'), diagnostics, filesChecked: filesChecked.map(normalizePath).sort(), schemaVersions: [...new Set(schemaVersions)].sort(), skippedLayers };
}

function structuralDiagnostics(errors: ErrorObject[] | null | undefined, source: string, entityId?: string): Diagnostic[] {
  return (errors ?? []).map((error) => ({ layer: 'structural', source, entityId, jsonPointer: error.instancePath || '', code: `OLS_SCHEMA_${error.keyword.toUpperCase().replaceAll('-', '_')}`, message: error.message ?? 'Schema validation failed', severity: 'error', details: error.params as Record<string, JsonValue> }));
}

export async function validateDocument(input: string | LoadedDocument, registry?: SchemaRegistry): Promise<ValidationReport> {
  const loaded = typeof input === 'string' ? await loadDocument(input) : input;
  const diagnostics: Diagnostic[] = [];
  if (!loaded.data) {
    diagnostics.push({ layer: 'parse', source: loaded.source, jsonPointer: '', code: 'OLS_JSON_PARSE', message: 'File is not valid JSON object syntax.', severity: 'error' });
    return report(diagnostics, [loaded.source], [], ['schema-selection', 'structural', 'consistency', 'references', 'semantic']);
  }
  const schemas = registry ?? await SchemaRegistry.bundled();
  const schemaId = loaded.data.$schema;
  const schema = typeof schemaId === 'string' ? schemas.get(schemaId) : undefined;
  if (!schema) {
    diagnostics.push({ layer: 'schema-selection', source: loaded.source, entityId: loaded.data.id, jsonPointer: '/$schema', code: 'OLS_SCHEMA_UNSUPPORTED', message: 'The declared schema is missing or unsupported.', severity: 'error' });
    return report(diagnostics, [loaded.source], [], ['structural', 'consistency', 'references', 'semantic']);
  }
  const validator = schemas.validate(schemaId, loaded.data);
  diagnostics.push(...structuralDiagnostics(validator?.errors, loaded.source, loaded.data.id));
  const expectedType = schemaId.split('/').at(-1)?.replace('.schema.json', '');
  if (loaded.data.type !== expectedType) diagnostics.push({ layer: 'consistency', source: loaded.source, entityId: loaded.data.id, jsonPointer: '/type', code: 'OLS_TYPE_MISMATCH', message: `Expected type ${expectedType}.`, severity: 'error' });
  if (!/^1\.[01]\.\d+$/.test(loaded.data.ols_version ?? '')) diagnostics.push({ layer: 'consistency', source: loaded.source, entityId: loaded.data.id, jsonPointer: '/ols_version', code: 'OLS_VERSION_UNSUPPORTED', message: 'Only OLS 1.0.x and 1.1.x are supported.', severity: 'error' });
  if (schema['x-ols-schema-source'] === 'synthesized') diagnostics.push({ layer: 'schema-selection', source: loaded.source, entityId: loaded.data.id, jsonPointer: '/$schema', code: 'OLS_SCHEMA_PROVISIONAL', message: 'This per-entity schema is provisional.', severity: 'warning' });
  if (loaded.data.status === 'deprecated') diagnostics.push({ layer: 'consistency', source: loaded.source, entityId: loaded.data.id, jsonPointer: '/status', code: 'OLS_SCHEMA_DEPRECATED', message: 'This document is deprecated.', severity: 'warning' });
  validateTranslationVariants(loaded.data as Record<string, unknown>, loaded.source, '', diagnostics);
  return report(diagnostics, [loaded.source], [String(schema['x-ols-revision'] ?? '1.0.0')], validator?.errors?.length ? ['references', 'semantic'] : []);
}

type EntityLocation = { value: Record<string, unknown>; source: string; pointer: string };
function walk(value: unknown, source: string, pointer = '', entities: EntityLocation[] = [], refs: EntityLocation[] = []): { entities: EntityLocation[]; refs: EntityLocation[] } {
  if (!value || typeof value !== 'object') return { entities, refs };
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, source, `${pointer}/${index}`, entities, refs));
  else {
    const object = value as Record<string, unknown>;
    if (typeof object.id === 'string') entities.push({ value: object, source, pointer });
    if (typeof object.$ref === 'string') refs.push({ value: object, source, pointer });
    for (const [key, child] of Object.entries(object)) {
      // Overlay operations carry entities of another package as payload; they are not part of this one.
      if (key === '$ref' || (key === 'operations' && object.type === 'overlay')) continue;
      walk(child, source, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, entities, refs);
    }
  }
  return { entities, refs };
}

/** Entity fields whose values are IDs of other entities expected to resolve like `$ref`. */
export const idReferenceFields: Record<string, string[]> = {
  asset: ['linkedTo'],
  'conflict-rule': ['winner', 'overrides'],
  'execution-timeline': ['target'],
  'liturgical-day': ['readings', 'activePropers'],
  ordo: ['sections'],
  proper: ['ordos'],
  reading: ['role'],
  role: ['inherits'],
  'role-group': ['roles'],
  rubric: ['actors'],
  section: ['blocks'],
  'service-instance': ['ordo', 'activePropers'],
  'teaching-note': ['target'],
  utterance: ['roles'],
};

type ReferenceSite = { value: string; source: string; pointer: string };

/** Entity type, falling back to the containing key for embedded entities such as `{ "utterance": { ... } }`. */
function entityType(entity: EntityLocation): string {
  if (typeof entity.value.type === 'string' && entity.value.type in idReferenceFields) return entity.value.type;
  const key = entity.pointer.split('/').at(-1) ?? '';
  return key in idReferenceFields ? key : String(entity.value.type ?? '');
}

/** Every place a package refers to another entity: `$ref` objects and ID-valued fields. */
function referenceSites(entities: EntityLocation[], refs: EntityLocation[]): ReferenceSite[] {
  const sites: ReferenceSite[] = refs.map((ref) => ({ value: String(ref.value.$ref), source: ref.source, pointer: `${ref.pointer}/$ref` }));
  for (const entity of entities) {
    for (const field of idReferenceFields[entityType(entity)] ?? []) {
      const value = entity.value[field];
      if (typeof value === 'string') sites.push({ value, source: entity.source, pointer: `${entity.pointer}/${field}` });
      else if (Array.isArray(value)) value.forEach((item, i) => { if (typeof item === 'string') sites.push({ value: item, source: entity.source, pointer: `${entity.pointer}/${field}/${i}` }); });
    }
  }
  return sites;
}

/**
 * Splits a package-qualified reference (`<package>:<id>`) into its parts.
 * Returns undefined for local IDs, URNs, and file references.
 */
export function packageQualifier(reference: string): { package: string; local: string } | undefined {
  if (reference.startsWith('urn:') || reference.includes('/')) return undefined;
  const separator = reference.indexOf(':');
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { package: reference.slice(0, separator), local: reference.slice(separator + 1) };
}

/**
 * Resolves a reference against the package index.
 *
 * - An exact ID match always wins.
 * - `<package>:<id>` resolves locally only when `<package>` is this package (`packageName`);
 *   references into other packages are never satisfied by a same-named local entity.
 * - `urn:ols:<ref>` resolves `<ref>` with the same rules, falling back to the legacy
 *   mapping that replaces `:` with `.` (`urn:ols:a:b:c` -> `a.b.c`).
 * - Paths (`blocks/kyrie.ols.json`) resolve to a document inside the package root.
 */
export function resolveReference(reference: string, index: Map<string, EntityLocation>, packageRoot?: string, source?: string, packageName?: string): EntityLocation | undefined {
  if (index.has(reference)) return index.get(reference);
  if (reference.startsWith('urn:ols:')) {
    const rest = reference.slice(8);
    return resolveReference(rest, index, packageRoot, source, packageName) ?? index.get(rest.replaceAll(':', '.'));
  }
  if ((reference.includes('/') || reference.endsWith('.json')) && packageRoot && source) {
    const candidate = resolve(dirname(source), reference);
    const rel = relative(packageRoot, candidate);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return [...index.values()].find((item) => resolve(item.source) === candidate);
    return undefined;
  }
  const qualified = packageQualifier(reference);
  if (qualified && packageName && qualified.package === packageName) return index.get(qualified.local);
  return undefined;
}

export function validateTranslationVariants(value: unknown, source: string, pointer: string, diagnostics: Diagnostic[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (Array.isArray(value)) value.forEach((item, i) => validateTranslationVariants(item, source, `${pointer}/${i}`, diagnostics));
    return;
  }
  const obj = value as Record<string, unknown>;
  const textMap = obj.text;
  const variantsMap = obj.variants;
  if (textMap && typeof textMap === 'object' && !Array.isArray(textMap) && variantsMap && typeof variantsMap === 'object' && !Array.isArray(variantsMap)) {
    const text = textMap as Record<string, unknown>;
    const variants = variantsMap as Record<string, unknown>;
    const entityId = typeof obj.id === 'string' ? obj.id : undefined;
    for (const [lang, variantList] of Object.entries(variants)) {
      const langPointer = `${pointer}/variants/${lang.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!(lang in text)) {
        diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: langPointer, code: 'OLS_VARIANT_LANG_MISMATCH', message: `Variant language '${lang}' is not present in the text map.`, severity: 'error' });
      }
      if (!Array.isArray(variantList) || variantList.length === 0) {
        diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: langPointer, code: 'OLS_VARIANT_EMPTY_ARRAY', message: `Variant array for '${lang}' must contain at least one entry.`, severity: 'error' });
        continue;
      }
      let defaultCount = 0;
      const seenValues: string[] = [];
      for (let idx = 0; idx < variantList.length; idx++) {
        const variant = variantList[idx] as Record<string, unknown> | undefined;
        if (!variant || typeof variant !== 'object') continue;
        const vPointer = `${langPointer}/${idx}`;
        const vValue = variant.value;
        if (typeof vValue !== 'string' || !vValue) {
          diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: `${vPointer}/value`, code: 'OLS_VARIANT_VALUE_REQUIRED', message: "Variant object must have a non-empty 'value' field.", severity: 'error' });
        } else {
          if (seenValues.includes(vValue)) {
            diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: `${vPointer}/value`, code: 'OLS_VARIANT_NO_DUPLICATES', message: `Duplicate variant value in language '${lang}'.`, severity: 'warning' });
          }
          seenValues.push(vValue);
        }
        if (variant.default === true) {
          defaultCount++;
          if (defaultCount > 1) {
            diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: `${vPointer}/default`, code: 'OLS_VARIANT_MULTI_DEFAULT', message: `Multiple defaults declared for language '${lang}'.`, severity: 'error' });
          }
          if (typeof vValue === 'string' && lang in text && vValue !== text[lang]) {
            diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: `${vPointer}/value`, code: 'OLS_VARIANT_DEFAULT_SYNC', message: 'Default variant value does not match the text map entry.', severity: 'error' });
          }
        }
        if (!variant.label) {
          diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: vPointer, code: 'OLS_VARIANT_LABEL_RECOMMENDED', message: "Variant should include a 'label' for display.", severity: 'info' });
        }
        if (!variant.source) {
          diagnostics.push({ layer: 'consistency', source, entityId, jsonPointer: vPointer, code: 'OLS_VARIANT_SOURCE_RECOMMENDED', message: "Variant should include a 'source' for provenance.", severity: 'info' });
        }
      }
    }
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key !== 'text' && key !== 'variants' && key !== 'textMeta') {
      validateTranslationVariants(child, source, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, diagnostics);
    }
  }
}

export const LOCKFILE_NAME = 'ols.lock.json';
/** Default directory, relative to a package root, holding its resolved dependencies (skipped when loading the package itself). */
export const DEFAULT_PACKAGES_DIRECTORY = 'ols_packages';
export type LockEntry = { version: string; digest: string; resolved: string };
/** Returns the directory of a locked dependency, or undefined when it cannot be found. */
export type DependencyResolver = (name: string, entry: LockEntry, root: string) => Promise<string | undefined> | string | undefined;
export type PackageValidationOptions = {
  resolver?: DependencyResolver;
  /** Trusted signing keys. Without a keyring, signatures are checked for validity but not for trust. */
  keyring?: Keyring;
};

/** Resolves `lock.packages[name].resolved` as a directory relative to the package root. */
export const filesystemResolver: DependencyResolver = async (_name, entry, root) => {
  if (!isPackageRelativeUri(entry.resolved)) return undefined;
  const directory = resolve(root, entry.resolved);
  try { return (await stat(resolve(directory, 'manifest.ols.json'))).isFile() ? directory : undefined; } catch { return undefined; }
};

/** Splits a manifest dependency (`name` or `name@range`). */
export function parseDependency(spec: string): { name: string; range?: string } {
  const at = spec.indexOf('@');
  return at < 0 ? { name: spec } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/** A range is a version prefix: `1` matches 1.x.y, `1.2` matches 1.2.y, `1.2.3` matches exactly. */
export function versionSatisfies(version: string, range?: string): boolean {
  if (!range) return true;
  const have = version.split('.');
  return range.split('.').every((part, i) => have[i] === part);
}

const pointerToken = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

type LoadedDependency = { name: string; version: string; digest: string; root: string; index: Map<string, EntityLocation>; aliases: Record<string, string> };

function entityIndex(documents: LoadedDocument[]): { entities: EntityLocation[]; index: Map<string, EntityLocation> } {
  const entities: EntityLocation[] = [];
  for (const document of documents) if (document.data) walk(document.data, document.source, '', entities, []);
  const index = new Map<string, EntityLocation>();
  for (const entity of entities) if (!index.has(String(entity.value.id))) index.set(String(entity.value.id), entity);
  return { entities, index };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Loads every dependency pinned in `ols.lock.json` and checks it against the lock. No lockfile: nothing is resolved. */
async function loadDependencies(root: string, manifest: Record<string, unknown>, documents: LoadedDocument[], resolver: DependencyResolver, diagnostics: Diagnostic[]): Promise<Map<string, LoadedDependency>> {
  const loaded = new Map<string, LoadedDependency>();
  const lockSource = normalizePath(resolve(root, LOCKFILE_NAME));
  const lock = documents.find((d) => d.source === lockSource)?.data as Record<string, unknown> | undefined;
  if (!lock) return loaded;
  const locked = (lock.packages && typeof lock.packages === 'object' ? lock.packages : {}) as Record<string, LockEntry>;
  const declared = (Array.isArray(manifest.dependencies) ? manifest.dependencies : []).filter((item): item is string => typeof item === 'string').map(parseDependency);
  for (const { name, range } of declared) {
    const base = `/packages/${pointerToken(name)}`;
    const entry = locked[name];
    const push = (pointer: string, code: string, message: string, severity: Diagnostic['severity'] = 'error') =>
      diagnostics.push({ layer: 'references', source: lockSource, jsonPointer: pointer, code, message, severity });
    if (!entry || typeof entry !== 'object') { push('/packages', 'OLS_DEPENDENCY_UNLOCKED', `Dependency ${name} is declared but not locked; run \`ols lock\`.`); continue; }
    if (!versionSatisfies(String(entry.version), range)) push(`${base}/version`, 'OLS_DEPENDENCY_VERSION_MISMATCH', `Locked version ${entry.version} does not satisfy ${name}@${range}.`);
    const directory = typeof entry.resolved === 'string' ? await resolver(name, entry, root) : undefined;
    if (!directory) { push(`${base}/resolved`, 'OLS_DEPENDENCY_NOT_FOUND', `Dependency ${name} could not be found at ${entry.resolved}.`); continue; }
    const dependencyDocuments = await loadPackage(directory);
    const dependencyManifest = dependencyDocuments.find((d) => d.source === normalizePath(resolve(directory, 'manifest.ols.json')))?.data as Record<string, unknown> | undefined;
    if (!dependencyManifest || dependencyManifest.package !== name) { push(base, 'OLS_DEPENDENCY_MISMATCH', `The package at ${entry.resolved} is not ${name}.`); continue; }
    if (dependencyManifest.version !== entry.version) push(`${base}/version`, 'OLS_DEPENDENCY_VERSION_MISMATCH', `Resolved ${name} is version ${String(dependencyManifest.version)}, but the lock records ${entry.version}.`);
    const actual = packageDigest(dependencyManifest);
    if (actual !== entry.digest) push(`${base}/digest`, 'OLS_DEPENDENCY_DIGEST_MISMATCH', `Resolved ${name} has package digest ${actual}, but the lock records ${entry.digest}.`);
    const { entities, index } = entityIndex(dependencyDocuments);
    const problems = (await integrityDiagnostics(directory, dependencyDocuments, entities, true)).filter((d) => d.severity === 'error');
    if (problems.length) push(base, 'OLS_DEPENDENCY_INTEGRITY', `Dependency ${name} failed verification: ${[...new Set(problems.map((d) => d.code))].sort().join(', ')}.`);
    loaded.set(name, { name, version: String(dependencyManifest.version), digest: actual, root: directory, index, aliases: stringRecord(dependencyManifest.aliases) });
  }
  const declaredNames = new Set(declared.map((item) => item.name));
  for (const name of Object.keys(locked).sort()) if (!declaredNames.has(name)) diagnostics.push({ layer: 'references', source: lockSource, jsonPointer: `/packages/${pointerToken(name)}`, code: 'OLS_LOCK_ENTRY_UNUSED', message: `Lock entry ${name} is not a declared dependency.`, severity: 'warning' });
  return loaded;
}

export async function validatePackage(root: string, registry?: SchemaRegistry, options: PackageValidationOptions = {}): Promise<ValidationReport> {
  const schemas = registry ?? await SchemaRegistry.bundled();
  const documents = await loadPackage(root);
  const diagnostics: Diagnostic[] = [];
  const versions: string[] = [];
  for (const document of documents) {
    const result = await validateDocument(document, schemas);
    diagnostics.push(...result.diagnostics); versions.push(...result.schemaVersions);
  }
  const entities: EntityLocation[] = []; const refs: EntityLocation[] = [];
  for (const document of documents) if (document.data) walk(document.data, document.source, '', entities, refs);
  const index = new Map<string, EntityLocation>();
  for (const entity of entities) {
    const id = String(entity.value.id);
    if (index.has(id)) diagnostics.push({ layer: 'references', source: entity.source, entityId: id, jsonPointer: `${entity.pointer}/id`, code: 'OLS_ID_DUPLICATE', message: `Duplicate ID ${id}.`, severity: 'error' });
    else index.set(id, entity);

    if (/[A-Z]/.test(id)) {
      diagnostics.push({
        layer: 'consistency',
        source: entity.source,
        entityId: id,
        jsonPointer: `${entity.pointer}/id`,
        code: 'OLS_ID_UPPERCASE',
        message: 'IDs should be lowercase for compatibility and consistency.',
        severity: 'warning'
      });
    }
  }
  const absoluteRoot = resolve(root);
  const manifest = documents.find((d) => d.data?.type === 'manifest')?.data;
  const packageName = manifest ? String(manifest.package ?? '') : undefined;
  const dependencies = manifest?.dependencies as string[] ?? [];
  const isDeclaredDependency = (name: string) => dependencies.some((item) => item.split('@', 1)[0] === name);
  const dependencyPackages = manifest ? await loadDependencies(absoluteRoot, manifest as Record<string, unknown>, documents, options.resolver ?? filesystemResolver, diagnostics) : new Map<string, LoadedDependency>();
  const aliases = stringRecord(manifest?.aliases);
  const manifestSourcePath = normalizePath(resolve(absoluteRoot, 'manifest.ols.json'));
  for (const [former, current] of Object.entries(aliases)) {
    if (index.has(former)) diagnostics.push({ layer: 'references', source: manifestSourcePath, jsonPointer: `/aliases/${pointerToken(former)}`, code: 'OLS_ALIAS_SHADOWED', message: `Alias ${former} is also the ID of an entity, so the alias never applies.`, severity: 'error' });
    if (!index.has(current)) diagnostics.push({ layer: 'references', source: manifestSourcePath, jsonPointer: `/aliases/${pointerToken(former)}`, code: 'OLS_ALIAS_TARGET_UNRESOLVED', message: `Alias ${former} points to ${current}, which does not exist.`, severity: 'error' });
  }
  const renamed = (site: ReferenceSite, from: string, to: string) => diagnostics.push({ layer: 'references', source: site.source, jsonPointer: site.pointer, code: 'OLS_ID_RENAMED', message: `${from} was renamed; reference ${to} instead.`, severity: 'warning' });
  const sites = referenceSites(entities, refs);
  for (const site of sites) {
    const { value } = site;
    if (resolveReference(value, index, absoluteRoot, site.source, packageName)) continue;
    const qualified = packageQualifier(value);
    const localId = qualified ? (qualified.package === packageName ? qualified.local : undefined) : value;
    if (localId !== undefined && aliases[localId] !== undefined && index.has(aliases[localId]!)) { renamed(site, value, aliases[localId]!); continue; }
    if (manifest && qualified && qualified.package !== packageName) {
      const dependency = dependencyPackages.get(qualified.package);
      if (dependency) {
        if (dependency.index.has(qualified.local)) continue;
        const target = dependency.aliases[qualified.local];
        if (target !== undefined && dependency.index.has(target)) { renamed(site, value, `${qualified.package}:${target}`); continue; }
        diagnostics.push({ layer: 'references', source: site.source, jsonPointer: site.pointer, code: 'OLS_REF_UNRESOLVED', message: `${qualified.local} is not defined by dependency ${qualified.package}@${dependency.version}.`, severity: 'error' });
        continue;
      }
      // Undeclared packages are reported as OLS_DEPENDENCY_UNDECLARED below.
      if (isDeclaredDependency(qualified.package)) diagnostics.push({ layer: 'references', source: site.source, jsonPointer: site.pointer, code: 'OLS_REF_EXTERNAL', message: `Reference ${value} targets dependency ${qualified.package} and was not resolved locally.`, severity: 'info' });
      continue;
    }
    diagnostics.push({ layer: 'references', source: site.source, jsonPointer: site.pointer, code: value.includes('..') ? 'OLS_REF_PATH_ESCAPE' : 'OLS_REF_UNRESOLVED', message: `Reference ${value} could not be resolved.`, severity: 'error' });
  }
  const ordos = new Map(entities.filter((e) => e.value.type === 'ordo').map((e) => [String(e.value.id), e.value]));
  for (const proper of entities.filter((e) => e.value.type === 'proper')) {
    for (const ordoId of (proper.value.ordos as string[] ?? [])) {
      const ordo = ordos.get(ordoId); const slots = new Set(ordo?.properSlots as string[] ?? []);
      if (!ordo) continue;
      for (const slot of Object.keys(proper.value.fills as Record<string, unknown> ?? {})) if (!slots.has(slot)) diagnostics.push({ layer: 'semantic', source: proper.source, entityId: String(proper.value.id), jsonPointer: `${proper.pointer}/fills/${slot}`, code: 'OLS_PROPER_SLOT_UNKNOWN', message: `Ordo ${ordoId} does not declare slot ${slot}.`, severity: 'error' });
    }
  }
  if (!manifest) diagnostics.push({ layer: 'consistency', source: normalizePath(resolve(root, 'manifest.ols.json')), jsonPointer: '', code: 'OLS_MANIFEST_MISSING', message: 'Package is missing manifest.ols.json.', severity: 'error' });
  else {
    for (const site of sites) {
      const { value } = site;
      const qualified = packageQualifier(value);
      if (qualified && !index.has(value)) {
        const dependency = qualified.package;
        if (dependency !== packageName && !isDeclaredDependency(dependency)) diagnostics.push({ layer: 'references', source: site.source, jsonPointer: site.pointer, code: 'OLS_DEPENDENCY_UNDECLARED', message: `Reference uses undeclared dependency ${dependency}.`, severity: 'error' });
      }
    }
    const packageAuthority = manifest.authority as Record<string, unknown> | undefined;
    const packageAllowed = new Set(packageAuthority?.allowedUse as string[] ?? []);
    const packageRestricted = new Set(packageAuthority?.restrictedUse as string[] ?? []);
    const packageLicense = typeof manifest.license === 'string' ? manifest.license : undefined;
    const allowedLicenses = new Set(manifest.allowedLicenseOverrides as string[] ?? []);
    for (const entity of entities) {
      const authority = entity.value.authority as Record<string, unknown> | undefined;
      const allowed = authority?.allowedUse as string[] | undefined;
      const restricted = authority?.restrictedUse as string[] | undefined;
      if (packageAllowed.size && allowed?.some((use) => !packageAllowed.has(use))) diagnostics.push({ layer: 'semantic', source: entity.source, entityId: String(entity.value.id), jsonPointer: `${entity.pointer}/authority/allowedUse`, code: 'OLS_AUTHORITY_BROADENED', message: 'Entity allowedUse broadens the package authority.', severity: 'error' });
      if (packageRestricted.size && restricted && [...packageRestricted].some((use) => !restricted.includes(use))) diagnostics.push({ layer: 'semantic', source: entity.source, entityId: String(entity.value.id), jsonPointer: `${entity.pointer}/authority/restrictedUse`, code: 'OLS_AUTHORITY_BROADENED', message: 'Entity restrictedUse removes a package restriction.', severity: 'error' });
      const license = entity.value.license;
      if (packageLicense && typeof license === 'string' && license !== packageLicense && !allowedLicenses.has(license)) diagnostics.push({ layer: 'semantic', source: entity.source, entityId: String(entity.value.id), jsonPointer: `${entity.pointer}/license`, code: 'OLS_LICENSE_BROADENED', message: `License override ${license} is not permitted by the manifest.`, severity: 'error' });
    }

    const manifestFiles = manifestFileEntries(manifest.files);
    const absoluteManifestFiles = new Set(manifestFiles.map((entry) => normalizePath(resolve(root, entry.path))));
    const manifestSource = normalizePath(resolve(root, 'manifest.ols.json'));

    manifestFiles.forEach((entry, i) => {
      const absPath = normalizePath(resolve(root, entry.path));
      if (!documents.some(d => d.source === absPath)) {
        diagnostics.push({
          layer: 'consistency',
          source: manifestSource,
          jsonPointer: `/files/${i}`,
          code: 'OLS_MANIFEST_FILE_NOT_FOUND',
          message: `Declared file ${entry.path} does not exist in the package.`,
          severity: 'error'
        });
      }
    });

    for (const document of documents) {
      if (document.source === manifestSource) continue;
      if (!absoluteManifestFiles.has(document.source)) {
        diagnostics.push({
          layer: 'consistency',
          source: document.source,
          jsonPointer: '',
          code: 'OLS_MANIFEST_FILE_UNDECLARED',
          message: 'File is not declared in the manifest.ols.json files list.',
          severity: 'error'
        });
      }
    }
  }
  diagnostics.push(...await overlayDiagnostics(documents, dependencyPackages));
  diagnostics.push(...await integrityDiagnostics(root, documents, entities, false));
  diagnostics.push(...trustDiagnostics(root, documents, entities, options.keyring, false));
  const graph = new Map<string, string[]>();
  for (const entity of entities) {
    const nested = [...walk(entity.value, entity.source).refs.map((item) => String(item.value.$ref)), ...referenceSites([entity], []).map((site) => site.value)].map((value) => resolveReference(value, index, absoluteRoot, entity.source, packageName)).filter((item): item is EntityLocation => item !== undefined).map((item) => String(item.value.id));
    graph.set(String(entity.value.id), nested);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { const item = index.get(id)!; diagnostics.push({ layer: 'references', source: item.source, entityId: id, jsonPointer: item.pointer, code: 'OLS_REF_CYCLE', message: `Reference cycle includes ${id}.`, severity: 'error' }); return; }
    if (visited.has(id)) return;
    visiting.add(id); for (const target of graph.get(id) ?? []) visit(target); visiting.delete(id); visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  const setStateKeys = new Set<string>();
  for (const entity of entities.filter((item) => item.value.type === 'rubric')) for (const key of Object.keys((entity.value.stateTransition as Record<string, Record<string, unknown>> | undefined)?.sets ?? {})) setStateKeys.add(key);
  for (const entity of entities.filter((item) => item.value.type === 'rubric')) for (const key of Object.keys((entity.value.stateTransition as Record<string, Record<string, unknown>> | undefined)?.requires ?? {})) if (!setStateKeys.has(key)) diagnostics.push({ layer: 'semantic', source: entity.source, entityId: String(entity.value.id), jsonPointer: `${entity.pointer}/stateTransition/requires/${key}`, code: 'OLS_RUBRIC_STATE_UNREACHABLE', message: `No rubric establishes required state ${key}.`, severity: 'error' });
  for (const entity of entities.filter((item) => item.value.type === 'proper')) {
    for (const mutation of entity.value.mutations as Array<Record<string, unknown>> ?? []) if (typeof mutation.target === 'string' && !index.has(mutation.target)) diagnostics.push({ layer: 'semantic', source: entity.source, entityId: String(entity.value.id), jsonPointer: entity.pointer, code: 'OLS_MUTATION_TARGET_UNRESOLVED', message: `Mutation target ${mutation.target} does not resolve.`, severity: 'error' });
  }
  const propers = entities.filter((item) => item.value.type === 'proper');
  for (let left = 0; left < propers.length; left++) for (let right = left + 1; right < propers.length; right++) {
    const a = propers[left]!.value; const b = propers[right]!.value;
    const overlap = Object.keys(a.fills as object ?? {}).some((slot) => slot in (b.fills as object ?? {}));
    if (overlap && a.priority === b.priority && a.priorityClass === b.priorityClass) diagnostics.push({ layer: 'semantic', source: propers[right]!.source, entityId: String(b.id), jsonPointer: propers[right]!.pointer, code: 'OLS_CALENDAR_DETERMINISM_UNPROVEN', message: `Proper ${a.id} ties with ${b.id}; an explicit conflict rule or fixture is required.`, severity: 'warning' });
  }
  return report(diagnostics, documents.map((item) => item.source), versions);
}

/**
 * Integrity checks shared by `validatePackage` (strict = false: verify the digests that are
 * declared) and `verifyPackage` (strict = true: additionally require every document and the
 * package itself to be pinned).
 */
async function integrityDiagnostics(root: string, documents: LoadedDocument[], entities: EntityLocation[], strict: boolean): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const absoluteRoot = resolve(root);
  const manifestSource = normalizePath(resolve(absoluteRoot, 'manifest.ols.json'));
  const manifest = documents.find((d) => d.source === manifestSource)?.data as Record<string, unknown> | undefined;
  if (!manifest) return diagnostics;
  const entries = manifestFileEntries(manifest.files);
  const pinned = new Set<string>();
  entries.forEach((entry, i) => {
    const source = normalizePath(resolve(absoluteRoot, entry.path));
    const document = documents.find((d) => d.source === source);
    if (!entry.digest || !document || document.raw === null) return;
    pinned.add(source);
    const actual = canonicalDigest(document.raw);
    if (actual !== entry.digest) diagnostics.push({ layer: 'consistency', source: manifestSource, jsonPointer: `/files/${i}/digest`, code: 'OLS_FILE_DIGEST_MISMATCH', message: `${entry.path} has digest ${actual}, but the manifest declares ${entry.digest}.`, severity: 'error' });
  });
  if (typeof manifest.digest === 'string') {
    const actual = packageDigest(manifest);
    if (actual !== manifest.digest) diagnostics.push({ layer: 'consistency', source: manifestSource, jsonPointer: '/digest', code: 'OLS_PACKAGE_DIGEST_MISMATCH', message: `The package digest is ${actual}, but the manifest declares ${manifest.digest}.`, severity: 'error' });
  } else if (strict) {
    diagnostics.push({ layer: 'consistency', source: manifestSource, jsonPointer: '', code: 'OLS_PACKAGE_DIGEST_MISSING', message: 'The manifest does not declare a package digest; run `ols pack`.', severity: 'error' });
  }
  if (strict) {
    for (const document of documents) {
      if (document.source === manifestSource || pinned.has(document.source)) continue;
      diagnostics.push({ layer: 'consistency', source: document.source, jsonPointer: '', code: 'OLS_FILE_UNPINNED', message: 'The manifest does not declare a digest for this file; run `ols pack`.', severity: 'error' });
    }
  }
  for (const entity of entities) {
    if (entity.value.type !== 'asset' || typeof entity.value.uri !== 'string' || !isPackageRelativeUri(entity.value.uri)) continue;
    const uri = entity.value.uri.split(/[?#]/, 1)[0]!;
    const target = resolve(absoluteRoot, decodeURI(uri));
    const rel = relative(absoluteRoot, target);
    const entityId = String(entity.value.id);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      diagnostics.push({ layer: 'references', source: entity.source, entityId, jsonPointer: `${entity.pointer}/uri`, code: 'OLS_REF_PATH_ESCAPE', message: `Asset URI ${entity.value.uri} resolves outside the package root.`, severity: 'error' });
      continue;
    }
    let bytes: Buffer;
    try { if (!(await stat(target)).isFile()) throw new Error('not a file'); bytes = await readFile(target); }
    catch {
      diagnostics.push({ layer: 'references', source: entity.source, entityId, jsonPointer: `${entity.pointer}/uri`, code: 'OLS_ASSET_NOT_FOUND', message: `Asset file ${entity.value.uri} is not in the package.`, severity: 'warning' });
      continue;
    }
    if (typeof entity.value.byteSize === 'number' && entity.value.byteSize !== bytes.length) diagnostics.push({ layer: 'consistency', source: entity.source, entityId, jsonPointer: `${entity.pointer}/byteSize`, code: 'OLS_ASSET_SIZE_MISMATCH', message: `Asset file is ${bytes.length} bytes, but byteSize declares ${entity.value.byteSize}.`, severity: 'error' });
    if (typeof entity.value.digest === 'string') {
      const actual = bytesDigest(bytes);
      if (actual !== entity.value.digest) diagnostics.push({ layer: 'consistency', source: entity.source, entityId, jsonPointer: `${entity.pointer}/digest`, code: 'OLS_ASSET_DIGEST_MISMATCH', message: `Asset file has digest ${actual}, but the record declares ${entity.value.digest}.`, severity: 'error' });
    } else if (strict) {
      diagnostics.push({ layer: 'consistency', source: entity.source, entityId, jsonPointer: entity.pointer, code: 'OLS_ASSET_UNPINNED', message: 'Package-local asset has no digest.', severity: 'error' });
    }
  }
  return diagnostics;
}

const asSignatures = (value: unknown): SignatureEntry[] => (Array.isArray(value) ? value as SignatureEntry[] : []);

/**
 * Signature and approval checks shared by `validatePackage` and `verifyPackage` (strict: with a
 * keyring, the package must carry a trusted signature and every approval must be attested).
 */
function trustDiagnostics(root: string, documents: LoadedDocument[], entities: EntityLocation[], keyring: Keyring | undefined, strict: boolean): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const absoluteRoot = resolve(root);
  const manifestSource = normalizePath(resolve(absoluteRoot, 'manifest.ols.json'));
  const manifest = documents.find((d) => d.source === manifestSource)?.data as Record<string, unknown> | undefined;
  if (manifest) {
    const message = packageSignatureMessage(packageDigest(manifest));
    let trusted = false;
    asSignatures(manifest.signatures).forEach((entry, i) => {
      if (!verifySignature(message, entry)) {
        diagnostics.push({ layer: 'semantic', source: manifestSource, jsonPointer: `/signatures/${i}`, code: 'OLS_SIGNATURE_INVALID', message: 'Package signature does not match the package content or key.', severity: 'error' });
      } else if (keyring && !trustedKey(keyring, entry.key)) {
        diagnostics.push({ layer: 'semantic', source: manifestSource, jsonPointer: `/signatures/${i}`, code: 'OLS_SIGNATURE_UNTRUSTED', message: `Package is signed by ${entry.key}, which is not in the keyring.`, severity: 'info' });
      } else if (keyring) trusted = true;
    });
    if (strict && keyring && !trusted) diagnostics.push({ layer: 'semantic', source: manifestSource, jsonPointer: '', code: 'OLS_PACKAGE_UNSIGNED', message: 'The package has no valid signature from a trusted key.', severity: 'error' });
  }
  const index = new Map<string, EntityLocation>();
  for (const entity of entities) if (!index.has(String(entity.value.id))) index.set(String(entity.value.id), entity);
  // Entities covered by an approval in effect, per status.
  const covered: Array<{ status: string; entity: EntityLocation }> = [];
  for (const document of documents) {
    const approval = document.data as Record<string, unknown> | undefined;
    if (approval?.type !== 'approval') continue;
    const status = String(approval.status);
    let attested = !keyring;
    const message = approvalSignatureMessage(approval);
    asSignatures(approval.signatures).forEach((entry, i) => {
      if (!verifySignature(message, entry)) {
        diagnostics.push({ layer: 'semantic', source: document.source, entityId: String(approval.id), jsonPointer: `/signatures/${i}`, code: 'OLS_SIGNATURE_INVALID', message: 'Approval signature does not match the approval or key.', severity: 'error' });
        return;
      }
      if (!keyring) return;
      const key = trustedKey(keyring, entry.key);
      if (key && (!key.approves || key.approves.includes(status))) attested = true;
      else diagnostics.push({ layer: 'semantic', source: document.source, entityId: String(approval.id), jsonPointer: `/signatures/${i}`, code: 'OLS_SIGNATURE_UNTRUSTED', message: key ? `Key ${entry.key} is trusted, but not to attest ${status}.` : `Approval is signed by ${entry.key}, which is not in the keyring.`, severity: 'info' });
    });
    if (!attested) diagnostics.push({ layer: 'semantic', source: document.source, entityId: String(approval.id), jsonPointer: '', code: 'OLS_APPROVAL_UNTRUSTED', message: `Approval ${String(approval.id)} has no valid signature from a key trusted to attest ${status}.`, severity: strict ? 'error' : 'warning' });
    (Array.isArray(approval.subjects) ? approval.subjects as Array<Record<string, unknown>> : []).forEach((subject, i) => {
      const entity = index.get(String(subject.entity));
      if (!entity) {
        diagnostics.push({ layer: 'semantic', source: document.source, entityId: String(approval.id), jsonPointer: `/subjects/${i}/entity`, code: 'OLS_APPROVAL_SUBJECT_UNRESOLVED', message: `Approved entity ${String(subject.entity)} is not in the package.`, severity: 'error' });
        return;
      }
      const actual = canonicalDigest(entity.value);
      if (actual !== subject.digest) {
        diagnostics.push({ layer: 'semantic', source: document.source, entityId: String(approval.id), jsonPointer: `/subjects/${i}/digest`, code: 'OLS_APPROVAL_STALE', message: `${String(subject.entity)} changed after it was approved (now ${actual}); the approval no longer applies to it.`, severity: 'error' });
        return;
      }
      if (attested) covered.push({ status, entity });
    });
  }
  for (const entity of entities) {
    const status = (entity.value.authority as Record<string, unknown> | undefined)?.status;
    if (typeof status !== 'string' || !(ATTESTED_STATUSES as readonly string[]).includes(status)) continue;
    const isCovered = covered.some((item) => item.status === status && item.entity.source === entity.source && (entity.pointer === item.entity.pointer || entity.pointer.startsWith(`${item.entity.pointer}/`)));
    if (!isCovered) diagnostics.push({ layer: 'semantic', source: entity.source, entityId: String(entity.value.id), jsonPointer: `${entity.pointer}/authority/status`, code: 'OLS_AUTHORITY_UNATTESTED', message: `${String(entity.value.id)} claims ${status}, but no approval in effect covers its current content.`, severity: 'warning' });
  }
  return diagnostics;
}

/** Integrity-only verification: every document, package-local asset, and the package itself must be pinned and match. */
export async function verifyPackage(root: string, options: { keyring?: Keyring } = {}): Promise<ValidationReport> {
  const documents = await loadPackage(root);
  const entities: EntityLocation[] = [];
  for (const document of documents) if (document.data) walk(document.data, document.source, '', entities, []);
  const diagnostics = await integrityDiagnostics(root, documents, entities, true);
  diagnostics.push(...trustDiagnostics(root, documents, entities, options.keyring, true));
  if (!documents.some((d) => d.data?.type === 'manifest')) diagnostics.push({ layer: 'consistency', source: normalizePath(resolve(root, 'manifest.ols.json')), jsonPointer: '', code: 'OLS_MANIFEST_MISSING', message: 'Package is missing manifest.ols.json.', severity: 'error' });
  return report(diagnostics, documents.map((item) => item.source), []);
}

/**
 * Pins every package document in the manifest: `files` becomes `{ path, digest }` entries for all
 * documents (sorted by path, keeping any declared `mediaType`) and `digest` is recomputed.
 * Returns the new manifest; writes it to `manifest.ols.json` unless `write` is false.
 */
export async function packPackage(root: string, options: { write?: boolean } = {}): Promise<Record<string, unknown>> {
  const absoluteRoot = resolve(root);
  const manifestPath = resolve(absoluteRoot, 'manifest.ols.json');
  const documents = await loadPackage(absoluteRoot);
  const manifestDocument = documents.find((d) => d.source === normalizePath(manifestPath));
  if (!manifestDocument?.raw || typeof manifestDocument.raw !== 'object' || Array.isArray(manifestDocument.raw)) throw new Error('Package is missing a readable manifest.ols.json.');
  const manifest = { ...(manifestDocument.raw as Record<string, unknown>) };
  const previous = new Map(manifestFileEntries(manifest.files).map((entry) => [entry.path, entry]));
  const files = documents
    .filter((d) => d !== manifestDocument)
    .map((d) => {
      if (d.raw === null) throw new Error(`${d.source} is not valid JSON.`);
      const path = normalizePath(relative(absoluteRoot, d.source));
      const mediaType = previous.get(path)?.mediaType;
      return { path, digest: canonicalDigest(d.raw), ...(mediaType ? { mediaType } : {}) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  manifest.files = files;
  const previousDigest = manifest.digest;
  delete manifest.digest;
  manifest.digest = packageDigest(manifest);
  // Signatures cover the previous digest; once the content changes they can only be invalid.
  if (previousDigest !== manifest.digest) delete manifest.signatures;
  if (options.write !== false) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Writes `ols.lock.json`, pinning every declared dependency found under `packagesDirectory`
 * (default `ols_packages/<name>`) to its version and package digest. Each dependency must already
 * be packed and pass `verifyPackage`. Adds the lockfile to `manifest.files` when that list exists.
 */
export async function lockPackage(root: string, options: { packagesDirectory?: string; write?: boolean } = {}): Promise<{ lock: Record<string, unknown>; manifestUpdated: boolean }> {
  const absoluteRoot = resolve(root);
  const packagesDirectory = normalizePath(options.packagesDirectory ?? DEFAULT_PACKAGES_DIRECTORY);
  const manifestPath = resolve(absoluteRoot, 'manifest.ols.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const packages: Record<string, LockEntry> = {};
  for (const spec of (Array.isArray(manifest.dependencies) ? manifest.dependencies : []) as string[]) {
    const { name, range } = parseDependency(spec);
    const resolved = `${packagesDirectory}/${name}`;
    const directory = resolve(absoluteRoot, resolved);
    let dependency: Record<string, unknown>;
    try { dependency = JSON.parse(await readFile(resolve(directory, 'manifest.ols.json'), 'utf8')); }
    catch { throw new Error(`Dependency ${name} was not found at ${resolved}.`); }
    if (dependency.package !== name) throw new Error(`The package at ${resolved} is ${String(dependency.package)}, not ${name}.`);
    if (!versionSatisfies(String(dependency.version), range)) throw new Error(`${name} ${String(dependency.version)} does not satisfy ${spec}.`);
    const verification = await verifyPackage(directory);
    if (!verification.valid) throw new Error(`Dependency ${name} does not verify; run \`ols pack\` in it (${[...new Set(verification.diagnostics.map((d) => d.code))].join(', ')}).`);
    packages[name] = { version: String(dependency.version), digest: String(dependency.digest), resolved };
  }
  const lock = {
    $schema: 'https://ols.otyg.org/schema/v1.0/lock.schema.json',
    ols_version: typeof manifest.ols_version === 'string' ? manifest.ols_version : '1.1.0',
    type: 'lock',
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  let manifestUpdated = false;
  if (Array.isArray(manifest.files) && !manifestFileEntries(manifest.files).some((entry) => entry.path === LOCKFILE_NAME)) {
    manifest.files = [...manifest.files, LOCKFILE_NAME];
    manifestUpdated = true;
  }
  if (options.write !== false) {
    await writeFile(resolve(absoluteRoot, LOCKFILE_NAME), `${JSON.stringify(lock, null, 2)}\n`);
    if (manifestUpdated) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { lock, manifestUpdated };
}

/** Signs a packed package: adds (or replaces) this key's signature over the package digest in `manifest.signatures`. */
export async function signPackage(root: string, privateKeyPem: string, options: { signer?: string } = {}): Promise<SignatureEntry> {
  const manifestPath = resolve(root, 'manifest.ols.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const verification = await verifyPackage(root);
  if (typeof manifest.digest !== 'string' || !verification.valid) throw new Error(`Run \`ols pack\` before signing; the package does not verify (${[...new Set(verification.diagnostics.map((d) => d.code))].join(', ')}).`);
  const entry: SignatureEntry = { ...signMessage(packageSignatureMessage(manifest.digest), privateKeyPem), ...(options.signer ? { signer: options.signer } : {}) };
  manifest.signatures = [...asSignatures(manifest.signatures).filter((item) => item.key !== entry.key), entry];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return entry;
}

/** Signs an approval document in place, adding (or replacing) this key's signature. Re-run `ols pack` afterwards. */
export async function signApproval(path: string, privateKeyPem: string, options: { signer?: string } = {}): Promise<SignatureEntry> {
  const approval = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (approval.type !== 'approval') throw new Error(`${path} is not an approval document.`);
  const entry: SignatureEntry = { ...signMessage(approvalSignatureMessage(approval), privateKeyPem), ...(options.signer ? { signer: options.signer } : {}) };
  approval.signatures = [...asSignatures(approval.signatures).filter((item) => item.key !== entry.key), entry];
  await writeFile(path, `${JSON.stringify(approval, null, 2)}\n`);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Change exchange: diff, overlays, merge, migrate
// ---------------------------------------------------------------------------------------------

/** Manifest members recomputed by `ols pack`; they are ignored when comparing packages. */
const DERIVED_MANIFEST_KEYS = ['digest', 'files', 'signatures'];
const MANIFEST_FILE = 'manifest.ols.json';
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Package documents keyed by package-relative path (POSIX separators), as parsed JSON. */
export async function packageDocuments(root: string): Promise<Map<string, unknown>> {
  const absoluteRoot = resolve(root);
  const documents = new Map<string, unknown>();
  for (const document of await loadPackage(absoluteRoot)) {
    if (document.raw === null) throw new Error(`${document.source} is not valid JSON.`);
    documents.set(normalizePath(relative(absoluteRoot, document.source)), document.raw);
  }
  return documents;
}

function comparable(path: string, document: unknown): unknown {
  if (path !== MANIFEST_FILE || !document || typeof document !== 'object' || Array.isArray(document)) return document;
  return Object.fromEntries(Object.entries(document).filter(([key]) => !DERIVED_MANIFEST_KEYS.includes(key)));
}

/**
 * Entity-level change set that turns `base` into `other`. Changes are addressed to the innermost
 * entity by ID; derived manifest members (`digest`, `files`, `signatures`) are ignored.
 */
export async function diffPackages(base: string, other: string): Promise<ChangeOperation[]> {
  const before = await packageDocuments(base);
  const after = await packageDocuments(other);
  const operations: ChangeOperation[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(byCodeUnit)) {
    if (!after.has(path)) operations.push({ op: 'remove', document: path, path: '' });
    else if (!before.has(path)) operations.push({ op: 'add', document: path, path: '', value: comparable(path, after.get(path)) });
    else {
      const a = comparable(path, before.get(path));
      operations.push(...targetOperations(path, a, diffValues(a, comparable(path, after.get(path)))));
    }
  }
  return operations;
}

/** An overlay document carrying `diffPackages(base, other)`, pinned to the base package's version and digest. */
export async function createOverlay(base: string, other: string, id: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(resolve(base, MANIFEST_FILE), 'utf8')) as Record<string, unknown>;
  return {
    $schema: 'https://ols.otyg.org/schema/v1.0/overlay.schema.json',
    ols_version: typeof manifest.ols_version === 'string' ? manifest.ols_version : '1.1.0',
    type: 'overlay',
    id,
    base: { package: String(manifest.package), version: String(manifest.version), digest: packageDigest(manifest) },
    operations: await diffPackages(base, other),
  };
}

async function writeDocuments(outDir: string, documents: Map<string, unknown>, previous: Iterable<string>): Promise<void> {
  for (const path of previous) if (!documents.has(path)) await rm(resolve(outDir, path), { force: true });
  for (const [path, document] of documents) {
    const target = resolve(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
  }
}

async function assertEmptyOutput(outDir: string): Promise<void> {
  try { if ((await readdir(outDir)).length) throw new Error(`Output directory ${outDir} is not empty.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/**
 * Applies an overlay to its base package and writes the result to `outDir` (which must be empty or
 * absent), then packs it. The base must match the overlay's pinned package, version, and digest.
 */
export async function applyOverlay(overlay: Record<string, unknown>, base: string, outDir: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(resolve(base, MANIFEST_FILE), 'utf8')) as Record<string, unknown>;
  const pinned = (overlay.base ?? {}) as Record<string, unknown>;
  const digest = packageDigest(manifest);
  if (pinned.package !== manifest.package || pinned.version !== manifest.version || pinned.digest !== digest) {
    throw new Error(`The overlay was made for ${String(pinned.package)}@${String(pinned.version)} (${String(pinned.digest)}), but the base is ${String(manifest.package)}@${String(manifest.version)} (${digest}).`);
  }
  const documents = await packageDocuments(base);
  const before = [...documents.keys()];
  applyChanges(documents, (overlay.operations ?? []) as ChangeOperation[]);
  await assertEmptyOutput(outDir);
  await cp(resolve(base), resolve(outDir), { recursive: true });
  await writeDocuments(resolve(outDir), documents, before);
  return packPackage(outDir);
}

/** Every non-JSON file of a package (assets), keyed by package-relative path; `tests/` and dependencies are excluded. */
async function packageAssets(root: string, directory = resolve(root), found = new Map<string, Buffer>()): Promise<Map<string, Buffer>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'tests' && entry.name !== DEFAULT_PACKAGES_DIRECTORY) await packageAssets(root, path, found); }
    else if (entry.isFile() && !entry.name.endsWith('.json')) found.set(normalizePath(relative(resolve(root), path)), await readFile(path));
  }
  return found;
}

export type MergeResult = { merged: boolean; conflicts: MergeConflict[]; manifest?: Record<string, unknown> };

/**
 * Three-way merge of two packages derived from `base`. Both are diffed against the base at entity
 * level; non-overlapping changes are combined, and assets merge file by file. With no conflicts
 * the result is written to `outDir` (empty or absent) and packed; otherwise nothing is written.
 */
export async function mergePackages(base: string, ours: string, theirs: string, outDir: string): Promise<MergeResult> {
  const { operations, conflicts } = combineChanges(await diffPackages(base, ours), await diffPackages(base, theirs));
  const [baseAssets, ourAssets, theirAssets] = await Promise.all([packageAssets(base), packageAssets(ours), packageAssets(theirs)]);
  const assets = new Map<string, Buffer | undefined>();
  for (const path of [...new Set([...ourAssets.keys(), ...theirAssets.keys()])].sort(byCodeUnit)) {
    const [original, mine, other] = [baseAssets.get(path), ourAssets.get(path), theirAssets.get(path)];
    const same = (a?: Buffer, b?: Buffer) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));
    if (same(mine, other) || same(other, original)) assets.set(path, mine);
    else if (same(mine, original)) assets.set(path, other);
    else conflicts.push({ file: path });
  }
  if (conflicts.length) return { merged: false, conflicts };
  const documents = await packageDocuments(base);
  applyChanges(documents, operations);
  await assertEmptyOutput(outDir);
  await cp(resolve(ours), resolve(outDir), { recursive: true });
  await writeDocuments(resolve(outDir), documents, (await packageDocuments(ours)).keys());
  for (const [path, bytes] of assets) {
    const target = resolve(outDir, path);
    if (bytes === undefined) await rm(target, { force: true });
    else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
  }
  return { merged: true, conflicts: [], manifest: await packPackage(outDir) };
}

/** Overlays in a package must apply cleanly to the locked dependency they are pinned to. */
async function overlayDiagnostics(documents: LoadedDocument[], dependencies: Map<string, LoadedDependency>): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const document of documents) {
    const overlay = document.data as Record<string, unknown> | undefined;
    if (overlay?.type !== 'overlay') continue;
    const base = (overlay.base ?? {}) as Record<string, unknown>;
    const push = (jsonPointer: string, code: string, message: string) => diagnostics.push({ layer: 'semantic', source: document.source, entityId: String(overlay.id), jsonPointer, code, message, severity: 'error' });
    const dependency = dependencies.get(String(base.package));
    if (!dependency) { push('/base/package', 'OLS_OVERLAY_BASE_UNRESOLVED', `Overlay base ${String(base.package)} is not a locked dependency of this package.`); continue; }
    if (base.version !== dependency.version) push('/base/version', 'OLS_OVERLAY_BASE_MISMATCH', `Overlay was made for ${dependency.name}@${String(base.version)}, but ${dependency.version} is locked.`);
    if (base.digest !== dependency.digest) { push('/base/digest', 'OLS_OVERLAY_BASE_MISMATCH', `Overlay was made for package digest ${String(base.digest)}, but the locked dependency is ${dependency.digest}.`); continue; }
    try { applyChanges(await packageDocuments(dependency.root), (overlay.operations ?? []) as ChangeOperation[]); }
    catch (error) {
      if (!(error instanceof ChangeError)) throw error;
      push(error.index === undefined ? '/operations' : `/operations/${error.index}`, 'OLS_OVERLAY_CONFLICT', error.message);
    }
  }
  return diagnostics;
}

export type MigrationChange = { source: string; pointer: string; rule: string };

/** Corpus collections and the entity type of their members. */
const CORPUS_COLLECTIONS: Record<string, string> = {
  assets: 'asset', blocks: 'block', calendars: 'calendar', ordos: 'ordo', propers: 'proper', readings: 'reading',
  roles: 'role', rubrics: 'rubric', sections: 'section', teachingNotes: 'teaching-note',
};

function migrateDocument(document: Record<string, unknown>, source: string, changes: MigrationChange[]): void {
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const record = (pointer: string, rule: string) => changes.push({ source, pointer, rule });
  const fixType = (value: Record<string, unknown>, expected: string, pointer: string) => {
    if (typeof value.type !== 'string' || value.type === expected) return;
    if (value.kind === undefined) value.kind = value.type;
    value.type = expected;
    record(pointer, 'type-kind');
  };
  const declared = typeof document.$schema === 'string' ? /\/([a-z-]+)\.schema\.json$/.exec(document.$schema)?.[1] : undefined;
  if (declared) fixType(document, declared, '');
  if (document.type === 'corpus') {
    for (const [key, type] of Object.entries(CORPUS_COLLECTIONS)) {
      const items = document[key];
      if (Array.isArray(items)) items.forEach((item, i) => { if (isObject(item)) fixType(item, type, `/${key}/${i}`); });
    }
  }
  const visit = (value: unknown, pointer: string) => {
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${pointer}/${i}`)); return; }
    if (!isObject(value)) return;
    if (document.type !== 'manifest' && isObject(value.authority) && value.authority.type === undefined) {
      value.authority.type = 'authority';
      record(`${pointer}/authority`, 'authority-type');
    }
    if ((value.type === 'role' || value.type === 'role-group') && value.labels !== undefined && value.label === undefined) {
      value.label = value.labels; delete value.labels;
      record(pointer, 'label-singular');
    }
    if (value.type === 'role-group' && value.members !== undefined && value.roles === undefined) {
      value.roles = value.members; delete value.members;
      record(pointer, 'role-group-roles');
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${pointer}/${escapeToken(key)}`);
  };
  visit(document, '');
  const entities: EntityLocation[] = [];
  walk(document, source, '', entities, []);
  const refObject = (item: unknown): string | undefined => (isObject(item) && Object.keys(item).length === 1 && typeof item.$ref === 'string' ? item.$ref : undefined);
  for (const entity of entities) {
    for (const field of idReferenceFields[entityType(entity)] ?? []) {
      const value = entity.value[field];
      if (Array.isArray(value)) value.forEach((item, i) => {
        const id = refObject(item);
        if (id !== undefined) { value[i] = id; record(`${entity.pointer}/${field}/${i}`, 'id-list-ref-object'); }
      });
      else if (refObject(value) !== undefined) { entity.value[field] = refObject(value); record(`${entity.pointer}/${field}`, 'id-list-ref-object'); }
    }
  }
}

/**
 * Rewrites documents written against pre-1.1 conventions: subtype in `type` (moved to `kind`),
 * untyped `authority` objects, role `labels`, role-group `members`, and `{ "$ref" }` objects in ID
 * lists. Accepts a package directory or a single document. Writes changed documents unless `write` is false.
 */
export async function migratePackage(path: string, options: { write?: boolean } = {}): Promise<MigrationChange[]> {
  const target = resolve(path);
  const isDirectory = (await stat(target)).isDirectory();
  const files = isDirectory ? [...(await packageDocuments(target)).keys()].map((file) => resolve(target, file)) : [target];
  const changes: MigrationChange[] = [];
  for (const file of files) {
    const document = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
    const source = isDirectory ? normalizePath(relative(target, file)) : normalizePath(file).split('/').at(-1)!;
    const count = changes.length;
    migrateDocument(document as Record<string, unknown>, source, changes);
    if (changes.length > count && options.write !== false) await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  }
  return changes.sort((a, b) => byCodeUnit(a.source, b.source) || byCodeUnit(a.pointer, b.pointer) || byCodeUnit(a.rule, b.rule));
}

export async function runSelfTests(root: string): Promise<ValidationReport> {
  const diagnostics: Diagnostic[] = [];
  for (const expectedValid of [true, false]) {
    const folder = resolve(root, 'tests', expectedValid ? 'valid' : 'invalid');
    let files: string[] = [];
    try { files = (await readdir(folder)).filter((name) => name.endsWith('.json') && !name.endsWith('.expected.json')).sort(); } catch { continue; }
    for (const filename of files) {
      const result = await validateDocument(resolve(folder, filename));
      let passed = result.valid === expectedValid;
      if (!expectedValid) {
        try {
          const expectation = JSON.parse(await readFile(resolve(folder, filename.replace(/\.json$/, '.expected.json')), 'utf8'));
          passed &&= result.diagnostics.some((item) => item.layer === expectation.layer && item.code === expectation.code);
        } catch { passed = false; }
      }
      if (!passed) diagnostics.push({ layer: 'semantic', source: normalizePath(resolve(folder, filename)), jsonPointer: '', code: 'OLS_SELF_TEST_FAILED', message: `Fixture did not produce the expected ${expectedValid ? 'valid' : 'invalid'} result.`, severity: 'error' });
    }
  }
  return report(diagnostics, [], ['1.0.0']);
}
