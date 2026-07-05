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

  it('fails closed and masks every value when there is no schema (cannot tell which fields are secret)', () => {
    const cfg = { apiKey: 's3cr3t', endpoint: 'https://x' };
    const out = redactSecretConfig(cfg, undefined);
    expect(out).toEqual({ apiKey: SECRET_SENTINEL, endpoint: SECRET_SENTINEL });
    expect(out).not.toBe(cfg); // copy, not the same ref
  });

  it('round-trips a schemaless config: sentinel values restore the stored value, edited values persist', () => {
    const masked = redactSecretConfig({ apiKey: 's3cr3t', region: 'us' }, undefined);
    const restored = restoreSecretConfig({ ...masked, region: 'eu' }, { apiKey: 's3cr3t', region: 'us' }, undefined);
    expect(restored).toEqual({ apiKey: 's3cr3t', region: 'eu' });
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

  it('restores per-row array-of-rows secrets, keeping genuinely-new ones', () => {
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

  // Rows are matched to the stored secret by their non-secret content, NOT by array index — so
  // adding/removing/reordering a row can never bind a sentinel to a different row's stored secret.
  it('restores by content after a row is removed (no positional drift)', () => {
    expect(
      restoreSecretConfig(
        { endpoints: [{ url: 'b', token: SECRET_SENTINEL }] },
        {
          endpoints: [
            { url: 'a', token: 'real_a' },
            { url: 'b', token: 'real_b' },
          ],
        },
        nestedSchema,
      ),
    ).toEqual({ endpoints: [{ url: 'b', token: 'real_b' }] });
  });

  it('restores by content after rows are reordered', () => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'b', token: SECRET_SENTINEL },
            { url: 'a', token: SECRET_SENTINEL },
          ],
        },
        {
          endpoints: [
            { url: 'a', token: 'real_a' },
            { url: 'b', token: 'real_b' },
          ],
        },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'b', token: 'real_b' },
        { url: 'a', token: 'real_a' },
      ],
    });
  });

  it('does not mis-target a secret onto a newly-inserted row', () => {
    // New row "NEW" has no stored counterpart → its sentinel is dropped (not filled with a's secret);
    // existing row "a" keeps its own secret regardless of the index shift.
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'NEW', token: SECRET_SENTINEL },
            { url: 'a', token: SECRET_SENTINEL },
          ],
        },
        { endpoints: [{ url: 'a', token: 'real1' }] },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [{ url: 'NEW' }, { url: 'a', token: 'real1' }],
    });
  });

  // A row's signature is the row with its secret masked, so editing a NON-secret field changes the
  // signature and the content-match misses. On an in-place edit (array length unchanged) the row at
  // the same index is the same logical row, so its stored secret must be preserved — losing it on a
  // routine rename is silent data loss.
  it('keeps a row secret when only its non-secret field changed (same length)', () => {
    expect(
      restoreSecretConfig(
        { endpoints: [{ url: 'a-renamed', token: SECRET_SENTINEL }] },
        { endpoints: [{ url: 'a', token: 'real' }] },
        nestedSchema,
      ),
    ).toEqual({ endpoints: [{ url: 'a-renamed', token: 'real' }] });
  });

  // Two rows with identical non-secret content collide on signature; on an unchanged round-trip both
  // secrets must survive (positional fallback), not be dropped to nothing.
  it('restores both secrets when two rows share non-secret content (no-op round-trip)', () => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: SECRET_SENTINEL },
            { url: 'a', token: SECRET_SENTINEL },
          ],
        },
        {
          endpoints: [
            { url: 'a', token: 'real1' },
            { url: 'a', token: 'real2' },
          ],
        },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'a', token: 'real1' },
        { url: 'a', token: 'real2' },
      ],
    });
  });
});

// An array whose ITEMS are scalar secrets (e.g. a list of API keys) — every masked element shares the
// signature "***", so content-matching is impossible and restore must align by position. A no-op
// round-trip or an in-place edit must never wipe the stored secrets to null.
const scalarSecretArraySchema: PluginConfigSchema = {
  type: 'object',
  properties: {
    keys: { type: 'array', items: { type: 'string', secret: true } },
  },
};

