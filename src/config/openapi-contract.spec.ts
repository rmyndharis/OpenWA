import * as fs from 'fs';
import * as path from 'path';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Structural invariants of the committed snapshot.
 *
 * `openapi:check` proves the file matches a fresh export; it cannot say whether either is correct.
 * These assert properties the specification requires, so a regression fails here rather than in a
 * consumer's generator.
 */

const OPERATION_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const snapshot = (): OpenAPIObject =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8')) as OpenAPIObject;

describe('openapi.json structural invariants', () => {
  // OpenAPI 3.0 requires every template expression in a path to resolve to a declared path parameter,
  // on the path item or on the operation. A route whose handler never binds the parameter — a
  // class-level prefix nothing reads, or a wildcard read off the request — publishes the template with
  // nothing to fill it, and a generated client has no argument for that segment.
  it('every path template variable is declared as a path parameter', () => {
    const doc = snapshot();
    const undeclared: string[] = [];

    for (const [route, item] of Object.entries(doc.paths)) {
      const templated = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      if (!templated.length) continue;

      const itemLevel = (item.parameters ?? [])
        .filter(p => 'in' in p && p.in === 'path')
        .map(p => ('name' in p ? p.name : ''));

      for (const [method, operation] of Object.entries(item)) {
        if (!OPERATION_KEYS.has(method)) continue;
        const declared = new Set([
          ...itemLevel,
          ...((operation as { parameters?: { in?: string; name?: string }[] }).parameters ?? [])
            .filter(p => p.in === 'path')
            .map(p => p.name ?? ''),
        ]);
        for (const variable of templated) {
          if (!declared.has(variable)) undeclared.push(`${method.toUpperCase()} ${route} → {${variable}}`);
        }
      }
    }

    expect(undeclared).toEqual([]);
  });

  // OpenAPI 3.0 requires a parameter to carry a schema; without one a generator has no type for the
  // argument. Every path parameter in the document had one except the four added alongside this spec,
  // which is exactly the blind spot a structural check exists to close.
  it('every path parameter declares a schema type', () => {
    const doc = snapshot();
    const untyped: string[] = [];

    for (const [route, item] of Object.entries(doc.paths)) {
      const declared = [...((item.parameters ?? []) as { in?: string; name?: string; schema?: { type?: string } }[])];
      for (const [method, operation] of Object.entries(item)) {
        if (!OPERATION_KEYS.has(method)) continue;
        declared.push(
          ...((operation as { parameters?: { in?: string; name?: string; schema?: { type?: string } }[] }).parameters ??
            []),
        );
      }
      for (const p of declared) {
        if (p.in === 'path' && !p.schema?.type) untyped.push(`${route} -> ${p.name}`);
      }
    }

    expect(untyped).toEqual([]);
  });

  // Every participant write goes through runParticipantsUpdate, which spends the shared request
  // budget (baileys-groups.ts), so each can answer 503 — and each ALSO reports per-participant
  // refusals inside its 200, which is the neighbouring claim it is easiest to mistake the 503 for.
  // Keyed off the response schema rather than a list of paths: these four were missed when the rest
  // of the module gained its 503s, and a hand-written list would miss a fifth route the same way.
  it('every participant write documents the 503 its request budget can produce', () => {
    const doc = snapshot();
    const participantWrites: string[] = [];
    const undocumented: string[] = [];

    for (const [route, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!OPERATION_KEYS.has(method)) continue;
        const responses =
          (operation as { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> })
            .responses ?? {};
        const ref = responses['200']?.content?.['application/json']?.schema?.$ref;
        if (!ref?.endsWith('/ParticipantsOperationResponseDto')) continue;

        const id = `${method.toUpperCase()} ${route}`;
        participantWrites.push(id);
        if (!responses['503']) undocumented.push(id);
      }
    }

    // A renamed DTO would match nothing and leave the assertion below vacuously true — an empty
    // result from a selector that can no longer match is not evidence of compliance.
    expect(participantWrites.length).toBeGreaterThan(0);
    expect(undocumented).toEqual([]);
  });

  it('every operation declares at least one response', () => {
    const doc = snapshot();
    const silent = Object.entries(doc.paths).flatMap(([route, item]) =>
      Object.entries(item)
        .filter(([method]) => OPERATION_KEYS.has(method))
        .filter(([, operation]) => !Object.keys((operation as { responses?: object }).responses ?? {}).length)
        .map(([method]) => `${method.toUpperCase()} ${route}`),
    );

    expect(silent).toEqual([]);
  });

  it('never types a timestamp property as a bare object', () => {
    const doc = snapshot();
    // A `Date | null` member with no explicit @ApiProperty type is emitted as `type: object`, and the
    // published schema then rejects the ISO string the gateway actually sends. Restricted to
    // timestamp-named properties: the document's other bare objects are genuine Record maps, and the
    // Unix-seconds fields are legitimately `type: number`.
    const scanned: string[] = [];
    const bare: string[] = [];

    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      const properties = (schema as { properties?: Record<string, { type?: string }> }).properties ?? {};
      for (const [property, spec] of Object.entries(properties)) {
        if (!/(At|Timestamp)$/.test(property)) continue;
        scanned.push(`${name}.${property}`);
        if (spec.type === 'object') bare.push(`${name}.${property}`);
      }
    }

    // Guard the selector: if the naming convention changed, this would scan nothing and pass.
    expect(scanned.length).toBeGreaterThan(20);
    expect(bare).toEqual([]);
  });

  it('declares nullability on every property whose description offers null', () => {
    const doc = snapshot();
    // A property documented as carrying null must publish it, or a client generated from the
    // contract rejects a value the gateway both sends and accepts. `lastTriggeredAt` was fixed that
    // way; `filters` — stored as `dto.filters ?? null` for every webhook created without one — was
    // the sibling left behind, which is why this is an invariant rather than three more spellings.
    //
    // A container satisfies it through its members: `pictures` is never null, but its values are,
    // and it declares that on additionalProperties.
    const scanned: string[] = [];
    const undeclared: string[] = [];

    type Spec = { description?: string; nullable?: boolean; items?: Spec; additionalProperties?: Spec | boolean };
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      const properties = (schema as { properties?: Record<string, Spec> }).properties ?? {};
      for (const [property, spec] of Object.entries(properties)) {
        if (!/\bnull\b/i.test(spec.description ?? '')) continue;
        scanned.push(`${name}.${property}`);
        const member = typeof spec.additionalProperties === 'object' ? spec.additionalProperties : spec.items;
        if (spec.nullable !== true && member?.nullable !== true) undeclared.push(`${name}.${property}`);
      }
    }

    // Guard the selector: a description reworded away from the word would scan nothing and pass.
    expect(scanned.length).toBeGreaterThan(15);
    expect(undeclared).toEqual([]);
  });

  it('publishes workflow optimistic-lock bodies and their 400/409 responses', () => {
    const doc = snapshot();
    const operations = [
      doc.paths['/api/sessions/{sessionId}/workflow-hub/recruitment-applications/{applicationId}']?.patch,
      doc.paths['/api/sessions/{sessionId}/workflow-hub/talent-pool/{entryId}']?.patch,
    ];

    for (const operation of operations) {
      expect(operation).toBeDefined();
      const schema =
        operation?.requestBody && 'content' in operation.requestBody
          ? operation.requestBody.content['application/json']?.schema
          : undefined;
      expect(schema && '$ref' in schema ? schema.$ref : undefined).toMatch(
        /\/(UpdateRecruitmentApplicationDto|UpdateTalentPoolEntryDto)$/,
      );
      expect(operation?.responses).toHaveProperty('400');
      expect(operation?.responses).toHaveProperty('409');
    }

    const schemas = doc.components?.schemas as Record<string, { properties?: object; required?: string[] }>;
    for (const name of ['UpdateRecruitmentApplicationDto', 'UpdateTalentPoolEntryDto']) {
      expect(Object.keys(schemas[name]?.properties ?? {}).length).toBeGreaterThan(1);
      expect(schemas[name]?.required).toContain('expectedVersion');
    }
  });

  it('publishes the external record ingestion DTO and its conflict response', () => {
    const doc = snapshot();
    const operation = doc.paths['/api/sessions/{sessionId}/workflow-hub/records/ingest']?.post;

    expect(operation).toBeDefined();
    const schema =
      operation?.requestBody && 'content' in operation.requestBody
        ? operation.requestBody.content['application/json']?.schema
        : undefined;
    expect(schema && '$ref' in schema ? schema.$ref : undefined).toBe('#/components/schemas/IngestExternalRecordDto');
    expect(operation?.responses).toHaveProperty('400');
    expect(operation?.responses).toHaveProperty('409');

    const ingestSchema = doc.components?.schemas?.IngestExternalRecordDto as
      { properties?: object; required?: string[] } | undefined;
    expect(Object.keys(ingestSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['eventKey', 'instanceId', 'contactId', 'answers', 'source']),
    );
    expect(ingestSchema?.required).toEqual(expect.arrayContaining(['eventKey', 'instanceId', 'contactId', 'answers']));
  });

  it('documents proximity/test as forbidden to non-admin callers', () => {
    const operation = snapshot().paths['/api/sessions/{sessionId}/workflow-hub/proximity/test']?.post;
    expect(operation).toBeDefined();
    expect(operation?.responses).toHaveProperty('403');
    expect(operation?.summary).toContain('ADMIN');
  });

  it('gives each route exactly one path key, whatever its parameters are named', () => {
    const doc = snapshot();
    // A path template variable is positional: `/x/{id}` and `/x/{sessionId}` are the same URL. Two
    // keys for one route split its operations across two Path Items, and a generator emits two
    // endpoints where the gateway has one.
    const byShape = new Map<string, string[]>();
    for (const route of Object.keys(doc.paths)) {
      const shape = route.replace(/\{[^}]*\}/g, '{}');
      byShape.set(shape, [...(byShape.get(shape) ?? []), route]);
    }

    // Guard the grouping: a document that somehow parsed to nothing must not pass silently.
    expect(byShape.size).toBeGreaterThan(100);
    expect([...byShape.values()].filter(routes => routes.length > 1)).toEqual([]);
  });
});

