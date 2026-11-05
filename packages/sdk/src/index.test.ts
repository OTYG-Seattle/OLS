import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveReference, validateDocument, validatePackage, validateTranslationVariants } from './index.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

describe('validateDocument', () => {
  it('reports malformed JSON at layer one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ols-'));
    const source = join(directory, 'bad.json');
    await writeFile(source, '{');
    const result = await validateDocument(source);
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('OLS_JSON_PARSE');
  });
});

describe('validateTranslationVariants', () => {
  const run = (value: unknown) => {
    const diagnostics: import('@openliturgy/types').Diagnostic[] = [];
    validateTranslationVariants(value, 'inline', '', diagnostics);
    return diagnostics.map((item) => item.code);
  };

  it('accepts a well-formed variant block', () => {
    const codes = run({
      text: { en: 'Lord, have mercy' },
      variants: { en: [{ value: 'Lord, have mercy', label: 'A', source: 'S', default: true }] },
    });
    expect(codes).toEqual([]);
  });

  it('flags a variant language missing from the text map', () => {
    const codes = run({ text: { en: 'Lord, have mercy' }, variants: { fr: [{ value: 'Seigneur', label: 'F', source: 'S' }] } });
    expect(codes).toContain('OLS_VARIANT_LANG_MISMATCH');
  });

  it('flags multiple defaults in one language', () => {
    const codes = run({
      text: { en: 'Lord, have mercy' },
      variants: { en: [
        { value: 'Lord, have mercy', label: 'A', source: 'S', default: true },
        { value: 'Lord, have mercy', label: 'B', source: 'S', default: true },
      ] },
    });
    expect(codes).toContain('OLS_VARIANT_MULTI_DEFAULT');
  });

  it('flags a default whose value does not match the text entry', () => {
    const codes = run({
      text: { en: 'Lord, have mercy' },
      variants: { en: [{ value: 'O Lord, show mercy', label: 'A', source: 'S', default: true }] },
    });
    expect(codes).toContain('OLS_VARIANT_DEFAULT_SYNC');
  });
});

describe('validatePackage', () => {
  it('reports undeclared files and missing files in manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ols-pkg-'));
    const manifest = {
      $schema: 'https://ols.otyg.org/schema/v1.0/manifest.schema.json',
      ols_version: '1.0.0',
      type: 'manifest',
      package: 'org.openliturgy.test',
      version: '1.0.1',
      title: { en: 'Test package' },
      license: 'Apache-2.0',
      files: ['missing-file.ols.json']
    };
    await writeFile(join(directory, 'manifest.ols.json'), JSON.stringify(manifest));

    const extraFile = {
      $schema: 'https://ols.otyg.org/schema/v1.0/ordo.schema.json',
      ols_version: '1.0.0',
      type: 'ordo',
      id: 'test-ordo',
      sections: ['sec-word']
    };
    await writeFile(join(directory, 'extra.ols.json'), JSON.stringify(extraFile));

    const result = await validatePackage(directory);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some(d => d.code === 'OLS_MANIFEST_FILE_NOT_FOUND')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'OLS_MANIFEST_FILE_UNDECLARED')).toBe(true);
  });

  it('reports warning for uppercase entity IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ols-pkg-'));
    const manifest = {
      $schema: 'https://ols.otyg.org/schema/v1.0/manifest.schema.json',
      ols_version: '1.0.0',
      type: 'manifest',
      package: 'org.openliturgy.test',
      version: '1.0.1',
      title: { en: 'Test package' },
      license: 'Apache-2.0',
      files: ['ordo.ols.json']
    };
    await writeFile(join(directory, 'manifest.ols.json'), JSON.stringify(manifest));

    const ordo = {
      $schema: 'https://ols.otyg.org/schema/v1.0/ordo.schema.json',
      ols_version: '1.0.0',
      type: 'ordo',
      id: 'TEST-ordo-uppercase',
      sections: ['sec-word']
    };
    await writeFile(join(directory, 'ordo.ols.json'), JSON.stringify(ordo));

    const result = await validatePackage(directory);
    expect(result.diagnostics.some(d => d.code === 'OLS_ID_UPPERCASE' && d.severity === 'warning')).toBe(true);
  });

  it('validates a corpus package whose propers carry doc-style mutations', async () => {
    const result = await validatePackage(join(fixtures, 'cross-package'));
    expect(result.diagnostics.some((d) => d.layer === 'structural')).toBe(false);
  });

  it('scopes package-qualified references to their package', async () => {
    const result = await validatePackage(join(fixtures, 'cross-package'));
    const at = (slot: string) => result.diagnostics.filter((d) => d.jsonPointer === `/propers/0/fills/${slot}/$ref`).map((d) => d.code);
    expect(at('own-qualified')).toEqual([]);
    expect(at('own-urn')).toEqual([]);
    expect(at('dependency')).toEqual(['OLS_REF_EXTERNAL']);
    expect(at('undeclared')).toEqual(['OLS_DEPENDENCY_UNDECLARED']);
    expect(at('missing')).toEqual(['OLS_REF_UNRESOLVED']);
  });
});

describe('resolveReference', () => {
  const entity = { value: { id: 'block-kyrie' }, source: 'a.json', pointer: '' };
  const index = new Map([['block-kyrie', entity], ['eotc.kidase.block.kyrie', entity]]);

  it('does not let a local entity shadow another package', () => {
    expect(resolveReference('org.other:block-kyrie', index, undefined, undefined, 'org.local')).toBeUndefined();
    expect(resolveReference('org.local:block-kyrie', index, undefined, undefined, 'org.local')).toBe(entity);
  });

  it('resolves URNs verbatim and via the legacy colon mapping', () => {
    expect(resolveReference('urn:ols:org.local:block-kyrie', index, undefined, undefined, 'org.local')).toBe(entity);
    expect(resolveReference('urn:ols:eotc:kidase:block:kyrie', index)).toBe(entity);
  });
});

describe('language tags and versions', () => {
  it('accepts BCP 47 region and private-use subtags under OLS 1.1', async () => {
    const result = await validateDocument(join(fixtures, 'complete-minimal/tests/valid/utterance-bcp47-region.ols.json'));
    expect(result.valid).toBe(true);
  });
});

describe('documentation examples', () => {
  it('keeps the complete corpus example in the spec schema-valid', async () => {
    const article = await readFile(resolve(fixtures, '../src/content/docs/profiles-examples/example/example.mdx'), 'utf8');
    const json = /```json\n([\s\S]*?)```/.exec(article)?.[1];
    expect(json).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), 'ols-doc-'));
    const source = join(directory, 'example.ols.json');
    await writeFile(source, json!);
    const result = await validateDocument(source);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
