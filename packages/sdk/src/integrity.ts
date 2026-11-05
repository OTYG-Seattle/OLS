import { createHash } from 'node:crypto';

/** Digest strings are `sha256:` followed by 64 lowercase hex characters. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Manifest members that are not covered by the package digest (they are derived from, or sign, it). */
export const PACKAGE_DIGEST_EXCLUDED_KEYS = ['digest', 'signatures'] as const;

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot represent NaN or Infinity.');
  // RFC 8785 uses the ECMAScript Number-to-String algorithm; -0 serializes as 0.
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * OLS canonical JSON: RFC 8785 (JCS) applied after Unicode NFC normalization of every
 * string and member name. Two documents that differ only in whitespace, member order,
 * or Unicode normalization form have the same canonical text and therefore the same digest.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key.normalize('NFC'), item] as const);
    // JavaScript string comparison is UTF-16 code-unit order, as RFC 8785 requires.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < entries.length; i++) {
      if (entries[i]![0] === entries[i - 1]![0]) throw new Error(`Member name "${entries[i]![0]}" is duplicated after NFC normalization.`);
    }
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot represent a value of type ${typeof value}.`);
}

/** `sha256:<hex>` of raw bytes (used for binary assets). */
export function bytesDigest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** `sha256:<hex>` of a JSON value's canonical form (used for OLS documents). */
export function canonicalDigest(value: unknown): string {
  return bytesDigest(Buffer.from(canonicalize(value), 'utf8'));
}

/** Digest of the package: the canonical manifest without `digest` and `signatures`. */
export function packageDigest(manifest: Record<string, unknown>): string {
  const covered = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !(PACKAGE_DIGEST_EXCLUDED_KEYS as readonly string[]).includes(key)),
  );
  return canonicalDigest(covered);
}

export type ManifestFileEntry = { path: string; digest?: string; mediaType?: string };

/** Normalizes `manifest.files`, whose entries may be a bare path or `{ path, digest, mediaType }`. */
export function manifestFileEntries(files: unknown): ManifestFileEntry[] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry): ManifestFileEntry[] => {
    if (typeof entry === 'string') return [{ path: entry }];
    if (entry && typeof entry === 'object' && typeof (entry as ManifestFileEntry).path === 'string') return [entry as ManifestFileEntry];
    return [];
  });
}

/** True when `uri` has no scheme, i.e. it is resolved from the package root. */
export function isPackageRelativeUri(uri: string): boolean {
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) && !uri.startsWith('//');
}
