import * as fs from 'fs';
import * as path from 'path';
import {
  createSwaggerConfig,
  dropUnexpressibleOperations,
  exemptPublicOperations,
  PUBLIC_PATHS,
  METRICS_BEARER_SCHEME,
} from './swagger.config';
import type { OpenAPIObject } from '@nestjs/swagger';

describe('createSwaggerConfig', () => {
  // Regression test for issue #104: Swagger UI returned "Unauthorized" because the
  // X-API-Key scheme was defined but never applied — no operation declared a security
  // requirement, so Swagger UI never sent the key. The fix applies it globally.
  it('applies the X-API-Key security scheme as a global requirement', () => {
    const config = createSwaggerConfig();

    expect(config.security).toContainEqual({ 'X-API-Key': [] });
  });

  it('defines the METRICS_TOKEN bearer scheme without applying it globally', () => {
    const config = createSwaggerConfig();

    expect(config.components?.securitySchemes?.[METRICS_BEARER_SCHEME]).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    // Only the scrape endpoint uses it (per-operation @ApiSecurity) — a global bearer
    // requirement would falsely claim every route accepts it.
    expect(config.security).not.toContainEqual({ [METRICS_BEARER_SCHEME]: [] });
  });

  // Swagger UI aims "Try it" at servers[0]. A relative URL resolves against whatever origin served
  // the docs, so it works on localhost, a LAN address and behind a TLS proxy alike; anything
  // absolute here would send the reader's browser somewhere else entirely (#1068).
  it('lists a relative server FIRST so Try-it targets the origin serving the docs', () => {
    const config = createSwaggerConfig();

    const [first] = config.servers ?? [];
    expect(first.url).toBe('/');
    expect(first.url.startsWith('http')).toBe(false);
  });

  it('keeps the templated absolute server so published specs still carry a concrete base URL', () => {
    const config = createSwaggerConfig();

    expect(config.servers).toHaveLength(2);
    const templated = (config.servers ?? []).find(s => s.url.includes('{host}'));
    expect(templated).toBeDefined();
    expect(templated?.url).toBe('http://{host}:{port}');
    expect(templated?.variables?.host.default).toBe('localhost');
    expect(templated?.variables?.port.default).toBe('2785');
  });
});

describe('exemptPublicOperations', () => {
  // Minimal fixture: one listed public path with two operations, one protected path.
  function fixtureDoc(): OpenAPIObject {
    return {
      openapi: '3.0.0',
      info: { title: 't', version: '0' },
      paths: {
        '/api/health': { get: {}, post: {} },
        '/api/sessions': { get: {} },
      },
      components: {},
    } as unknown as OpenAPIObject;
  }

  it('clears security on every operation of a listed public path', () => {
    const doc = exemptPublicOperations(fixtureDoc());

    expect(doc.paths['/api/health'].get?.security).toEqual([]);
    expect(doc.paths['/api/health'].post?.security).toEqual([]);
  });

  it('leaves non-public paths untouched (they inherit the global requirement)', () => {
    const doc = exemptPublicOperations(fixtureDoc());

    expect(doc.paths['/api/sessions'].get?.security).toBeUndefined();
  });

  it('does not throw when a listed path is absent from the document (stale entry is skipped)', () => {
    const doc = fixtureDoc();
    delete doc.paths['/api/health'];

    expect(() => exemptPublicOperations(doc)).not.toThrow();
  });
});

