// Structural guard for the cross-tenant scoping class of bug (audit + webhook delivery-failures).
//
// The ApiKeyGuard session fence resolves the scoped sessionId from ROUTE PARAMS only
// (api-key.guard.ts). So any handler that instead accepts `sessionId` as a QUERY param is NOT
// scoped by the guard, and must derive scope from the calling key itself — the established pattern is
// to inject `@CurrentApiKey()` and pass `apiKey.allowedSessions` to the service (see
// search.controller / webhooks-list findAll / audit). This test fails if a controller handler takes
// `@Query('sessionId')` without also injecting `@CurrentApiKey`, so a future endpoint cannot silently
// re-introduce the leak.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Return the names of handlers in `source` that take a `sessionId` query param but do NOT inject
 * `@CurrentApiKey` in the same parameter list — i.e. that bypass the guard fence without re-scoping.
 */
export function handlersMissingSessionScope(source: string): string[] {
  const offenders: string[] = [];
  // Match a 2-space-indented method declaration and capture its parameter list: `name( <params> ):`.
  // Decorators (`@Get(...)`) start with `@`, so they are not matched as method names.
  const methodRe = /^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*:/gm;
  for (let m = methodRe.exec(source); m !== null; m = methodRe.exec(source)) {
    const [, name, params] = m;
    const takesSessionIdQuery = /@Query\(\s*['"]sessionId['"]\s*\)/.test(params);
    const injectsCurrentApiKey = /@CurrentApiKey\(/.test(params);
    if (takesSessionIdQuery && !injectsCurrentApiKey) offenders.push(name);
  }
  return offenders;
}

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('query-param sessionId endpoints are session-scoped', () => {
  // The checker itself must actually detect the leak — a structural guard that can't fail proves nothing.
  it('flags a handler that takes @Query(sessionId) without @CurrentApiKey', () => {
    const vulnerable = `
  async findAll(
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.svc.findAll(sessionId);
  }
`;
    expect(handlersMissingSessionScope(vulnerable)).toEqual(['findAll']);
  });

  it('clears a handler that injects @CurrentApiKey alongside the query param', () => {
    const fixed = `
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
  ): Promise<unknown> {
    return this.svc.findAll(sessionId, apiKey?.allowedSessions);
  }
`;
    expect(handlersMissingSessionScope(fixed)).toEqual([]);
  });

  it('no real controller takes @Query(sessionId) without scoping to the calling key', () => {
    const modulesDir = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of listControllerFiles(modulesDir)) {
      for (const handler of handlersMissingSessionScope(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(/.*\/src\//, 'src/')} :: ${handler}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
