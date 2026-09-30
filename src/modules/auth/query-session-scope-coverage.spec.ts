// Structural guard for the cross-tenant scoping class of bug (audit + webhook delivery-failures).
//
// The ApiKeyGuard session fence resolves the scoped sessionId from ROUTE PARAMS only
// (api-key.guard.ts). So any handler that instead accepts `sessionId` as a QUERY param is NOT
// scoped by the guard, and must derive scope from the calling key itself — the established pattern is
// to inject `@CurrentApiKey()` and pass `apiKey.allowedSessions` to the service (see
// search.controller / webhooks-list findAll / audit). This test fails if a controller handler takes
// `@Query('sessionId')`, or a whole `@Query()` / `@Body()` DTO declaring `sessionId` or `sessionIds`,
// without also injecting `@CurrentApiKey`, so a future endpoint cannot silently re-introduce the leak.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Match a 2-space-indented method declaration and capture its parameter list: `name( <params> )`
 * followed by either a return type (`:`) or the body (`{`). Decorators (`@Get(...)`) start with `@`,
 * so they are not matched as method names.
 *
 * The `{` alternative is load-bearing rather than cosmetic. Requiring a return type made the checker
 * skip every handler declared without one — 83 of 181 at the time it was widened, so a clean result
 * described less than half the surface it appeared to cover. The coverage test below now fails if
 * that ever becomes true again.
 *
 * Returned fresh on each call: the `g` flag makes `lastIndex` stateful, so a shared instance would
 * resume mid-source for the second caller.
 */