// The document is produced in TWO places: scripts/export-openapi.ts for the committed snapshot, and
// src/main.ts for the live /api/docs. The schema-validity pass was added to the export only, so a
// running gateway kept serving a document that fails validation while the artifact was clean. A
// structural check, because neither producer is reachable from a unit test.
describe('both OpenAPI producers apply the same passes', () => {
  const PASSES = ['dropUnexpressibleOperations', 'exemptPublicOperations'];
  const producers = ['src/main.ts', 'scripts/export-openapi.ts'];

  it.each(PASSES)('%s runs in every producer', pass => {
    const missing = producers.filter(
      file => !fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').includes(`${pass}(`),
    );
    expect(missing).toEqual([]);
  });

  it('applies them in the same order in both', () => {
    for (const file of producers) {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const order = PASSES.map(p =>
        text.indexOf(`${p}(document`) >= 0 ? text.indexOf(`${p}(document`) : text.indexOf(`${p}(doc`),
      );
      // drop must precede exempt: exempting an operation about to be deleted is wasted work, and the
      // reverse order would leave a security exemption attached to nothing.
      expect(order[0]).toBeGreaterThan(-1);
      expect(order[1]).toBeGreaterThan(order[0]);
    }
  });
});

/**
 * A request body must publish a SCHEMA, not a primitive.
 *
 * `@ApiBody({ description })` with no `type:` publishes `{"type":"string"}` — the decorator has no
 * way to infer the DTO — so the published contract told every generated client the body was a bare
 * string while the handler took an object. `openapi:check` passes on it happily: the snapshot is
 * self-consistent, just wrong. One of the document's application/json bodies was in that state.
 */
