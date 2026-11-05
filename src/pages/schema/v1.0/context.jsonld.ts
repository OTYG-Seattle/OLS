import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function GET() {
  const context = await readFile(resolve(process.cwd(), 'packages', 'schemas', 'schemas', 'v1.0', 'context.jsonld'), 'utf8');
  return new Response(context, { headers: { 'Content-Type': 'application/ld+json; charset=utf-8' } });
}
