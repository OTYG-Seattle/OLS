import { supportedValueGroups } from './supported-values';

type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const string = { type: 'string', minLength: 1 };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' };
const refs = { type: 'array', items: id, minItems: 1, uniqueItems: true };
const object = (properties: Schema, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: true,
});

export const commonDefinitions: Record<string, Schema> = {
  Id: id,
  LocalizedText: {
    type: 'object',
    minProperties: 1,
    patternProperties: { '^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$': { type: 'string' } },
    additionalProperties: false,
  },
  ...Object.fromEntries(
    Object.values(supportedValueGroups).map((g) => [
      g.definition,
      {
        type: 'string',
        ...(g.closed === false ? { examples: g.values } : { enum: g.values }),
        description: g.description,
      },
    ]),
  ),
};

export const entitySchemas: Record<string, { title: string; schema: Schema }> = {
  'localized-text': { title: 'LocalizedText', schema: ref('LocalizedText') },
  transliteration: {
    title: 'Transliteration',
    schema: object(
      {
        source: string,
        target: string,
        system: ref('TransliterationSystem'),
        purpose: string,
        value: string,
        reviewedBy: ref('Id'),
      },
      ['source', 'target', 'system', 'value'],
    ),
  },
  utterance: {
    title: 'Utterance',
    schema: object(
      {
        id: ref('Id'),
        roles: refs,
        mode: ref('UtteranceMode'),
        delivery: string,
        audience: string,
        text: ref('LocalizedText'),
        chant: { type: 'object' },
      },
      ['id', 'roles', 'mode', 'text'],
    ),
  },
  reading: {
    title: 'Reading',
    schema: object(
      {
        id: ref('Id'),
        type: string,
        role: ref('Id'),
        reference: object(
          {
            system: string,
            osisRef: string,
            book: string,
            chapterStart: { type: 'integer', minimum: 1 },
            verseStart: { type: 'integer', minimum: 1 },
            chapterEnd: { type: 'integer', minimum: 1 },
            verseEnd: { type: 'integer', minimum: 1 },
          },
          ['system'],
        ),
        text: ref('LocalizedText'),
        citation: ref('Id'),
      },
      ['id', 'type', 'role', 'reference'],
    ),
  },
  chant: {
    title: 'Chant',
    schema: object(
      { system: string, mode: string, zemaType: string, source: { type: 'object' }, performance: { type: 'object' } },
      ['system', 'mode'],
    ),
  },
  rubric: {
    title: 'Rubric',
    schema: object(
      {
        id: ref('Id'),
        category: ref('RubricCategory'),
        subtype: string,
        force: ref('RubricForce'),
        actors: refs,
        object: ref('Id'),
        from: ref('Id'),
        to: ref('Id'),
        path: refs,
        description: ref('LocalizedText'),
        stateTransition: { type: 'object' },
      },
      ['id', 'category', 'actors'],
    ),
  },
  block: {
    title: 'Block',
    schema: object(
      {
        id: ref('Id'),
        type: string,
        label: ref('LocalizedText'),
        elements: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              { required: ['$ref'] },
              { required: ['utterance'] },
              { required: ['reading'] },
              { required: ['rubric'] },
              { required: ['teaching'] },
            ],
          },
        },
      },
      ['id', 'type', 'elements'],
    ),
  },
  section: {
    title: 'Section',
    schema: object(
      { id: ref('Id'), type: { const: 'section' }, label: ref('LocalizedText'), blocks: refs, properSlots: refs },
      ['id', 'label'],
    ),
  },
  'proper-slot': {
    title: 'ProperSlot',
    schema: object(
      {
        id: ref('Id'),
        accepts: { type: 'array', items: { type: 'string' }, minItems: 1 },
        required: { type: 'boolean' },
      },
      ['id', 'accepts'],
    ),
  },
  proper: {
    title: 'Proper',
    schema: object(
      {
        id: ref('Id'),
        conditions: { type: 'object' },
        mutations: { type: 'array', items: ref('Mutation') },
        priorityClass: string,
        priority: { type: 'number' },
      },
      ['id', 'conditions', 'mutations'],
    ),
  },
  mutation: {
    title: 'Structural Mutation',
    schema: object({ operation: ref('MutationOperation'), target: ref('Id'), content: {}, value: {} }, [
      'operation',
      'target',
    ]),
  },
  role: {
    title: 'Role',
    schema: object({ id: ref('Id'), type: ref('RoleType'), label: ref('LocalizedText'), inherits: refs }, [
      'id',
      'type',
    ]),
  },
  'role-group': {
    title: 'RoleGroup',
    schema: object({ id: ref('Id'), label: ref('LocalizedText'), roles: refs }, ['id', 'roles']),
  },
  citation: {
    title: 'Citation',
    schema: object(
      {
        id: ref('Id'),
        type: ref('SourceType'),
        title: string,
        language: string,
        edition: { type: ['string', 'null'] },
        publisher: { type: ['string', 'null'] },
        year: { type: ['integer', 'null'] },
        page: string,
        line: string,
        license: string,
        notes: ref('LocalizedText'),
      },
      ['id', 'type', 'title'],
    ),
  },
  provenance: {
    title: 'Provenance',
    schema: object(
      {
        sourceStatus: string,
        transcriber: ref('Id'),
        translator: ref('Id'),
        editors: refs,
        reviewers: refs,
        confidence: { enum: ['low', 'medium', 'high'] },
        lastReviewed: { type: 'string', format: 'date' },
        changeReason: string,
      },
      ['sourceStatus'],
    ),
  },
  authority: {
    title: 'Authority',
    schema: object(
      {
        status: ref('AuthorityStatus'),
        allowedUse: { type: 'array', items: string },
        restrictedUse: { type: 'array', items: string },
        reviewedBy: { type: 'array', items: { type: 'object' } },
      },
      ['status'],
    ),
  },
  person: {
    title: 'Person',
    schema: object(
      {
        id: ref('Id'),
        type: { const: 'person' },
        displayName: string,
        roles: { type: 'array', items: string },
        affiliation: ref('Id'),
        privacy: { type: 'object' },
      },
      ['id', 'type', 'displayName'],
    ),
  },
  organization: {
    title: 'Organization',
    schema: object(
      {
        id: ref('Id'),
        type: { const: 'organization' },
        kind: string,
        name: ref('LocalizedText'),
        jurisdiction: string,
        location: { type: 'object' },
      },
      ['id', 'type', 'kind', 'name'],
    ),
  },
  asset: {
    title: 'Asset',
    schema: object(
      {
        id: ref('Id'),
        type: ref('AssetType'),
        uri: { type: 'string', format: 'uri-reference' },
        linkedTo: ref('Id'),
        license: string,
        provenance: ref('Id'),
      },
      ['id', 'type', 'uri', 'linkedTo'],
    ),
  },
  variant: {
    title: 'Variant',
    schema: object({ id: ref('Id'), type: string, source: ref('Id'), base: ref('Id'), text: ref('LocalizedText') }, [
      'id',
      'type',
      'source',
    ]),
  },
  'teaching-note': {
    title: 'TeachingNote',
    schema: object(
      {
        id: ref('Id'),
        target: ref('Id'),
        summary: ref('LocalizedText'),
        bibleLinks: { type: 'array', items: string },
        ageLevel: string,
        author: ref('Id'),
        source: ref('Id'),
      },
      ['id', 'target', 'summary'],
    ),
  },
  calendar: {
    title: 'Calendar',
    schema: object(
      {
        id: ref('Id'),
        system: string,
        epoch: string,
        monthCount: { type: 'integer', minimum: 1 },
        supports: { type: 'array', items: ref('CalendarCapability'), uniqueItems: true },
      },
      ['id', 'system'],
    ),
  },
  ordo: {
    title: 'Ordo',
    schema: object({ id: ref('Id'), label: ref('LocalizedText'), sections: refs }, ['id', 'sections']),
  },
  'service-instance': {
    title: 'ServiceInstance',
    schema: object(
      {
        id: ref('Id'),
        type: { const: 'service-instance' },
        ordo: ref('Id'),
        date: { type: 'object' },
        status: string,
        cast: { type: 'array', items: object({ role: ref('Id'), person: ref('Id') }, ['role', 'person']) },
        activePropers: refs,
        executionTimeline: { type: 'array', items: ref('ExecutionTimelineEntry') },
        privacy: { type: 'object' },
      },
      ['id', 'type', 'ordo', 'date'],
    ),
  },
  'execution-timeline': {
    title: 'ExecutionTimelineEntry',
    schema: object(
      {
        target: ref('Id'),
        type: ref('TimelineTargetType'),
        start: string,
        end: string,
        duration: { type: 'string', pattern: '^P' },
        status: ref('TimelineStatus'),
      },
      ['target', 'type', 'status'],
    ),
  },
  'sacred-space': {
    title: 'SacredSpace',
    schema: object(
      {
        id: ref('Id'),
        zones: {
          type: 'array',
          minItems: 1,
          items: object({ id: ref('Id'), label: ref('LocalizedText'), access: { type: 'array', items: string } }, [
            'id',
            'label',
            'access',
          ]),
        },
      },
      ['id', 'zones'],
    ),
  },
  'inline-chant': {
    title: 'InlineChantAlignment',
    schema: object(
      { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, chant: ref('Chant') },
      ['start', 'end', 'chant'],
    ),
  },
  'verse-line-group': {
    title: 'VerseLineGroup',
    schema: object(
      {
        type: { enum: ['verse', 'line-group', 'hemistich-pair'] },
        n: { type: ['string', 'integer'] },
        lines: {
          type: 'array',
          minItems: 1,
          items: object(
            {
              n: { type: ['string', 'integer'] },
              hemistich: { enum: ['a', 'b'] },
              roles: refs,
              text: ref('LocalizedText'),
            },
            ['n', 'text'],
          ),
        },
      },
      ['type', 'lines'],
    ),
  },
  'rubric-state-transition': {
    title: 'RubricStateTransition',
    schema: object(
      {
        requires: { type: 'object', additionalProperties: true },
        sets: { type: 'object', additionalProperties: true },
      },
      ['requires', 'sets'],
    ),
  },
  'liturgical-day': {
    title: 'LiturgicalDay',
    schema: object(
      {
        date: { type: 'object' },
        season: string,
        feasts: { type: 'array', items: string },
        fasts: { type: 'array', items: string },
        commemorations: { type: 'array', items: string },
        readings: refs,
        activePropers: refs,
        conflicts: { type: 'array' },
      },
      ['date'],
    ),
  },
  'conflict-rule': {
    title: 'CalendarConflictRule',
    schema: object(
      { id: ref('Id'), winner: ref('Id'), overrides: refs, priorityClass: string, priority: { type: 'number' } },
      ['id', 'winner', 'overrides'],
    ),
  },
  conformance: {
    title: 'ConformanceDeclaration',
    schema: object(
      {
        ols: string,
        levels: { type: 'array', items: ref('ConformanceLevel'), uniqueItems: true },
        profiles: { type: 'array', items: string },
        unsupported: { type: 'array', items: string },
      },
      ['ols', 'levels'],
    ),
  },
  scope: {
    title: 'Scope',
    schema: object({ core: { type: 'boolean' }, traditions: { type: 'object' }, status: string }),
  },
  'test-fixture': {
    title: 'TestFixture',
    schema: object(
      {
        id: ref('Id'),
        schema: { type: 'string', format: 'uri-reference' },
        valid: { type: 'boolean' },
        instance: {},
        expectedErrors: { type: 'array', items: string },
      },
      ['id', 'schema', 'valid', 'instance'],
    ),
  },
  manifest: {
    title: 'OLS Package Manifest',
    schema: object(
      {
        id: ref('Id'),
        name: ref('LocalizedText'),
        version: string,
        ols: string,
        status: ref('DocumentStatus'),
        license: string,
        files: { type: 'array', items: string },
      },
      ['id', 'version', 'ols', 'status'],
    ),
  },
};

export function buildEntitySchema(name: string) {
  const entity = entitySchemas[name];
  if (!entity) return undefined;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://ols.otyg.org/schema/v1.0/${name}.schema.json`,
    title: entity.title,
    ...entity.schema,
    $defs: {
      ...commonDefinitions,
      Chant: entitySchemas.chant.schema,
      Mutation: entitySchemas.mutation.schema,
      ExecutionTimelineEntry: entitySchemas['execution-timeline'].schema,
    },
  };
}
