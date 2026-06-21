import { validateEnv } from './env.validation';

/** Regression locks for boot-time env validation (no silent coercion). */
describe('validateEnv', () => {
  it('passes the zero-config default (sqlite, no pg vars)', () => {
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite' })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects a DATABASE_TYPE typo instead of silently falling back to SQLite', () => {
    expect(() => validateEnv({ DATABASE_TYPE: 'postgre' })).toThrow(/DATABASE_TYPE/);
  });

  it('requires host/username/password when DATABASE_TYPE=postgres', () => {
    expect(() => validateEnv({ DATABASE_TYPE: 'postgres' })).toThrow(/DATABASE_PASSWORD/);
    expect(() =>
      validateEnv({ DATABASE_TYPE: 'postgres', DATABASE_HOST: 'db', DATABASE_USERNAME: 'u', DATABASE_PASSWORD: 'p' }),
    ).not.toThrow();
  });

  it('rejects a non-integer / out-of-range port', () => {
    expect(() => validateEnv({ DATABASE_PORT: 'abc' })).toThrow(/DATABASE_PORT/);
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ PORT: '2785' })).not.toThrow();
  });

  it('rejects an ENGINE_TYPE typo instead of silently falling back to whatsapp-web.js', () => {
    expect(() => validateEnv({ ENGINE_TYPE: 'bailys' })).toThrow(/ENGINE_TYPE/);
    expect(() => validateEnv({ ENGINE_TYPE: 'whatsapp-web.js' })).not.toThrow();
    expect(() => validateEnv({ ENGINE_TYPE: 'baileys' })).not.toThrow();
  });

  it('rejects a STORAGE_TYPE typo instead of silently falling back to local', () => {
    expect(() => validateEnv({ STORAGE_TYPE: 'ss' })).toThrow(/STORAGE_TYPE/);
    expect(() => validateEnv({ STORAGE_TYPE: 'local' })).not.toThrow();
    expect(() => validateEnv({ STORAGE_TYPE: 's3' })).not.toThrow();
  });

  it('rejects a non-integer rate-limit / webhook / pool-size value (a NaN silently disables throttling)', () => {
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: 'abc' })).toThrow(/RATE_LIMIT_SHORT_LIMIT/);
    expect(() => validateEnv({ WEBHOOK_TIMEOUT: '10s' })).toThrow(/WEBHOOK_TIMEOUT/);
    expect(() => validateEnv({ DATABASE_POOL_SIZE: '1.5' })).toThrow(/DATABASE_POOL_SIZE/);
    expect(() => validateEnv({ RATE_LIMIT_LONG_TTL: '-5' })).toThrow(/RATE_LIMIT_LONG_TTL/);
    // valid integers (and unset) still pass
    expect(() =>
      validateEnv({ RATE_LIMIT_SHORT_LIMIT: '10', WEBHOOK_TIMEOUT: '10000', DATABASE_POOL_SIZE: '10' }),
    ).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects a sqlite data DB path that collides with the internal main database file', () => {
    // The 'main' (auth/audit) and 'data' connections must be separate SQLite files; sharing one
    // file means two migration ledgers + synchronize policies on the same tables.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: './data/main.sqlite' })).toThrow(
      /DATABASE_NAME/,
    );
    // Relative spellings of the same file are caught (path normalization).
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: './data/../data/main.sqlite' })).toThrow(
      /DATABASE_NAME/,
    );
    // The default data path is fine.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: './data/openwa.sqlite' })).not.toThrow();
    // Postgres uses a bare DB name, never a file path — must not false-positive.
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'db',
        DATABASE_USERNAME: 'u',
        DATABASE_PASSWORD: 'p',
        DATABASE_NAME: 'main.sqlite',
      }),
    ).not.toThrow();
  });
});
