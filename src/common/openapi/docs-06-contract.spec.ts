import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docs/06-api-specification.md` is the reference a REST consumer reads when there is no SDK — curl,
 * Postman, n8n. It restates the published contract by hand, and nothing bound the two, so operations
 * shipped without ever reaching it: `GET`/`PATCH /api/sessions/{id}/config` are implemented by all
 * five SDKs and documented only in `docs/05`, and the integration redrive route was documented
 * nowhere at all.
 *
 * This gate compares the document's route headings to `openapi.json` in both directions. An
 * operation added without a heading, a heading left behind after a route is renamed, and a stale
 * allowlist entry all fail here.
 *
 * Operations deliberately documented in another file carry an allowlist entry naming that file, and
 * the gate reads the file to confirm the path is really there — otherwise "documented in docs/25"
 * would be an unchecked claim, which is the exact failure this gate exists to prevent.
 */
describe('docs/06 matches the published contract', () => {
  const REPO = join(__dirname, '..', '..', '..');
  const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8');

  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

  /** The contract writes `{id}`, the prose writes `:id`. Normalise both to `:id`. */
  const normalise = (path: string): string => path.replace(/\{(\w+)\}/g, ':$1').replace(/\/+$/, '');

  /**
   * A path with its parameter segments collapsed. Used only for the allowlist backing check: the
   * contract names a segment `{path}` where docs/25 names the same segment `:route`, and a parameter
   * name is a documentation choice rather than part of the route's identity.
   */
  const shape = (path: string): string =>
    path
      .split('/')
      .map(segment => (segment.startsWith(':') || segment.startsWith('{') ? ':*' : segment))
      .join('/');

  const contractOperations = (): Set<string> => {
    const spec = JSON.parse(read('openapi.json')) as { paths: Record<string, Record<string, unknown>> };
    const operations = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (METHODS.includes(method)) operations.add(`${method.toUpperCase()} ${normalise(path)}`);
      }
    }
    return operations;
  };

  const documentedHeadings = (): Set<string> =>
    new Set(
      [...read('docs', '06-api-specification.md').matchAll(/^#### (GET|POST|PUT|PATCH|DELETE) (\S+)/gm)].map(
        match => `${match[1]} ${normalise(match[2])}`,
      ),
    );

  /**
   * Operations deliberately documented in another file carry an allowlist entry naming that file, and
   * the gate reads the file to confirm the path is really there — otherwise "documented in docs/25"
   * would be an unchecked claim, which is the exact failure this gate exists to prevent.
   *
   * The set is EMPTY today: every operation the contract publishes carries its own heading in
   * docs/06 (the session-config routes and the integration instance/ingress family moved in from
   * docs/05 and docs/25, which keep their design-level treatment). The mechanism stays for a future
   * deliberate exception — an entry is honored only while the named file really contains the path
   * and docs/06 has no heading for it, and the stale-entry test below retires it automatically.
   */
  const DOCUMENTED_ELSEWHERE = new Map<string, string>([]);

  /**
   * Headings with no contract operation, and why the contract cannot carry them. `POST /mcp` is
   * mounted on raw Express outside Nest, so the Swagger scanner never sees it.
   */
  const NOT_IN_CONTRACT = new Set(['POST /mcp']);

  /** True when `file` contains a path of the same shape as `operation`. */
  const backs = (file: string, operation: string): boolean => {
    const wanted = shape(operation.slice(operation.indexOf(' ') + 1));
    const body = read(...file.split('/'));
    return [...body.matchAll(/\/api\/[A-Za-z0-9:{}_\-/]+/g)].some(match => shape(normalise(match[0])) === wanted);
  };

  /** Contract operations with neither a docs/06 heading nor an allowlist entry. */
  const undocumentedOf = (operations: Set<string>, headings: Set<string>): string[] =>
    [...operations].filter(operation => !headings.has(operation) && !DOCUMENTED_ELSEWHERE.has(operation)).sort();

  it('documents every contract operation, or allowlists it to a file that really documents it', () => {
    const operations = contractOperations();
    const headings = documentedHeadings();

    expect(operations.size).toBeGreaterThan(150);
    expect(headings.size).toBeGreaterThan(150);

    expect(undocumentedOf(operations, headings)).toEqual([]);
  });

  it('every allowlisted operation is really documented in the file it names', () => {
    const unbacked = [...DOCUMENTED_ELSEWHERE]
      .filter(([operation, file]) => !backs(file, operation))
      .map(([operation, file]) => `${operation} claims ${file}, which does not contain that path`);
    expect(unbacked).toEqual([]);
  });

  it('has no heading for a route the contract no longer publishes', () => {
    const operations = contractOperations();
    const stale = [...documentedHeadings()]
      .filter(heading => !operations.has(heading) && !NOT_IN_CONTRACT.has(heading))
      .sort();
    expect(stale).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const operations = contractOperations();
    const headings = documentedHeadings();

    const stale = [...DOCUMENTED_ELSEWHERE.keys()]
      .filter(operation => !operations.has(operation) || headings.has(operation))
      .sort();
    expect(stale).toEqual([]);
  });

  /**
   * Route-specific status codes must be restated per operation, not left to §6.2's generic table.
   * `400`/`401`/`403`/`404` are universal (every route can answer them via validation, auth, role
   * and existence guards) and stay covered by the General Error Codes table; the codes below only
   * appear on routes that deliberately declare them, so a consumer reading the section for retry
   * and engine-support logic must see them there. This closed a drift where 409 was missing from
   * 82 sections, 503 from 47 and 501 from 16 while the contract declared all of them.
   */
  const ROUTE_SPECIFIC_CODES = new Set(['409', '413', '415', '422', '429', '501', '502', '503']);

  const readContract = () =>
    JSON.parse(read('openapi.json')) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };

  /** The status codes each operation's `**Errors:**` block names, keyed like the contract operations. */
  const documentedErrors = (): Map<string, string[]> => {
    const doc = read('docs', '06-api-specification.md');

    // Slice the document into per-heading sections so each Errors line is matched to its operation.
    const headings = [...doc.matchAll(/^#### (GET|POST|PUT|PATCH|DELETE) (\S+)$/gm)];
    const errorsOf = new Map<string, string[]>();
    for (let i = 0; i < headings.length; i++) {
      const key = `${headings[i][1]} ${normalise(headings[i][2])}`;
      const body = doc.slice(headings[i].index, (headings[i + 1] ?? { index: doc.length }).index);
      // An Errors block may wrap across physical lines (long route-specific descriptions); join the
      // block until the first blank line or next heading so codes on continuation lines count too.
      const blockLines: string[] = [];
      let capturing = false;
      for (const raw of body.split('\n')) {
        if (/^\*\*Errors:\*\*/.test(raw)) capturing = true;
        else if (capturing && (raw.trim() === '' || /^#{2,4} /.test(raw))) break;
        if (capturing) blockLines.push(raw);
      }
      const line = blockLines.join('\n');
      errorsOf.set(key, [...new Set([...line.matchAll(/`(\d{3})`/g)].map(match => match[1]))]);
    }
    return errorsOf;
  };

  it('documents every route-specific status code the contract declares for the operation', () => {
    const spec = readContract();
    const errorsOf = documentedErrors();

    const missing: string[] = [];
    let checked = 0;
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        if (!item[method]) continue;
        const key = `${method.toUpperCase()} ${normalise(path)}`;
        const declared = Object.keys(item[method].responses ?? {}).filter(code => ROUTE_SPECIFIC_CODES.has(code));
        if (declared.length === 0) continue;
        checked++;
        const documented = errorsOf.get(key) ?? [];
        for (const code of declared) {
          if (!documented.includes(code)) missing.push(`${key} misses ${code}`);
        }
      }
    }
    // Non-vacuity: the contract declares route-specific codes on a large share of the surface.
    expect(checked).toBeGreaterThan(80);
    expect(missing).toEqual([]);
  });

  /**
   * The reverse direction: a code the section promises must be one the contract declares, or a
   * generated client and the published schema disagree with the prose about what the route answers.
   * `415`/`429`/`500`/`503` can come from any route (compressed body, rate limiter, unexpected
   * error, body budget or a dependency not ready) and `400`/`404` are the universal validation and
   * existence answers, so the General Error Codes table covers them and a section may restate them
   * without the operation declaring them.
   */
  const UNDECLARED_ALLOWED = new Set(['400', '404', '415', '429', '500', '503']);

  it('declares in the contract every status code the section documents', () => {
    const spec = readContract();
    const undeclared: string[] = [];
    let checked = 0;
    for (const [key, codes] of documentedErrors()) {
      const [method, path] = key.split(' ');
      const operation = Object.entries(spec.paths).find(([candidate]) => normalise(candidate) === path)?.[1][
        method.toLowerCase()
      ];
      if (!operation) continue;
      for (const code of codes) {
        if (UNDECLARED_ALLOWED.has(code)) continue;
        checked++;
        if (!operation.responses?.[code]) undeclared.push(`${key} documents ${code}`);
      }
    }
    // Non-vacuity: nearly every section names its auth and conflict answers.
    expect(checked).toBeGreaterThan(400);
    expect(undeclared.sort()).toEqual([]);
  });

  type SchemaNode = { $ref?: string; required?: string[]; properties?: Record<string, SchemaNode>; items?: SchemaNode };

  const readShapes = () =>
    JSON.parse(read('openapi.json')) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, { schema: SchemaNode }> }> }>
      >;
      components: { schemas: Record<string, SchemaNode> };
    };

  /** The JSON of the first fence after the `**Response** `200`` label of a route's section in docs/06. */
  const responseExample = (heading: string): Record<string, unknown> => {
    const doc = read('docs', '06-api-specification.md');
    const start = doc.indexOf(`\n#### ${heading}\n`);
    if (start === -1) throw new Error(`docs/06 has no section for ${heading}`);
    const next = doc.indexOf('\n#### ', start + 1);
    const section = doc.slice(start, next === -1 ? doc.length : next);
    const label = section.indexOf('**Response** `200`');
    if (label === -1) throw new Error(`docs/06 shows no 200 response for ${heading}`);
    const fence = /```json\n([\s\S]*?)\n```/.exec(section.slice(label));
    if (fence === null) throw new Error(`docs/06 shows no JSON example for ${heading}`);
    return JSON.parse(fence[1]) as Record<string, unknown>;
  };

  /** The keys the contract requires of an entry that the example leaves out, and the keys it invents. */
  const entryProblems = (entry: Record<string, unknown>, schema: SchemaNode): string[] => {
    const known = Object.keys(schema.properties ?? {});
    return [
      ...(schema.required ?? []).filter(key => !(key in entry)).map(key => `lacks ${key}`),
      ...Object.keys(entry)
        .filter(key => !known.includes(key))
        .map(key => `invents ${key}`),
    ];
  };

  /** The schema of the entries of a response property, following `$ref` one level at each step. */
  const entrySchema = (path: string, property: string): SchemaNode => {
    const { paths, components } = readShapes();
    const resolve = (node: SchemaNode): SchemaNode =>
      node.$ref === undefined ? node : components.schemas[node.$ref.slice('#/components/schemas/'.length)];
    const body = resolve(paths[path].get.responses['200'].content?.['application/json']?.schema ?? {});
    return resolve(body.properties?.[property]?.items ?? {});
  };

  it.each([
    ['GET /api/stats/messages', '/api/stats/messages'],
    ['GET /api/stats/sessions/:sessionId', '/api/stats/sessions/{sessionId}'],
  ])('the %s example gives each topChats entry the keys of the contract', (heading, path) => {
    const entries = responseExample(heading).topChats as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entryProblems(entry, entrySchema(path, 'topChats'))).toEqual([]);
  });

  // The gate's own controls. Without these, a matcher that silently stops working is
  // indistinguishable from a document that is correct.
  describe('the checks themselves can fail', () => {
    it('reports an operation with neither a heading nor an allowlist entry', () => {
      const operations = contractOperations();
      const headings = documentedHeadings();
      const [victim] = [...operations];
      headings.delete(victim);
      expect(undocumentedOf(operations, headings)).toEqual([victim]);
    });

    it('reports an allowlist entry whose file does not contain the path', () => {
      expect(backs('docs/05-database-design.md', 'GET /api/nowhere/:id')).toBe(false);
    });

    it('accepts a documenting file that spells the parameter differently', () => {
      // docs/25 writes `:route` where the contract writes `{path}`.
      expect(backs('docs/25-integration-fabric.md', 'GET /api/ingress/:pluginId/:instanceId/:path')).toBe(true);
    });

    it('reports a response example entry that lacks a required key or invents one', () => {
      const schema = entrySchema('/api/stats/messages', 'topChats');
      expect(entryProblems({ chatId: 'x@c.us', messageCount: 1 }, schema)).toEqual(['lacks chatName']);
      expect(entryProblems({ chatId: 'x@c.us', chatName: null, messageCount: 1, extra: true }, schema)).toEqual([
        'invents extra',
      ]);
    });
  });

  // Removing the account's own picture sends the request on every call, and WhatsApp's answer to a repeat for an
  // account with no picture has not been observed (it is for a group). The text must not promise a no-op.
  describe('the removal of the own profile picture', () => {
    const section = (): string => {
      const doc = read('docs', '06-api-specification.md');
      const start = doc.indexOf('\n#### DELETE /api/sessions/:sessionId/profile/picture\n');
      if (start === -1) throw new Error('docs/06 has no section for the own picture removal');
      const next = doc.indexOf('\n#### ', start + 1);
      return doc.slice(start, next === -1 ? doc.length : next).replace(/\s+/g, ' ');
    };

    it('does not promise that a repeat answers 200', () => {
      expect(section()).not.toMatch(/safe to repeat|also answers `200`/);
    });

    it('says a repeat answers what WhatsApp answers, and that the answer for an own account is not observed', () => {
      expect(section()).toMatch(/a repeat sends the same request again and answers what WhatsApp answers/);
      expect(section()).toMatch(/for an account's own picture has not been observed/);
    });

    it.each([
      ['the service', ['src', 'modules', 'profile', 'profile.service.ts']],
      ['the engine interface', ['src', 'engine', 'interfaces', 'whatsapp-engine.interface.ts']],
    ])('is not called idempotent by %s', (_name, file) => {
      const source = read(...file);
      const start = source.indexOf('Remove the account');
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, source.indexOf('deleteProfilePicture(', start))).not.toMatch(/idempotent|no-op/i);
    });
  });
});
