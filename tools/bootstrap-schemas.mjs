import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = new URL('../dist/schema/v1.0/', import.meta.url);
const target = new URL('../packages/schemas/schemas/v1.0/', import.meta.url);
await mkdir(target, { recursive: true });
const files = (await readdir(source)).filter((name) => name.endsWith('.schema.json')).sort();
const provenance = {};
const definitionKinds = {
  Role: 'role', RoleGroup: 'role-group', Reading: 'reading', Block: 'block', Section: 'section', Ordo: 'ordo',
  Proper: 'proper', Calendar: 'calendar', Rubric: 'rubric', Asset: 'asset', TeachingNote: 'teaching-note',
  Authority: 'authority', Mutation: 'mutation', Chant: 'chant', Person: 'person', Organization: 'organization',
};

function normalizeEmbeddedDefinition(definition, entityType) {
  if (!definition || definition.type !== 'object') return;
  definition.properties ??= {};
  if (definition.properties.type?.const !== entityType && definition.properties.type) {
    definition.properties.kind = definition.properties.type;
    delete definition.properties.type;
    definition.required = (definition.required ?? []).map((field) => field === 'type' ? 'kind' : field);
  }
  definition.properties.type = { const: entityType };
  // Embedded mutations are written without `type` (see proper-mutations docs); every other entity requires it.
  if (entityType !== 'mutation') definition.required = [...new Set(['type', ...(definition.required ?? [])])];
  if (entityType === 'proper') {
    definition.properties.ordos = { type: 'array', items: { $ref: '#/$defs/Id' }, minItems: 1, uniqueItems: true };
    definition.properties.fills = { type: 'object', additionalProperties: true };
    definition.required = [...new Set([...definition.required, 'ordos'])];
  }
}

for (const file of files) {
  const schema = JSON.parse(await readFile(new URL(file, source), 'utf8'));
  // Older site builds named the embedded mutation definition "Structural Mutation" while referencing #/$defs/Mutation.
  if (schema.$defs?.['Structural Mutation'] && !schema.$defs.Mutation) {
    schema.$defs.Mutation = schema.$defs['Structural Mutation'];
    delete schema.$defs['Structural Mutation'];
  }
  const name = file.replace('.schema.json', '');
  schema['x-ols-schema-source'] = name === 'corpus' ? 'normative' : 'synthesized';
  schema['x-ols-specification'] = `https://ols.otyg.org/schema/v1.0/${file}`;
  schema['x-ols-revision'] = '1.0.0';
  if (schema.$defs?.LocalizedText?.$ref === '#/$defs/LocalizedText') {
    schema.$defs.LocalizedText = { type: 'object', minProperties: 1, patternProperties: { '^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$': { type: 'string' } }, additionalProperties: false };
  }
  for (const [definitionName, entityType] of Object.entries(definitionKinds)) {
    normalizeEmbeddedDefinition(schema.$defs?.[definitionName], entityType);
  }
  if (name === 'corpus') {
    schema.oneOf = undefined;
    schema.type = 'object';
    schema.properties = {
      $schema: { const: schema.$id },
      ols_version: { type: 'string', pattern: '^1\\.[01]\\.[0-9]+$' },
      type: { const: 'corpus' },
      id: { $ref: '#/$defs/Id' },
      metadata: { type: 'object' }, authority: { $ref: '#/$defs/Authority' },
      roles: { type: 'array', items: { $ref: '#/$defs/Role' } },
      readings: { type: 'array', items: { $ref: '#/$defs/Reading' } },
      blocks: { type: 'array', items: { $ref: '#/$defs/Block' } },
      sections: { type: 'array', items: { $ref: '#/$defs/Section' } },
      ordos: { type: 'array', items: { $ref: '#/$defs/Ordo' } },
      propers: { type: 'array', items: { $ref: '#/$defs/Proper' } },
      calendars: { type: 'array', items: { $ref: '#/$defs/Calendar' } },
      rubrics: { type: 'array', items: { $ref: '#/$defs/Rubric' } },
      assets: { type: 'array', items: { $ref: '#/$defs/Asset' } },
      teachingNotes: { type: 'array', items: { $ref: '#/$defs/TeachingNote' } },
    };
    schema.required = ['$schema', 'ols_version', 'type', 'id'];
    schema.additionalProperties = true;
  } else if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    if ('type' in properties && properties.type?.const !== name) {
      properties.kind = properties.type;
      delete properties.type;
      schema.required = (schema.required ?? []).map((field) => field === 'type' ? 'kind' : field);
    }
    schema.properties = {
      $schema: { const: schema.$id },
      ols_version: { type: 'string', pattern: '^1\\.[01]\\.[0-9]+$' },
      type: { const: name },
      ...properties,
    };
    schema.required = [...new Set(['$schema', 'ols_version', 'type', ...(schema.required ?? [])])];
  }
  if (name === 'mutation' && schema.properties?.operation) {
    schema.properties.op = schema.properties.operation;
    delete schema.properties.operation;
    schema.required = schema.required.map((field) => field === 'operation' ? 'op' : field);
  }
  if (name === 'manifest') {
    schema.properties.package = schema.properties.id;
    schema.properties.title = schema.properties.name;
    delete schema.properties.id;
    delete schema.properties.name;
    delete schema.properties.ols;
    schema.properties.scope = { type: 'object' };
    schema.properties.dependencies = { type: 'array', items: { type: 'string' }, uniqueItems: true };
    schema.properties.license = { oneOf: [{ type: 'string' }, { type: 'object' }] };
    schema.properties.authority = { type: 'object', properties: { status: { $ref: '#/$defs/AuthorityStatus' }, allowedUse: { type: 'array', items: { type: 'string' } }, restrictedUse: { type: 'array', items: { type: 'string' } } }, additionalProperties: true };
    schema.properties.allowedLicenseOverrides = { type: 'array', items: { type: 'string' }, uniqueItems: true };
    schema.required = ['$schema', 'ols_version', 'type', 'package', 'version', 'title'];
  }
  if (name === 'proper') {
    schema.properties.ordos = { type: 'array', items: { $ref: '#/$defs/Id' }, minItems: 1, uniqueItems: true };
    schema.properties.fills = { type: 'object', additionalProperties: true };
    schema.required = [...new Set([...schema.required, 'ordos'])];
  }
  const body = `${JSON.stringify(schema, null, 2)}\n`;
  await writeFile(new URL(file, target), body);
  provenance[file] = {
    source: schema['x-ols-schema-source'],
    specification: schema['x-ols-specification'],
    revision: '1.0.0',
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}
await writeFile(new URL('../packages/schemas/provenance.json', import.meta.url), `${JSON.stringify(provenance, null, 2)}\n`);
