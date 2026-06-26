import { isPluginActiveForSession, resolvePluginConfig } from './plugin-activation';

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

describe('resolvePluginConfig', () => {
  const base = { greeting: 'hi', lang: 'en', timeoutMs: 4000 };

  it('returns the base config when there is no per-session override', () => {
    expect(resolvePluginConfig(base, undefined, 'sess-1', true)).toEqual(base);
    expect(resolvePluginConfig(base, {}, 'sess-1', true)).toEqual(base);
    expect(resolvePluginConfig(base, { 'other-sess': { lang: 'he' } }, 'sess-1', true)).toEqual(base);
  });

  it('shallow-merges the session override over the base (override wins per top-level key)', () => {
    expect(resolvePluginConfig(base, { 'sess-1': { lang: 'he', extra: true } }, 'sess-1', true)).toEqual({
      greeting: 'hi',
      lang: 'he',
      timeoutMs: 4000,
      extra: true,
    });
  });

  it('deep-merges a nested object override, inheriting untouched nested keys (e.g. a nested secret)', () => {
    const b = { smtp: { host: 'mail.x', password: 'real' }, lang: 'en' };
    const sc = { 'sess-1': { smtp: { host: 'mail.y' } } };
    expect(resolvePluginConfig(b, sc, 'sess-1', true)).toEqual({
      smtp: { host: 'mail.y', password: 'real' },
      lang: 'en',
    });
  });

  it('replaces arrays wholesale on override (no element-wise merge)', () => {
    const b = { items: [1, 2, 3] };
    const sc = { 'sess-1': { items: [9] } };
    expect(resolvePluginConfig(b, sc, 'sess-1', true)).toEqual({ items: [9] });
  });

  it('ignores overrides for a global (non-session-scoped) plugin', () => {
    expect(resolvePluginConfig(base, { 'sess-1': { lang: 'he' } }, 'sess-1', false)).toEqual(base);
  });

  it('ignores overrides for a non-session-attributed event (no sessionId)', () => {
    expect(resolvePluginConfig(base, { 'sess-1': { lang: 'he' } }, undefined, true)).toEqual(base);
  });

  it('does not mutate the base or the override', () => {
    const b = { a: 1 };
    const sc = { 'sess-1': { a: 2 } };
    const out = resolvePluginConfig(b, sc, 'sess-1', true);
    expect(out).toEqual({ a: 2 });
    expect(b).toEqual({ a: 1 });
    expect(sc).toEqual({ 'sess-1': { a: 2 } });
  });
});