export function methodPattern(): RegExp {
  return /^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*[:{]/gm;
}

/**
 * Return the names of handlers in `source` that take a `sessionId` query param, or a whole `@Query()` /
 * `@Body()` DTO named in `sessionDtos`, but do NOT inject `@CurrentApiKey` in the same parameter list:
 * i.e. that bypass the guard fence without re-scoping.
 */
export function handlersMissingSessionScope(source: string, sessionDtos: ReadonlySet<string> = new Set()): string[] {
  const offenders: string[] = [];
  const methodRe = methodPattern();
  for (let m = methodRe.exec(source); m !== null; m = methodRe.exec(source)) {
    const [, name, params] = m;
    const takesSessionIdQuery = /@Query\(\s*['"]sessionId['"]\s*\)/.test(params);
    const takesSessionDto = [...params.matchAll(/@(?:Query|Body)\(\s*\)\s*\w+\??\s*:\s*(\w+)/g)].some(p =>
      sessionDtos.has(p[1]),
    );
    const injectsCurrentApiKey = /@CurrentApiKey\(/.test(params);
    if ((takesSessionIdQuery || takesSessionDto) && !injectsCurrentApiKey) offenders.push(name);
  }
  return offenders;
}

/**
 * The classes in `sources` that declare `sessionId` or `sessionIds`, themselves or through a parent
 * (`extends Y`, or a mapped type such as `PartialType(Y)` / `IntersectionType(Y, Z)`).
 */
export function sessionScopedDtos(sources: readonly string[]): Set<string> {
  const own = new Set<string>();
  const parents = new Map<string, string[]>();
  for (const source of sources) {
    for (const chunk of source.split(/export\s+class\s+/).slice(1)) {
      const name = /^(\w+)/.exec(chunk)?.[1];
      if (!name) continue;
      if (/^\s+sessionIds?[?!]?\s*:/m.test(chunk)) own.add(name);
      const heritage = /^\w+\s+extends\s+([^{]*)\{/.exec(chunk)?.[1] ?? '';
      parents.set(
        name,
        [...heritage.matchAll(/\b([A-Z]\w*Dto|[A-Z]\w*)\b/g)].map(p => p[1]),
      );
    }
  }
  const out = new Set<string>();
  const carries = (name: string, seen: Set<string>): boolean => {
    if (own.has(name)) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (parents.get(name) ?? []).some(parent => carries(parent, seen));
  };
  for (const name of parents.keys()) if (carries(name, new Set())) out.add(name);
  return out;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
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

  it('flags a vulnerable handler that declares no return type', () => {
    // The guard is only worth what it can see. A handler written without an explicit return type is
    // just as exposed, and for most of this file's life the checker skipped every one of them.
    const vulnerable = `
  async findAll(
    @Query('sessionId') sessionId?: string,
  ) {
    return this.svc.findAll(sessionId);
  }
`;
    expect(handlersMissingSessionScope(vulnerable)).toEqual(['findAll']);
  });

  it('flags a whole @Query() or @Body() DTO carrying sessionId or sessionIds, inherited or declared', () => {
    const dtos = sessionScopedDtos([
      `
export class FilterDto {
  @IsOptional()
  sessionId?: string;
}
export class FanOutDto {
  sessionIds!: string[];
}
export class UpdateFilterDto extends PartialType(FilterDto) {}
export class PlainDto {
  name?: string;
}
`,
    ]);
    expect([...dtos].sort()).toEqual(['FanOutDto', 'FilterDto', 'UpdateFilterDto']);

    const handlers = `
  async list(@Query() dto: FilterDto) {
    return this.svc.list(dto);
  }

  async fanOut(@Body() dto: FanOutDto): Promise<unknown> {
    return this.svc.fanOut(dto);
  }

  async update(@Body() dto: UpdateFilterDto) {
    return this.svc.update(dto);
  }

  async plain(@Body() dto: PlainDto) {
    return this.svc.plain(dto);
  }

  async scoped(@Query() dto: FilterDto, @CurrentApiKey() apiKey?: ApiKey) {
    return this.svc.list(dto, apiKey?.allowedSessions);
  }
`;
    expect(handlersMissingSessionScope(handlers, dtos)).toEqual(['list', 'fanOut', 'update']);
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

  // A structural guard that silently stops covering things is worse than no guard, because the green
  // result reads as "no endpoint leaks" rather than "no endpoint I looked at leaks". This pairs every
  // HTTP-verb decorator with the method the checker would examine for it, and fails if any decorator
  // has none — which is what a matcher that cannot parse a handler's shape looks like from outside.
  it('examines every decorated handler, so a clean result means the whole surface', () => {
    const modulesDir = join(__dirname, '..');
    const blind: string[] = [];
    let decorated = 0;
    for (const file of listControllerFiles(modulesDir)) {
      const source = readFileSync(file, 'utf8');
      const decorators = [...source.matchAll(/^ {2}@(?:Get|Post|Put|Patch|Delete|All|Head|Options)\(/gm)];
      const methods = [...source.matchAll(methodPattern())].map(m => m.index ?? 0);
      for (let i = 0; i < decorators.length; i++) {
        decorated++;
        const from = decorators[i].index ?? 0;
        const until = decorators[i + 1]?.index ?? Number.MAX_SAFE_INTEGER;
        // The handler a decorator belongs to is the first method starting before the next decorator.
        if (methods.some(at => at > from && at < until)) continue;
        blind.push(
          `${file.replace(/.*\/src\//, 'src/')} :: ${source
            .slice(from, from + 40)
            .split('\n')[0]
            .trim()}`,
        );
      }
    }
    expect(decorated).toBeGreaterThan(100); // the count itself must not silently collapse to zero
    expect(blind).toEqual([]);
  });

  it('no real controller takes a session id from its query or body without scoping to the calling key', () => {
    const modulesDir = join(__dirname, '..');
    const sessionDtos = sessionScopedDtos(listSourceFiles(modulesDir).map(f => readFileSync(f, 'utf8')));
    // The DTO scan must see the one real request DTO carrying sessionId, or it checks nothing.
    expect(sessionDtos.has('SearchQueryDto')).toBe(true);
    const offenders: string[] = [];
    for (const file of listControllerFiles(modulesDir)) {
      for (const handler of handlersMissingSessionScope(readFileSync(file, 'utf8'), sessionDtos)) {
        offenders.push(`${file.replace(/.*\/src\//, 'src/')} :: ${handler}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
