import { isPluginActiveForSession } from './plugin-activation';

describe('isPluginActiveForSession', () => {
  it('a global (non-session-scoped) plugin is always active', () => {
    expect(isPluginActiveForSession(false, [], 'sess-1')).toBe(true);
    expect(isPluginActiveForSession(false, ['other'], 'sess-1')).toBe(true);
  });

  it("a session-scoped plugin with ['*'] is active for any session", () => {
    expect(isPluginActiveForSession(true, ['*'], 'sess-1')).toBe(true);
    expect(isPluginActiveForSession(true, ['*'], 'sess-2')).toBe(true);
  });

  it('a session-scoped plugin is active only for sessions in its list', () => {
    expect(isPluginActiveForSession(true, ['sess-1', 'sess-2'], 'sess-1')).toBe(true);
    expect(isPluginActiveForSession(true, ['sess-1', 'sess-2'], 'sess-3')).toBe(false);
  });

  it('an empty active list means active for no session', () => {
    expect(isPluginActiveForSession(true, [], 'sess-1')).toBe(false);
  });

  it('a non-session-attributed event (no sessionId) is not gated', () => {
    expect(isPluginActiveForSession(true, [], undefined)).toBe(true);
  });
});