describe('restoreSecretConfig (scalar-secret array)', () => {
  it('restores every secret on an unchanged round-trip (no null pollution)', () => {
    expect(
      restoreSecretConfig(
        { keys: [SECRET_SENTINEL, SECRET_SENTINEL] },
        { keys: ['k1', 'k2'] },
        scalarSecretArraySchema,
      ),
    ).toEqual({ keys: ['k1', 'k2'] });
  });

  it('keeps a genuinely-new secret element while restoring the unchanged ones', () => {
    expect(
      restoreSecretConfig({ keys: [SECRET_SENTINEL, 'brand-new'] }, { keys: ['k1', 'k2'] }, scalarSecretArraySchema),
    ).toEqual({ keys: ['k1', 'brand-new'] });
  });

  it('drops a sentinel element that has nothing stored to keep (no null in the array)', () => {
    expect(restoreSecretConfig({ keys: [SECRET_SENTINEL] }, { keys: [] }, scalarSecretArraySchema)).toEqual({
      keys: [],
    });
  });

  it('preserves stored secrets when a new key is appended (length grows)', () => {
    expect(
      restoreSecretConfig(
        { keys: [SECRET_SENTINEL, SECRET_SENTINEL, SECRET_SENTINEL, 'brand-new'] },
        { keys: ['k1', 'k2', 'k3'] },
        scalarSecretArraySchema,
      ),
    ).toEqual({ keys: ['k1', 'k2', 'k3', 'brand-new'] });
  });

  it('preserves stored secrets when a blank trailing entry is appended (the blank is dropped)', () => {
    expect(
      restoreSecretConfig(
        { keys: [SECRET_SENTINEL, SECRET_SENTINEL, SECRET_SENTINEL, ''] },
        { keys: ['k1', 'k2', 'k3'] },
        scalarSecretArraySchema,
      ),
    ).toEqual({ keys: ['k1', 'k2', 'k3'] });
  });

  it('preserves the remaining stored secrets when the last key is removed (length shrinks)', () => {
    expect(
      restoreSecretConfig(
        { keys: [SECRET_SENTINEL, SECRET_SENTINEL] },
        { keys: ['k1', 'k2', 'k3'] },
        scalarSecretArraySchema,
      ),
    ).toEqual({ keys: ['k1', 'k2'] });
  });
});

// A composite field (object/array) that is itself marked secret:true must be masked as ONE unit on
// read and restored as a unit on write — recursing would leak its non-secret children in plaintext.
const compositeSecretSchema: PluginConfigSchema = {
  type: 'object',
  properties: {
    creds: { type: 'object', secret: true, properties: { user: { type: 'string' }, pass: { type: 'string' } } },
    keys: { type: 'array', secret: true, items: { type: 'string' } },
  },
};

describe('redactSecretConfig (composite secret field)', () => {
  it('masks a whole secret object so its children never leak', () => {
    expect(redactSecretConfig({ creds: { user: 'u', pass: 'p' } }, compositeSecretSchema)).toEqual({
      creds: SECRET_SENTINEL,
    });
  });

  it('masks a whole secret array so its entries never leak', () => {
    expect(redactSecretConfig({ keys: ['k1', 'k2'] }, compositeSecretSchema)).toEqual({ keys: SECRET_SENTINEL });
  });
});

describe('restoreSecretConfig (composite secret field)', () => {
  it('restores a secret object from the sentinel instead of clobbering it', () => {
    expect(
      restoreSecretConfig({ creds: SECRET_SENTINEL }, { creds: { user: 'u', pass: 'p' } }, compositeSecretSchema),
    ).toEqual({ creds: { user: 'u', pass: 'p' } });
  });

  it('restores a secret array from the sentinel', () => {
    expect(restoreSecretConfig({ keys: SECRET_SENTINEL }, { keys: ['k1', 'k2'] }, compositeSecretSchema)).toEqual({
      keys: ['k1', 'k2'],
    });
  });

  it('stores a genuinely-new secret object as a unit', () => {
    expect(
      restoreSecretConfig(
        { creds: { user: 'x', pass: 'y' } },
        { creds: { user: 'u', pass: 'p' } },
        compositeSecretSchema,
      ),
    ).toEqual({ creds: { user: 'x', pass: 'y' } });
  });

  it('drops a sentinel secret object when there is nothing stored', () => {
    expect(restoreSecretConfig({ creds: SECRET_SENTINEL }, {}, compositeSecretSchema)).not.toHaveProperty('creds');
  });
});
