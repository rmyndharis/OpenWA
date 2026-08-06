// Structural guard for the global-route authorization class of bug.
//
// The ApiKeyGuard resolves the scoped sessionId from ROUTE PARAMS only (api-key.guard.ts), and
// auth.service.ts short-circuits its allowedSessions check when no session id is present. So a route
// with NO session dimension admits a session-restricted key by default — the model is fail-open.
// The fence for those routes is @RequireUnscopedKey (auth.decorators.ts).
//
// This test fails when a controller handler is deployment-global (no :sessionId route param, not on
// a @SessionScoped controller) and carries neither @RequireUnscopedKey, @Public, nor an entry in
// ALLOWLIST below — so a future endpoint cannot silently re-introduce the gap.
import { readdirSync, readFileSync } from 'fs';
import { basename, join, sep } from 'path';

/**
 * Handlers that are deliberately global AND deliberately reachable by a session-restricted key,
 * because they enforce the key's scope themselves in the handler or the service beneath it.
 * Key format: `<controller file basename> :: <handler name>`. Every entry needs a reason.
 */
const ALLOWLIST = new Map<string, string>([
  ['audit.controller.ts :: findAll', 'scope-filters rows via resolveSessionScope'],
  ['webhooks-list.controller.ts :: findAll', 'scope-filters rows via the calling key'],
  ['webhooks-list.controller.ts :: deliveryFailures', 'scope-filters rows via the calling key'],
  ['search.controller.ts :: search', 'scope-filters results via the calling key'],
  ['session.controller.ts :: findAll', 'scope-filters sessions to the key allowlist'],
  ['session.controller.ts :: getStats', 'scope-filters the aggregate to apiKey.allowedSessions in the service'],
  // Integration instances live under :pluginId/:instanceId (not a session param), so the guard's
  // route-param fence cannot reach them. Every handler below re-scopes itself against the calling
  // key: reads resolve via sessionScopeVisible (out-of-scope ⇒ 404), writes via assertScopeWritable.
  ['integration-instance.controller.ts :: list', 'filters rows with sessionScopeVisible'],
  ['integration-instance.controller.ts :: getOne', 'resolveVisible() ⇒ 404 outside the key scope'],
  ['integration-instance.controller.ts :: create', 'assertScopeWritable(apiKey, sessionScope) before persisting'],
  ['integration-instance.controller.ts :: regenerate', 'resolveVisible() ⇒ 404 outside the key scope'],
  ['integration-instance.controller.ts :: patch', 'resolveVisible() + assertScopeWritable before any write'],
  ['integration-instance.controller.ts :: remove', 'resolveVisible() ⇒ 404 outside the key scope'],
  ['redrive.controller.ts :: redriveInstance', 'fails closed for scoped keys: missing/out-of-scope instance ⇒ 404'],
  // Self-validation only: the route returns {valid, role} for the calling key and reads/writes no
  // resource, so a session-restricted key validating itself is harmless (it cannot broaden scope).
  ['auth-validate.controller.ts :: validate', 'self-validation of the calling key; no resource access'],
]);

/**
 * Return the names of handlers in `source` that look deployment-global but carry no fence.
 * A handler is considered fenced when it (or its class) has @RequireUnscopedKey or @Public, and
 * session-dimensioned when it declares a `:sessionId` route param or the class is @SessionScoped.
 */
