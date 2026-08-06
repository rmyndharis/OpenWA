import { seedConfigDefaults } from './config-defaults.util';

describe('seedConfigDefaults', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      timezone: { type: 'string' as const, default: 'UTC' },
      cooldownSec: { type: 'number' as const, default: 3600 },
      schedule: { type: 'object' as const, required: true }, // no default — must stay absent
      rules: { type: 'array' as const, default: [{ q: 'hi', a: 'hello' }] },
    },
  };

  it('seeds schema defaults for absent keys only', () => {
    const out = seedConfigDefaults(schema, { timezone: 'Asia/Jakarta' });
    expect(out).toEqual({
      timezone: 'Asia/Jakarta', // explicit value wins
      cooldownSec: 3600,
      rules: [{ q: 'hi', a: 'hello' }],
    });
    expect(out).not.toHaveProperty('schedule'); // required-without-default is never invented
  });

  it('returns the input unchanged when nothing is missing (and no schema)', () => {
    const config = { timezone: 'UTC', cooldownSec: 1, rules: [] };
    expect(seedConfigDefaults(schema, config)).toBe(config);
    expect(seedConfigDefaults(undefined, config)).toBe(config);
  });

  it('deep-clones object/array defaults so runtime and persisted copies cannot share references', () => {
    const out = seedConfigDefaults(schema, {});
    const again = seedConfigDefaults(schema, {});
    expect(out.rules).toEqual(again.rules);
    expect(out.rules).not.toBe(again.rules);
    expect((out.rules as unknown[])[0]).not.toBe((again.rules as unknown[])[0]);
  });

  it('null is an explicit value and is not overwritten by the default', () => {
    const out = seedConfigDefaults(schema, { timezone: null });
    expect(out.timezone).toBeNull();
  });
});
