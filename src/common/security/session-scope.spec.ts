import { resolveSessionScope, sessionScopeVisible } from './session-scope';

// The key's allowedSessions is authoritative: a query-supplied sessionId may only NARROW within it,
// never broaden it. null = "no filter (see all)"; [] = "requested session outside scope, see nothing".
describe('resolveSessionScope', () => {
  it('unrestricted key (null/empty/undefined allowlist) with no requested session => no filter', () => {
    expect(resolveSessionScope(null)).toBeNull();
    expect(resolveSessionScope([])).toBeNull();
    expect(resolveSessionScope(undefined)).toBeNull();
  });

  it('unrestricted key narrows to the requested session', () => {
    expect(resolveSessionScope(null, 'X')).toEqual(['X']);
    expect(resolveSessionScope([], 'X')).toEqual(['X']);
  });

  it('scoped key with no requested session => the whole allowlist', () => {
    expect(resolveSessionScope(['A', 'B'])).toEqual(['A', 'B']);
  });

  it('scoped key narrows to a requested session that is inside its allowlist', () => {
    expect(resolveSessionScope(['A', 'B'], 'A')).toEqual(['A']);
  });

  it('scoped key requesting a session OUTSIDE its allowlist => empty (match nothing), not the request', () => {
    expect(resolveSessionScope(['A', 'B'], 'C')).toEqual([]);
  });
});

// sessionScopeVisible fences resources whose session binding travels in a body field or a persisted
// row (plugin instances), which the guard's route-param fence cannot reach. null/'*' = all sessions.
describe('sessionScopeVisible', () => {
  it('unrestricted key (null/empty/undefined allowlist) sees every scope', () => {
    expect(sessionScopeVisible(null, 'A')).toBe(true);
    expect(sessionScopeVisible([], 'A')).toBe(true);
    expect(sessionScopeVisible(undefined, null)).toBe(true);
    expect(sessionScopeVisible(null, null)).toBe(true);
    expect(sessionScopeVisible(null, '*')).toBe(true);
  });

  it('scoped key sees resources bound to one of its own sessions only', () => {
    expect(sessionScopeVisible(['A', 'B'], 'A')).toBe(true);
    expect(sessionScopeVisible(['A', 'B'], 'C')).toBe(false);
  });

  it('scoped key never sees the all-sessions scope (null/undefined/*)', () => {
    expect(sessionScopeVisible(['A'], null)).toBe(false);
    expect(sessionScopeVisible(['A'], undefined)).toBe(false);
    expect(sessionScopeVisible(['A'], '*')).toBe(false);
  });
});