export function handlersMissingGlobalFence(source: string): string[] {
  const beforeClass = source.split('export class')[0] ?? '';
  const classIsSessionScoped = /@SessionScoped\(\)/.test(beforeClass);
  const classIsFenced = /@RequireUnscopedKey\(\)/.test(beforeClass);
  const classIsPublic = /@Public\(\)/.test(beforeClass);
  // A :sessionId in the class-level @Controller(...) prefix (e.g. @Controller('sessions/:sessionId/messages'))
  // gives EVERY handler on the controller a session dimension the guard scopes against — the per-session
  // resource controllers (messages, contacts, groups, …) all use this shape, not a per-handler param.
  const classHasSessionDimension = /@Controller\([^)]*:sessionId/.test(beforeClass);
  if (classIsFenced || classIsPublic || classHasSessionDimension) return [];

  const offenders: string[] = [];
  // Capture each handler's decorator block plus its method name. Decorators are the contiguous run of
  // `@...` lines immediately preceding an indented method declaration. Any indentation depth matches —
  // a handler indented by something other than two spaces is still a route the fence decision covers.
  const handlerRe = /((?:^ +@[\s\S]*?)?)^ +(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/gm;
  for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
    const [, decorators, name] = m;
    if (name === 'constructor') continue;
    // Only HTTP handlers matter; a private helper has no route decorator. @All, @Sse and @Head bind
    // routes too, so a handler using one is still an endpoint the fence decision applies to.
    if (!/@(Get|Post|Put|Patch|Delete|All|Sse|Head)\(/.test(decorators)) continue;
    if (/@Public\(\)/.test(decorators)) continue;
    if (/@RequireUnscopedKey\(\)/.test(decorators)) continue;
    // A :sessionId route param gives the guard something to scope against.
    if (/@(Get|Post|Put|Patch|Delete|All|Sse|Head)\([^)]*:sessionId/.test(decorators)) continue;
    // On a @SessionScoped controller the bare `:id` param is a session id, so it is scoped too.
    if (classIsSessionScoped && /@(Get|Post|Put|Patch|Delete|All|Sse|Head)\([^)]*:id/.test(decorators)) continue;
    offenders.push(name);
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

describe('deployment-global routes are fenced against session-restricted keys', () => {
  // The checker itself must actually detect the gap — a structural guard that cannot fail proves nothing.
  it('flags a global handler with no fence', () => {
    const vulnerable = `
export class ThingController {
  @Get('everything')
  @RequireRole(ApiKeyRole.ADMIN)
  findAll(): string[] {
    return [];
  }
}
`;
    expect(handlersMissingGlobalFence(vulnerable)).toEqual(['findAll']);
  });

  it('flags an @All handler with no fence', () => {
    const vulnerable = `
export class ThingController {
  @All('everything')
  @RequireRole(ApiKeyRole.ADMIN)
  handleAll(): string[] {
    return [];
  }
}
`;
    expect(handlersMissingGlobalFence(vulnerable)).toEqual(['handleAll']);
  });

  it('flags a handler indented deeper than two spaces', () => {
    const vulnerable = `
export class ThingController {
    @Get('everything')
    @RequireRole(ApiKeyRole.ADMIN)
    findAll(): string[] {
        return [];
    }
}
`;
    expect(handlersMissingGlobalFence(vulnerable)).toEqual(['findAll']);
  });

  it('clears a handler carrying the fence', () => {
    const fixed = `
export class ThingController {
  @Get('everything')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  findAll(): string[] {
    return [];
  }
}
`;
    expect(handlersMissingGlobalFence(fixed)).toEqual([]);
  });

  it('clears a handler scoped by a :sessionId route param', () => {
    const scoped = `
export class ThingController {
  @Get('sessions/:sessionId/things')
  findForSession(): string[] {
    return [];
  }
}
`;
    expect(handlersMissingGlobalFence(scoped)).toEqual([]);
  });

  it('clears every handler on a class-level fenced controller', () => {
    const fenced = `
@Controller('infra')
@RequireUnscopedKey()
export class InfraController {
  @Get('everything')
  findAll(): string[] {
    return [];
  }
}
`;
    expect(handlersMissingGlobalFence(fenced)).toEqual([]);
  });

  it('clears a public handler', () => {
    const open = `
export class ThingController {
  @Get('health')
  @Public()
  health(): string {
    return 'ok';
  }
}
`;
    expect(handlersMissingGlobalFence(open)).toEqual([]);
  });

  it('no real controller exposes an unfenced deployment-global route', () => {
    const modulesDir = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of listControllerFiles(modulesDir)) {
      // Derive the file name through `path`, and normalize separators before matching: `join()`
      // yields backslashes on Windows, so splitting on '/' left the whole path as the "basename",
      // no ALLOWLIST key ever matched, and every allowlisted controller was reported as an offender.
      const fileName = basename(file);
      const posixPath = file.split(sep).join('/');
      for (const handler of handlersMissingGlobalFence(readFileSync(file, 'utf8'))) {
        const key = `${fileName} :: ${handler}`;
        if (ALLOWLIST.has(key)) continue;
        offenders.push(`${posixPath.replace(/.*\/src\//, 'src/')} :: ${handler}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