describe('every JSON request body publishes an object schema', () => {
  const jsonBodies = (): Array<{ op: string; schema: Record<string, unknown> }> => {
    const out: Array<{ op: string; schema: Record<string, unknown> }> = [];
    for (const [path, item] of Object.entries(snapshot().paths as unknown as Record<string, Record<string, unknown>>)) {
      for (const [method, op] of Object.entries(item)) {
        const body = (op as { requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> } })
          .requestBody;
        const schema = body?.content?.['application/json']?.schema;
        if (schema) out.push({ op: `${method.toUpperCase()} ${path}`, schema });
      }
    }
    return out;
  };

  // Guards the assertion below: an extractor that found nothing would pass it vacuously.
  it('finds the document’s JSON request bodies', () => {
    expect(jsonBodies().length).toBeGreaterThan(50);
  });

  it('publishes none of them as a bare primitive', () => {
    const primitives = jsonBodies()
      .filter(({ schema }) => !schema.$ref && !schema.properties && schema.type !== 'object')
      .map(({ op, schema }) => `${op} -> ${JSON.stringify(schema)}`);
    expect(primitives).toEqual([]);
  });
});

/**
 * A published `example` is what a reader pastes into Swagger's "Try it out", so an example its own
 * route rejects is worse than no example at all: the first request against a new endpoint answers
 * `400`, and the schema that caused it says nothing about why. `CreateWebhookDto.secret` offered a
 * 15-character example under a 16-character floor, which is exactly how it was found
 * ([#1491](https://github.com/rmyndharis/OpenWA/issues/1491)).
 *
 * Only length is checked here. It is the constraint a hand-written example actually drifts past, and
 * it needs no validator: the bound and the example sit in the same schema object. The sweep covers
 * the top-level string properties of each component schema, which is where a hand-written
 * `@ApiProperty` example lives; nested and composed schemas are out of its reach.
 */
describe('every published string example fits its own schema', () => {
  type Example = { where: string; example: string; min?: number; max?: number };

  const examples = (): Example[] => {
    const schemas = (snapshot().components?.schemas ?? {}) as Record<
      string,
      { properties?: Record<string, { type?: string; example?: unknown; minLength?: number; maxLength?: number }> }
    >;
    const out: Example[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      for (const [property, spec] of Object.entries(schema.properties ?? {})) {
        if (spec.type === 'string' && typeof spec.example === 'string') {
          out.push({ where: `${name}.${property}`, example: spec.example, min: spec.minLength, max: spec.maxLength });
        }
      }
    }
    return out;
  };

  const bounded = (): Example[] => examples().filter(({ min, max }) => min !== undefined || max !== undefined);

  // Guards the assertion below twice over: an extractor that found no examples would pass it
  // vacuously, and so would one that found examples but never a schema that bounds their length.
  it('finds the document’s string examples, and the bounded ones among them', () => {
    expect(examples().length).toBeGreaterThan(200);
    expect(bounded().length).toBeGreaterThan(9);
  });

  it('publishes none of them outside its own minLength/maxLength', () => {
    const violations = bounded()
      .filter(
        ({ example, min, max }) =>
          (min !== undefined && example.length < min) || (max !== undefined && example.length > max),
      )
      .map(
        ({ where, example, min, max }) =>
          `${where}: ${JSON.stringify(example)} is ${example.length} chars, bounds [${min ?? '-'}, ${max ?? '-'}]`,
      );
    expect(violations).toEqual([]);
  });
});