// PUBLIC_PATHS mirrors the @Public() decorator so the published spec does not falsely advertise a
// public route as requiring an API key. Two tripwires catch drift:
//   (1) the set of files with a real @Public() decorator must match EXPECTED_PUBLIC_CONTROLLERS —
//       add a controller here AND its path(s) to PUBLIC_PATHS when you mark a new route @Public();
//   (2) PUBLIC_PATHS must contain the expected entries (catches a typo or accidental removal).
// MetricsController is @Public() but gates scrapes on the METRICS_TOKEN bearer instead, so its
// operation carries the metrics-bearer security scheme (which overrides the global API-key
// requirement) rather than a PUBLIC_PATHS security: [] exemption.
describe('PUBLIC_PATHS drift guard', () => {
  const EXPECTED_PUBLIC_CONTROLLERS = [
    'src/modules/health/health.controller.ts',
    'src/modules/infra/infra-status.controller.ts',
    'src/modules/integration/ingress.controller.ts',
    'src/modules/metrics/metrics.controller.ts',
  ];

  function listTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) listTsFiles(full, out);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('every controller using @Public() is accounted for in EXPECTED_PUBLIC_CONTROLLERS', () => {
    const srcRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');
    // Match only a line that is exactly `@Public()` — ignores the decorator's doc comment
    // (`@example @Public()`) and test/string occurrences. *.spec.ts files are excluded: a real
    // @Public() decorator only attaches to a controller class, while a spec may legitimately spell
    // the decorator out as a string fixture (e.g. the global-route-fence structural guard).
    const usingPublic = listTsFiles(srcRoot)
      .filter(f => !f.endsWith('.spec.ts'))
      .filter(f => /^\s*@Public\(\)\s*$/m.test(fs.readFileSync(f, 'utf8')))
      .map(f => f.replace(/^.*\/src\//, 'src/'))
      .sort();

    expect(usingPublic).toEqual([...EXPECTED_PUBLIC_CONTROLLERS].sort());
  });

  // Exact, not arrayContaining: the file-set test above catches a new @Public CONTROLLER, but a
  // new @Public ROUTE on an already-listed controller (a fourth @Get on HealthController, say)
  // changes neither the file set nor a superset assertion — it would just be missing from
  // PUBLIC_PATHS, and the published document would claim the route needs an API key it does not.
  it('PUBLIC_PATHS is exactly the expected @Public route paths', () => {
    expect([...PUBLIC_PATHS].sort()).toEqual(
      [
        '/api/health',
        '/api/health/live',
        '/api/health/ready',
        '/api/infra/health',
        '/api/ingress/{pluginId}/{instanceId}/{path}',
      ].sort(),
    );
  });
});

describe('dropUnexpressibleOperations', () => {
  const docWith = (item: Record<string, unknown>): OpenAPIObject =>
    ({ paths: { '/api/thing': item } }) as unknown as OpenAPIObject;

  it('removes an operation OpenAPI 3.0 has no field for', () => {
    // `@nestjs/swagger` expands `@All()` over its own method list, which includes `search`. Nest routes
    // SEARCH at runtime; the 3.0 Path Item Object simply cannot describe it.
    const doc = docWith({ get: { operationId: 'a' }, search: { operationId: 'b' } });

    dropUnexpressibleOperations(doc);

    expect(Object.keys(doc.paths['/api/thing'])).toEqual(['get']);
  });

  it('keeps every field the 3.0 Path Item Object defines', () => {
    const item = {
      summary: 's',
      description: 'd',
      parameters: [],
      servers: [],
      get: {},
      put: {},
      post: {},
      delete: {},
      options: {},
      head: {},
      patch: {},
      trace: {},
    };

    const doc = docWith({ ...item });
    dropUnexpressibleOperations(doc);

    expect(Object.keys(doc.paths['/api/thing']).sort()).toEqual(Object.keys(item).sort());
  });

  it('keeps specification extensions', () => {
    const doc = docWith({ get: {}, 'x-internal': true });

    dropUnexpressibleOperations(doc);

    expect(Object.keys(doc.paths['/api/thing']).sort()).toEqual(['get', 'x-internal']);
  });

  it('removes a method upstream has not added yet', () => {
    // The allowlist is the point: a denylist naming `search` would pass the next WebDAV verb straight
    // through. RequestMethod already defines PROPFIND, MKCOL, COPY, MOVE, LOCK and UNLOCK.
    const doc = docWith({ get: {}, propfind: {}, mkcol: {} });

    dropUnexpressibleOperations(doc);

    expect(Object.keys(doc.paths['/api/thing'])).toEqual(['get']);
  });

  it('leaves the committed snapshot with no unexpressible operation', () => {
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
    ) as OpenAPIObject;

    const offenders = Object.entries(snapshot.paths).flatMap(([route, item]) => {
      const before = Object.keys(item);
      const after = Object.keys(
        dropUnexpressibleOperations({ paths: { [route]: { ...item } } } as OpenAPIObject).paths[route],
      );
      return before.length === after.length ? [] : [route];
    });

    expect(offenders).toEqual([]);
  });
});
