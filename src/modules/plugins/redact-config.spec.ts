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

  // A retired or leaked credential has to be removable. Only an explicit null does it: a client that
  // echoes a blank for a secret it never held (a templated config with an unset variable) must not
  // wipe the stored one.
  it('removes a stored secret on an explicit null, and only on null', () => {
    const stored = { apiKey: 'real-secret', endpoint: 'https://old' };
    const merged = { mergedOverStored: true };

    // A result that replaces the stored config just loses the key.
    expect(restoreSecretConfig({ apiKey: null, endpoint: 'https://new' }, stored, schema)).toEqual({
      endpoint: 'https://new',
    });
    // One that is merged over it has to carry the null, or the merge would put the stored value back.
    expect(restoreSecretConfig({ apiKey: null, endpoint: 'https://new' }, stored, schema, merged)).toEqual({
      apiKey: null,
      endpoint: 'https://new',
    });
    for (const options of [{}, merged]) {
      expect(restoreSecretConfig({ apiKey: '' }, stored, schema, options)).toEqual({ apiKey: 'real-secret' });
      expect(restoreSecretConfig({ apiKey: SECRET_SENTINEL }, stored, schema, options)).toEqual({
        apiKey: 'real-secret',
      });
      expect(restoreSecretConfig({ endpoint: 'https://new' }, stored, schema, options)).toEqual({
        endpoint: 'https://new',
      });
    }
  });

  it('drops a null secret when nothing is stored, rather than persisting a null', () => {
    for (const options of [{}, { mergedOverStored: true }]) {
      expect(restoreSecretConfig({ apiKey: null }, {}, schema, options)).not.toHaveProperty('apiKey');
      expect(restoreSecretConfig({ apiKey: null }, undefined, schema, options)).not.toHaveProperty('apiKey');
    }
  });

  it('leaves a null in a non-secret field to the ordinary merge', () => {
    expect(restoreSecretConfig({ endpoint: null }, { endpoint: 'https://old' }, schema)).toEqual({ endpoint: null });
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

  // The nested object replaces the stored one whole, even where the top level is merged over the stored
  // config, so dropping the key is what removes the secret.
  it('removes a nested-object secret on an explicit null and keeps its sibling', () => {
    for (const options of [{}, { mergedOverStored: true }]) {
      expect(
        restoreSecretConfig(
          { provider: { apiKey: null, region: 'eu' } },
          { provider: { apiKey: 'real', region: 'us' } },
          nestedSchema,
          options,
        ),
      ).toEqual({ provider: { region: 'eu' } });
    }
  });

  it('removes one row secret of an array-of-rows on an explicit null and keeps the others', () => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: null },
            { url: 'b', token: SECRET_SENTINEL },
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
      endpoints: [{ url: 'a' }, { url: 'b', token: 'real2' }],
    });
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

  // Removing ANY one key sends the same ['***','***'], so the host cannot tell which stored key went.
  // Binding by position would keep a removed (possibly revoked) key and drop a kept one: reject instead.
  it('rejects a removal that leaves masked keys it cannot tell apart', () => {
    expect(() =>
      restoreSecretConfig(
        { keys: [SECRET_SENTINEL, SECRET_SENTINEL] },
        { keys: ['k1', 'k2', 'k3'] },
        scalarSecretArraySchema,
      ),
    ).toThrow(/re-enter/);
  });

  // Adding keys in the same save grows the array, so the removal must not slip past the check.
  it('rejects a removal paired with additions that leaves masked keys it cannot tell apart', () => {
    expect(() =>
      restoreSecretConfig(
        { keys: [SECRET_SENTINEL, 'new-1', 'new-2'] },
        { keys: ['old', 'keep'] },
        scalarSecretArraySchema,
      ),
    ).toThrow(/re-enter/);
  });

  it('accepts a removal once the remaining keys are re-entered', () => {
    expect(restoreSecretConfig({ keys: ['k2', 'k3'] }, { keys: ['k1', 'k2', 'k3'] }, scalarSecretArraySchema)).toEqual({
      keys: ['k2', 'k3'],
    });
  });

  // A cleared row reaches the host as null (JSON turns the form's undefined into null inside an array).
  // As for a secret property, null is the removal and every other blank keeps the stored value. The row
  // stays in place, so the length is unchanged and the masked rows still bind by position.
  it('removes the secret of a row sent as null and keeps the others by position', () => {
    const stored = { keys: ['k1', 'k2', 'k3'] };

    for (const [incoming, expected] of [
      [
        [SECRET_SENTINEL, null, SECRET_SENTINEL],
        ['k1', 'k3'],
      ],
      [
        [null, SECRET_SENTINEL, SECRET_SENTINEL],
        ['k2', 'k3'],
      ],
      [
        [SECRET_SENTINEL, SECRET_SENTINEL, null],
        ['k1', 'k2'],
      ],
    ] as const) {
      expect(restoreSecretConfig({ keys: [...incoming] }, stored, scalarSecretArraySchema)).toEqual({
        keys: [...expected],
      });
      expect(
        restoreSecretConfig({ keys: [...incoming] }, stored, scalarSecretArraySchema, { mergedOverStored: true }),
      ).toEqual({ keys: [...expected] });
    }
  });

  it('removes every secret of a list sent as nulls, and stores a new one beside a removed one', () => {
    const stored = { keys: ['k1', 'k2'] };

    expect(restoreSecretConfig({ keys: [null, null] }, stored, scalarSecretArraySchema)).toEqual({ keys: [] });
    expect(restoreSecretConfig({ keys: [null, 'brand-new'] }, stored, scalarSecretArraySchema)).toEqual({
      keys: ['brand-new'],
    });
  });

  it('keeps the stored secret of a row sent blank, so only null removes it', () => {
    expect(
      restoreSecretConfig({ keys: [SECRET_SENTINEL, ''] }, { keys: ['k1', 'k2'] }, scalarSecretArraySchema),
    ).toEqual({ keys: ['k1', 'k2'] });
  });
});

