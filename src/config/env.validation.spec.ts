import { envValidationSchema } from './env.validation';

/**
 * Tier 4 — cluster mode env validation.
 *
 * CLUSTER_ENABLED is the master gate for horizontal-scale features. When it is
 * on, SQLite (better-sqlite3, single-writer, file-local) is no longer a valid
 * data store — the schema must reject it at bootstrap (C5).
 */
describe('envValidationSchema — cluster mode', () => {
  it('defaults CLUSTER_ENABLED to false and leaves sqlite valid', () => {
    const { error, value } = envValidationSchema.validate({});
    expect(error).toBeUndefined();
    expect(value.CLUSTER_ENABLED).toBe(false);
    expect(value.DATABASE_TYPE).toBe('sqlite');
  });

  it('coerces CLUSTER_ENABLED from the string "true"', () => {
    const { error, value } = envValidationSchema.validate({
      CLUSTER_ENABLED: 'true',
      DATABASE_TYPE: 'postgres',
      DATABASE_USERNAME: 'openwa',
      DATABASE_PASSWORD: 'secret',
    });
    expect(error).toBeUndefined();
    expect(value.CLUSTER_ENABLED).toBe(true);
  });

  it('rejects sqlite when CLUSTER_ENABLED is true (C5)', () => {
    const { error } = envValidationSchema.validate({
      CLUSTER_ENABLED: 'true',
      DATABASE_TYPE: 'sqlite',
    });
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/DATABASE_TYPE/);
  });

  it('accepts postgres when CLUSTER_ENABLED is true', () => {
    const { error, value } = envValidationSchema.validate({
      CLUSTER_ENABLED: 'true',
      DATABASE_TYPE: 'postgres',
      DATABASE_USERNAME: 'openwa',
      DATABASE_PASSWORD: 'secret',
    });
    expect(error).toBeUndefined();
    expect(value.DATABASE_TYPE).toBe('postgres');
  });

  it('defaults the ownership TTL to 30 seconds', () => {
    const { value } = envValidationSchema.validate({});
    expect(value.CLUSTER_OWNERSHIP_TTL).toBe(30);
  });
});
