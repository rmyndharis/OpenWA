import { SECRET_SENTINEL, redactSecretConfig, restoreSecretConfig } from './redact-config';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

// plugin config (incl. fields a plugin marks `secret`, e.g. an API key) was returned
// verbatim by the GET routes, readable by any key. Redact on read; restore on write so the
// dashboard PUTting the masked value back doesn't overwrite the real secret.
const schema: PluginConfigSchema = {
  type: 'object',
  properties: {
    apiKey: { type: 'string', secret: true },
    endpoint: { type: 'string' },
  },
};

describe('redactSecretConfig', () => {
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

describe('restoreSecretConfig', () => {
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

// v0.7 richer schema: secrets can live inside a nested object or in each row of an array-of-rows,
// so redaction (read) and restoration (write) must recurse — else a nested secret leaks via GET, or
// gets clobbered by the mask on the round-trip PUT.
const nestedSchema: PluginConfigSchema = {
  type: 'object',
  properties: {
    provider: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', secret: true },
        region: { type: 'string' },
      },
    },
    endpoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          token: { type: 'string', secret: true },
        },
      },
    },
  },
};

describe('redactSecretConfig (nested)', () => {
  it('masks a secret nested inside an object', () => {
    expect(redactSecretConfig({ provider: { apiKey: 'k', region: 'us' } }, nestedSchema)).toEqual({
      provider: { apiKey: SECRET_SENTINEL, region: 'us' },
    });
  });

  it('masks a secret sub-field in every row of an array-of-rows (leaving empty ones untouched)', () => {
    expect(
      redactSecretConfig(
        {
          endpoints: [
            { url: 'a', token: 't1' },
            { url: 'b', token: '' },
          ],
        },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'a', token: SECRET_SENTINEL },
        { url: 'b', token: '' },
      ],
    });
  });
});

describe('restoreSecretConfig (nested)', () => {
  it('restores a nested-object secret when the incoming value is the sentinel', () => {
    expect(
      restoreSecretConfig(
        { provider: { apiKey: SECRET_SENTINEL, region: 'eu' } },
        { provider: { apiKey: 'real', region: 'us' } },
        nestedSchema,
      ),
    ).toEqual({ provider: { apiKey: 'real', region: 'eu' } });
  });

  it('restores per-row array-of-rows secrets by position, keeping genuinely-new ones', () => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: SECRET_SENTINEL },
            { url: 'b', token: 'new' },
          ],
        },
        {
          endpoints: [
            { url: 'a', token: 'real1' },
            { url: 'b', token: 'real2' },
          ],
        },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'a', token: 'real1' },
        { url: 'b', token: 'new' },
      ],
    });
  });
});