describe('restoreSecretConfig (row removal among rows that differ only by secret)', () => {
  const stored = {
    endpoints: [
      { url: 'a', token: 't-a' },
      { url: 'a', token: 't-b' },
      { url: 'c', token: 't-c' },
    ],
  };

  it('rejects removing one of two rows whose non-secret content is identical', () => {
    expect(() =>
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: SECRET_SENTINEL },
            { url: 'c', token: SECRET_SENTINEL },
          ],
        },
        stored,
        nestedSchema,
      ),
    ).toThrow(/re-enter/);
  });

  it('still restores every secret when the removed row was the only one with its content', () => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: SECRET_SENTINEL },
            { url: 'a', token: SECRET_SENTINEL },
          ],
        },
        stored,
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'a', token: 't-a' },
        { url: 'a', token: 't-b' },
      ],
    });
  });

  // The typed row carries no mask, so it must not take a stored row's slot or shift the survivors.
  it('restores every secret when a typed row is prepended before identical masked rows', () => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: 't-z' },
            { url: 'a', token: SECRET_SENTINEL },
            { url: 'a', token: SECRET_SENTINEL },
          ],
        },
        { endpoints: stored.endpoints.slice(0, 2) },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'a', token: 't-z' },
        { url: 'a', token: 't-a' },
        { url: 'a', token: 't-b' },
      ],
    });
  });

  // The unique row sits before or between the identical ones, so every survivor shifts position.
  it.each([
    ['leading', [{ url: 'c', token: 't-c' }, ...stored.endpoints.slice(0, 2)]],
    ['middle', [stored.endpoints[0], { url: 'c', token: 't-c' }, stored.endpoints[1]]],
  ])('still restores every secret when the removed unique row was %s', (_, endpoints) => {
    expect(
      restoreSecretConfig(
        {
          endpoints: [
            { url: 'a', token: SECRET_SENTINEL },
            { url: 'a', token: SECRET_SENTINEL },
          ],
        },
        { endpoints },
        nestedSchema,
      ),
    ).toEqual({
      endpoints: [
        { url: 'a', token: 't-a' },
        { url: 'a', token: 't-b' },
      ],
    });
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
