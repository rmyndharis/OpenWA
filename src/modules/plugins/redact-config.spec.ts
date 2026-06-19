import { SECRET_SENTINEL, redactSecretConfig, restoreSecretConfig } from './redact-config';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

// F-13 — plugin config (incl. fields a plugin marks `secret`, e.g. an API key) was returned
// verbatim by the GET routes, readable by any key. Redact on read; restore on write so the
// dashboard PUTting the masked value back doesn't overwrite the real secret.
const schema: PluginConfigSchema = {
  type: 'object',
  properties: {
    apiKey: { type: 'string', secret: true },
    endpoint: { type: 'string' },
  },
};

describe('redactSecretConfig (F-13)', () => {
  it('masks secret-flagged non-empty values, leaves non-secret fields intact', () => {
    expect(redactSecretConfig({ apiKey: 's3cr3t', endpoint: 'https://x' }, schema)).toEqual({
      apiKey: SECRET_SENTINEL,
      endpoint: 'https://x',
    });
  });

  it('does not mask an empty/absent secret (so "***" never implies a secret that is not set)', () => {
    expect(redactSecretConfig({ apiKey: '', endpoint: 'https://x' }, schema)).toEqual({
      apiKey: '',
      endpoint: 'https://x',
    });
    expect(redactSecretConfig({ endpoint: 'https://x' }, schema)).toEqual({ endpoint: 'https://x' });
  });

  it('returns a copy unchanged when there is no schema', () => {
    const cfg = { apiKey: 's3cr3t' };
    const out = redactSecretConfig(cfg, undefined);
    expect(out).toEqual(cfg);
    expect(out).not.toBe(cfg); // copy, not the same ref
  });
});

describe('restoreSecretConfig (F-13)', () => {
  it('keeps the existing stored secret when the incoming value is the sentinel (unchanged round-trip)', () => {
    const merged = restoreSecretConfig(
      { apiKey: SECRET_SENTINEL, endpoint: 'https://new' },
      { apiKey: 'real-secret' },
      schema,
    );
    expect(merged).toEqual({ apiKey: 'real-secret', endpoint: 'https://new' });
  });

  it('stores a genuinely new secret value', () => {
    const merged = restoreSecretConfig({ apiKey: 'brand-new' }, { apiKey: 'real-secret' }, schema);
    expect(merged.apiKey).toBe('brand-new');
  });

  it('drops a sentinel/empty secret when there is nothing stored to keep', () => {
    expect(restoreSecretConfig({ apiKey: SECRET_SENTINEL }, {}, schema)).not.toHaveProperty('apiKey');
    expect(restoreSecretConfig({ apiKey: '' }, undefined, schema)).not.toHaveProperty('apiKey');
  });
});
