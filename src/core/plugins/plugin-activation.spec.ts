import {
  type ConfigLayerManifest,
  isAllSessionsScope,
  isPluginActiveForSession,
  resolveInstanceConfig,
  resolvePluginConfig,
  restorableConfig,
  sessionScopeKey,
} from './plugin-activation';

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

const NO_HOSTS: ConfigLayerManifest = {};

describe('resolvePluginConfig', () => {
  const base = { greeting: 'hi', lang: 'en', timeoutMs: 4000 };

  it('returns the base config when there is no per-session override', () => {
    expect(resolvePluginConfig(base, undefined, 'sess-1', true, NO_HOSTS)).toEqual(base);
    expect(resolvePluginConfig(base, {}, 'sess-1', true, NO_HOSTS)).toEqual(base);
    expect(resolvePluginConfig(base, { 'other-sess': { lang: 'he' } }, 'sess-1', true, NO_HOSTS)).toEqual(base);
  });

  it('shallow-merges the session override over the base (override wins per top-level key)', () => {
    expect(resolvePluginConfig(base, { 'sess-1': { lang: 'he', extra: true } }, 'sess-1', true, NO_HOSTS)).toEqual({
      greeting: 'hi',
      lang: 'he',
      timeoutMs: 4000,
      extra: true,
    });
  });

  it('deep-merges a nested object override, inheriting untouched nested keys (e.g. a nested secret)', () => {
    const b = { smtp: { host: 'mail.x', password: 'real' }, lang: 'en' };
    const sc = { 'sess-1': { smtp: { host: 'mail.y' } } };
    expect(resolvePluginConfig(b, sc, 'sess-1', true, NO_HOSTS)).toEqual({
      smtp: { host: 'mail.y', password: 'real' },
      lang: 'en',
    });
  });

  it('replaces arrays wholesale on override (no element-wise merge)', () => {
    const b = { items: [1, 2, 3] };
    const sc = { 'sess-1': { items: [9] } };
    expect(resolvePluginConfig(b, sc, 'sess-1', true, NO_HOSTS)).toEqual({ items: [9] });
  });

  it('ignores overrides for a global (non-session-scoped) plugin', () => {
    expect(resolvePluginConfig(base, { 'sess-1': { lang: 'he' } }, 'sess-1', false, NO_HOSTS)).toEqual(base);
  });

  it('ignores overrides for a non-session-attributed event (no sessionId)', () => {
    expect(resolvePluginConfig(base, { 'sess-1': { lang: 'he' } }, undefined, true, NO_HOSTS)).toEqual(base);
  });

  it('does not mutate the base or the override', () => {
    const b = { a: 1 };
    const sc = { 'sess-1': { a: 2 } };
    const out = resolvePluginConfig(b, sc, 'sess-1', true, NO_HOSTS);
    expect(out).toEqual({ a: 2 });
    expect(b).toEqual({ a: 1 });
    expect(sc).toEqual({ 'sess-1': { a: 2 } });
  });
});

// An adapter that calls an operator-configured host (a Chatwoot-style base URL) with a stored token.
const adapter: ConfigLayerManifest = {
  net: { allowConfigHosts: ['baseUrl'] },
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string' },
      apiToken: { type: 'string', secret: true },
      inboxId: { type: 'string' },
      auth: {
        type: 'object',
        properties: { user: { type: 'string' }, password: { type: 'string', secret: true } },
      },
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, key: { type: 'string', secret: true } },
        },
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
};

