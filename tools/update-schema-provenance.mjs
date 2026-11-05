// Recomputes packages/schemas/provenance.json digests after a schema edit and syncs the Python copy.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = new URL('../packages/schemas/schemas/v1.0/', import.meta.url);
const provenancePath = new URL('../packages/schemas/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
for (const file of (await readdir(directory)).filter((name) => name.endsWith('.schema.json')).sort()) {
  const digest = createHash('sha256').update(await readFile(new URL(file, directory))).digest('hex');
  provenance[file] ??= {
    source: 'synthesized',
    specification: `https://ols.otyg.org/schema/v1.0/${file}`,
    revision: '1.0.0',
  };
  provenance[file].sha256 = digest;
}
const sorted = Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
await writeFile(provenancePath, `${JSON.stringify(sorted, null, 2)}\n`);
await import('./sync-python-schemas.mjs');
console.log('Updated schema provenance digests.');
