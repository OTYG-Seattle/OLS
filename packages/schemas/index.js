import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const schemaDirectory = join(dirname(fileURLToPath(import.meta.url)), 'schemas', 'v1.0');

export async function listSchemas() {
  return (await readdir(schemaDirectory)).filter((name) => name.endsWith('.schema.json')).sort();
}

export async function loadSchema(name) {
  const filename = name.endsWith('.schema.json') ? name : `${name}.schema.json`;
  return JSON.parse(await readFile(join(schemaDirectory, filename), 'utf8'));
}

/** The OLS JSON-LD context (`@context` document) that maps OLS JSON to linked data. */
export async function loadContext() {
  return JSON.parse(await readFile(join(schemaDirectory, 'context.jsonld'), 'utf8'));
}