describe('a layer that names another host than the layer beneath', () => {
  const base = {
    baseUrl: 'https://chat.example.com',
    apiToken: 'OPERATOR-TOKEN',
    inboxId: '7',
    auth: { user: 'bot', password: 'OPERATOR-PASSWORD' },
    accounts: [{ id: 'a', key: 'OPERATOR-KEY' }],
    tags: ['x'],
  };
  const resolveFor = (override: Record<string, unknown>, manifest: ConfigLayerManifest = adapter) =>
    resolvePluginConfig(base, { 'sess-1': override }, 'sess-1', true, manifest);

  it('does not inherit the declared secrets, at any depth, and keeps everything else', () => {
    expect(resolveFor({ baseUrl: 'https://attacker.example' })).toEqual({
      baseUrl: 'https://attacker.example',
      inboxId: '7',
      auth: { user: 'bot' },
      tags: ['x'],
    });
  });

  it('keeps the secrets the layer brings itself', () => {
    expect(resolveFor({ baseUrl: 'https://other.example', apiToken: 'OWN', auth: { password: 'OWN-PW' } })).toEqual({
      baseUrl: 'https://other.example',
      apiToken: 'OWN',
      inboxId: '7',
      auth: { user: 'bot', password: 'OWN-PW' },
      tags: ['x'],
    });
  });

  it('inherits them when the layer names the same origin, however it is spelled', () => {
    for (const same of ['https://chat.example.com', 'HTTPS://Chat.Example.com:443/other/path?x=1']) {
      expect(resolveFor({ baseUrl: same })).toMatchObject({ apiToken: 'OPERATOR-TOKEN', auth: base.auth });
    }
  });

  it('inherits them when the layer leaves the host key alone', () => {
    expect(resolveFor({ inboxId: '9' })).toMatchObject({ apiToken: 'OPERATOR-TOKEN', inboxId: '9' });
  });

  it('is no redirect when the host key is set to nothing', () => {
    for (const none of ['', '   ', null, undefined]) {
      expect(resolveFor({ baseUrl: none })).toMatchObject({ apiToken: 'OPERATOR-TOKEN' });
    }
  });

  // A plugin may turn a value that is no text into a URL: String(['https://x.example']) is 'https://x.example'. With no
  // origin to compare, such a value is a redirect, or a one-element list would carry the operator's token to its host.
  it('is a redirect when the host key holds a list, an object, a number or a boolean', () => {
    for (const odd of [['https://attacker.example'], { url: 'https://attacker.example' }, 5, true, []]) {
      expect(resolveFor({ baseUrl: odd })).not.toHaveProperty('apiToken');
      expect(resolveInstanceConfig(base, { baseUrl: odd }, adapter)).not.toHaveProperty('apiToken');
    }
  });

  it('counts a host named where the base names none', () => {
    expect(resolvePluginConfig({ apiToken: 'T' }, { s: { baseUrl: 'https://x.example' } }, 's', true, adapter)).toEqual(
      {
        baseUrl: 'https://x.example',
      },
    );
  });

  it('compares a value that is no URL as text', () => {
    expect(resolveFor({ baseUrl: 'chat.example.com' })).not.toHaveProperty('apiToken');
  });

  it('inherits nothing when the manifest declares no schema, as nothing can be told secret', () => {
    expect(resolveFor({ baseUrl: 'https://attacker.example' }, { net: adapter.net })).toEqual({
      baseUrl: 'https://attacker.example',
    });
  });

  it('merges as before when the manifest names no host keys', () => {
    expect(resolveFor({ baseUrl: 'https://attacker.example' }, { configSchema: adapter.configSchema })).toMatchObject({
      apiToken: 'OPERATOR-TOKEN',
    });
    expect(resolveFor({ baseUrl: 'https://attacker.example' }, { ...adapter, net: { allow: ['*'] } })).toMatchObject({
      apiToken: 'OPERATOR-TOKEN',
    });
  });

  it('does not mutate the layer beneath', () => {
    const before = JSON.stringify(base);
    resolveFor({ baseUrl: 'https://attacker.example' });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('resolveInstanceConfig', () => {
  const resolved = { baseUrl: 'https://chat.example.com', apiToken: 'OPERATOR-TOKEN', inboxId: '7' };

  it('returns what the earlier layers produced when the instance has no config', () => {
    expect(resolveInstanceConfig(resolved, null, adapter)).toBe(resolved);
    expect(resolveInstanceConfig(resolved, undefined, adapter)).toBe(resolved);
  });

  it('does not hand the secrets beneath to an instance that names another host', () => {
    expect(resolveInstanceConfig(resolved, { baseUrl: 'https://attacker.example' }, adapter)).toEqual({
      baseUrl: 'https://attacker.example',
      inboxId: '7',
    });
  });

  it('hands them to an instance that names the same host or none', () => {
    expect(resolveInstanceConfig(resolved, { baseUrl: 'https://chat.example.com/x' }, adapter)).toMatchObject({
      apiToken: 'OPERATOR-TOKEN',
    });
    expect(resolveInstanceConfig(resolved, { inboxId: '9' }, adapter)).toMatchObject({ apiToken: 'OPERATOR-TOKEN' });
  });

  it('applies on top of a session override that kept the base host', () => {
    const viaOverride = resolvePluginConfig(resolved, { s: { inboxId: '8' } }, 's', true, adapter);
    expect(viaOverride).toMatchObject({ apiToken: 'OPERATOR-TOKEN', inboxId: '8' });
    expect(resolveInstanceConfig(viaOverride, { baseUrl: 'https://attacker.example' }, adapter)).not.toHaveProperty(
      'apiToken',
    );
  });
});

// The secrets of an instance row that names no host belong to the base host it was provisioned against. A
// per-session override written by a session-restricted admin sits between the two, so it could move the host
// and the row's secrets would follow it.
describe('an instance row that names no host, over an override that moved the host', () => {
  const baseConfig = { baseUrl: 'https://chat.example.com', apiToken: 'BASE-TOKEN', inboxId: '7' };
  const row = { apiToken: 'ROW-TOKEN', inboxId: '9' };
  const resolvedWith = (override: Record<string, unknown>) =>
    resolvePluginConfig(baseConfig, { s: override }, 's', true, adapter);

  it('loses its secrets but keeps its other keys when the override moved the host', () => {
    const resolved = resolvedWith({ baseUrl: 'https://evil.example' });
    expect(resolveInstanceConfig(resolved, row, adapter, baseConfig)).toEqual({
      baseUrl: 'https://evil.example',
      inboxId: '9',
    });
  });

  it('keeps its secrets when the override left the host alone or named the same origin', () => {
    for (const override of [{ inboxId: '8' }, { baseUrl: 'https://chat.example.com/x' }]) {
      expect(resolveInstanceConfig(resolvedWith(override), row, adapter, baseConfig)).toMatchObject({
        apiToken: 'ROW-TOKEN',
      });
    }
  });

  it('keeps its secrets when it names the host itself, as they are then its own', () => {
    const resolved = resolvedWith({ baseUrl: 'https://evil.example' });
    expect(resolveInstanceConfig(resolved, { ...row, baseUrl: 'https://tenant.example' }, adapter, baseConfig)).toEqual(
      {
        baseUrl: 'https://tenant.example',
        apiToken: 'ROW-TOKEN',
        inboxId: '9',
      },
    );
  });

  // With no schema nothing can be told secret, so a row on a moved host keeps nothing, as the layers beneath it do.
  it('keeps nothing when the manifest declares no schema and the override moved the host', () => {
    const schemaless = { net: adapter.net };
    const resolved = resolvePluginConfig(baseConfig, { s: { baseUrl: 'https://evil.example' } }, 's', true, schemaless);
    expect(resolveInstanceConfig(resolved, row, schemaless, baseConfig)).toEqual({ baseUrl: 'https://evil.example' });
  });

  // A plugin may name several hosts. A row that names one of them still leaves the others to the layers beneath.
  describe('with two host keys', () => {
    const two: ConfigLayerManifest = {
      net: { allowConfigHosts: ['baseUrl', 'mediaUrl'] },
      configSchema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string' },
          mediaUrl: { type: 'string' },
          apiToken: { type: 'string', secret: true },
        },
      },
    };
    const base2 = { baseUrl: 'https://chat.example.com', mediaUrl: 'https://media.example.com', apiToken: 'BASE' };
    const row2 = { baseUrl: 'https://chat.example.com', apiToken: 'ROW-TOKEN' };

    it('withholds the secrets when an override moved a key the row leaves unset', () => {
      const resolved = resolvePluginConfig(base2, { s: { mediaUrl: 'https://evil.example' } }, 's', true, two);
      expect(resolveInstanceConfig(resolved, row2, two, base2)).not.toHaveProperty('apiToken');
    });

    it('keeps them when the override moved only a key the row names itself', () => {
      const resolved = resolvePluginConfig(base2, { s: { baseUrl: 'https://evil.example' } }, 's', true, two);
      expect(resolveInstanceConfig(resolved, row2, two, base2)).toMatchObject({
        baseUrl: 'https://chat.example.com',
        apiToken: 'ROW-TOKEN',
      });
    });
  });

  it('is unchanged when the caller gives no base', () => {
    expect(resolveInstanceConfig(resolvedWith({ baseUrl: 'https://evil.example' }), row, adapter)).toMatchObject({
      apiToken: 'ROW-TOKEN',
    });
  });
});

describe('restorableConfig: the stored layer a write may restore a masked secret from', () => {
  const stored = { baseUrl: 'https://tenant.example', apiToken: 'TENANT-TOKEN', inboxId: '3' };

  it('is the stored layer when the write keeps the host or leaves it alone', () => {
    expect(restorableConfig(stored, { baseUrl: 'HTTPS://Tenant.Example:443/x', apiToken: '***' }, adapter)).toBe(
      stored,
    );
    expect(restorableConfig(stored, { inboxId: '4', apiToken: '***' }, adapter)).toBe(stored);
    expect(restorableConfig(stored, { baseUrl: '', apiToken: '***' }, adapter)).toBe(stored);
  });

  it('holds back every stored secret when the write points the host key at another origin', () => {
    expect(restorableConfig(stored, { baseUrl: 'https://attacker.example', apiToken: '***' }, adapter)).toEqual({
      baseUrl: 'https://tenant.example',
      inboxId: '3',
    });
  });

  it('treats a host key that is no text as another origin, and a first host as one too', () => {
    expect(restorableConfig(stored, { baseUrl: ['https://attacker.example'] }, adapter)).not.toHaveProperty('apiToken');
    expect(restorableConfig({ apiToken: 'T' }, { baseUrl: 'https://x.example' }, adapter)).toEqual({});
  });

  it('holds back everything when there is no schema to tell a secret from, and has nothing to hold back without a layer', () => {
    expect(restorableConfig(stored, { baseUrl: 'https://x.example' }, { net: adapter.net })).toEqual({});
    expect(restorableConfig(undefined, { baseUrl: 'https://x.example' }, adapter)).toBeUndefined();
  });

  it('leaves a write that is no object to the caller, as it was: it clears the layer', () => {
    expect(restorableConfig(stored, null, adapter)).toBe(stored);
    expect(restorableConfig(stored, undefined, adapter)).toBe(stored);
  });

  // A layer that names no host resolves to the host beneath it, so a write that names that host moves nothing.
  // Compared with the stored layer alone it looked like a redirect and silently dropped the layer's own secret.
  describe('a stored layer that names no host is bound to the host beneath it', () => {
    const own = { apiToken: 'OWN-TOKEN', inboxId: '3' };
    const beneath = { baseUrl: 'https://cw.example' };

    it('keeps restoring when the write names that same host, however it is spelled', () => {
      for (const same of ['https://cw.example', 'https://cw.example/', 'HTTPS://CW.example:443/x']) {
        expect(restorableConfig(own, { baseUrl: same, apiToken: '***' }, adapter, beneath)).toBe(own);
      }
    });

    it('holds the secrets back when the write names another host', () => {
      expect(restorableConfig(own, { baseUrl: 'https://evil.example', apiToken: '***' }, adapter, beneath)).toEqual({
        inboxId: '3',
      });
    });

    // A stored host that is a list or blank text is not "no host": the secret was saved beside it, so a write
    // naming the base host does not get that secret back.
    it('does not treat a stored host that is a list or blank text as unset', () => {
      for (const odd of [['https://cw.example'], '', 5]) {
        const storedOdd = { baseUrl: odd, apiToken: 'OWN-TOKEN' };
        expect(
          restorableConfig(storedOdd, { baseUrl: 'https://cw.example', apiToken: '***' }, adapter, beneath),
        ).not.toHaveProperty('apiToken');
      }
    });
  });

  it('is the stored layer when the manifest names no host key', () => {
    expect(restorableConfig(stored, { baseUrl: 'https://x.example' }, { configSchema: adapter.configSchema })).toBe(
      stored,
    );
  });
});

describe('the all-sessions scope', () => {
  it.each([null, undefined, '', '*'])('is one key whichever way it is spelled (%j)', scope => {
    expect(sessionScopeKey(scope)).toBe('*');
    expect(isAllSessionsScope(scope)).toBe(true);
  });

  it('leaves a concrete session id as it is', () => {
    expect(sessionScopeKey('sess-1')).toBe('sess-1');
    expect(isAllSessionsScope('sess-1')).toBe(false);
  });
});
