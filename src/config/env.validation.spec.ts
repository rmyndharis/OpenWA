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

  it('validates POSTGRES_SCHEMA as a legal, non-reserved Postgres identifier when set', () => {
    const pg = { DATABASE_TYPE: 'postgres', DATABASE_HOST: 'db', DATABASE_USERNAME: 'u', DATABASE_PASSWORD: 'p' };
    // unset / 'public' (default) and ordinary identifiers are fine
    expect(() => validateEnv({ ...pg })).not.toThrow();
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'public' })).not.toThrow();
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'openwa' })).not.toThrow();
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'my_app_2' })).not.toThrow();
    // invalid identifier characters (would reach CREATE TABLE "<schema>"."..." or a search_path SET)
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'openwa; DROP' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: '1bad' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'has space' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'a.b' })).toThrow(/POSTGRES_SCHEMA/);
    // reserved pg_ prefix rejected (case-insensitive)
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'pg_catalog' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'Pg_temp' })).toThrow(/POSTGRES_SCHEMA/);
    // ignored for sqlite: a bogus value must NOT trip when not on postgres
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', POSTGRES_SCHEMA: '1bad' })).not.toThrow();
  });

  it('rejects a non-integer / out-of-range port', () => {
    expect(() => validateEnv({ DATABASE_PORT: 'abc' })).toThrow(/DATABASE_PORT/);
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ PORT: '2785' })).not.toThrow();
  });

  it('rejects a non-numeric database timeout knob (a typo would become NaN and break the pg pool)', () => {
    expect(() => validateEnv({ DATABASE_STATEMENT_TIMEOUT_MS: 'abc' })).toThrow(/DATABASE_STATEMENT_TIMEOUT_MS/);
    expect(() => validateEnv({ DATABASE_IDLE_TIMEOUT_MS: '30s' })).toThrow(/DATABASE_IDLE_TIMEOUT_MS/);
    expect(() => validateEnv({ DATABASE_CONNECTION_TIMEOUT_MS: '10000' })).not.toThrow();
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

  it('rejects a non-integer rate-limit / webhook / pool-size / redis-timeout / session-cap value', () => {
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: 'abc' })).toThrow(/RATE_LIMIT_SHORT_LIMIT/);
    expect(() => validateEnv({ WEBHOOK_TIMEOUT: '10s' })).toThrow(/WEBHOOK_TIMEOUT/);
    expect(() => validateEnv({ DATABASE_POOL_SIZE: '1.5' })).toThrow(/DATABASE_POOL_SIZE/);
    expect(() => validateEnv({ REDIS_CONNECT_TIMEOUT_MS: 'soon' })).toThrow(/REDIS_CONNECT_TIMEOUT_MS/);
    expect(() => validateEnv({ MAX_CONCURRENT_SESSIONS: 'many' })).toThrow(/MAX_CONCURRENT_SESSIONS/);
    expect(() => validateEnv({ RATE_LIMIT_LONG_TTL: '-5' })).toThrow(/RATE_LIMIT_LONG_TTL/);
    // valid integers (and unset) still pass
    expect(() =>
      validateEnv({
        RATE_LIMIT_SHORT_LIMIT: '10',
        WEBHOOK_TIMEOUT: '10000',
        DATABASE_POOL_SIZE: '10',
        REDIS_CONNECT_TIMEOUT_MS: '5000',
        MAX_CONCURRENT_SESSIONS: '0',
      }),
    ).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects 0 for a rate-limit limit or the webhook timeout (self-DoS), but allows 0 where it is meaningful', () => {
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: '0' })).toThrow(/RATE_LIMIT_SHORT_LIMIT/);
    expect(() => validateEnv({ RATE_LIMIT_MEDIUM_LIMIT: '0' })).toThrow(/RATE_LIMIT_MEDIUM_LIMIT/);
    expect(() => validateEnv({ RATE_LIMIT_LONG_LIMIT: '0' })).toThrow(/RATE_LIMIT_LONG_LIMIT/);
    expect(() => validateEnv({ WEBHOOK_TIMEOUT: '0' })).toThrow(/WEBHOOK_TIMEOUT/);
    // 0 stays valid where it has a real meaning: unlimited sessions, no webhook retries, a TTL.
    expect(() =>
      validateEnv({ MAX_CONCURRENT_SESSIONS: '0', WEBHOOK_MAX_RETRIES: '0', RATE_LIMIT_SHORT_TTL: '0' }),
    ).not.toThrow();
    // a positive value still passes
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: '10', WEBHOOK_TIMEOUT: '10000' })).not.toThrow();
  });

  it('rejects a non-canonical boolean feature flag instead of silently disabling the feature', () => {
    // QUEUE_ENABLED / MCP_ENABLED / SERVE_DASHBOARD are read at module-eval with `=== 'true'` /
    // `!== 'false'`, so a typo silently (dis)ables the feature with zero diagnostics. Boot must reject it.
    expect(() => validateEnv({ QUEUE_ENABLED: 'True' })).toThrow(/QUEUE_ENABLED/);
    expect(() => validateEnv({ QUEUE_ENABLED: '1' })).toThrow(/QUEUE_ENABLED/);
    expect(() => validateEnv({ MCP_ENABLED: 'yes' })).toThrow(/MCP_ENABLED/);
    expect(() => validateEnv({ SERVE_DASHBOARD: 'no' })).toThrow(/SERVE_DASHBOARD/);
    // The raw value is checked, NOT a trimmed one: a trailing space / CR (Windows-edited env file
    // forwarded verbatim by `docker run --env-file`) must still be rejected — otherwise the flag reads
    // false at every `=== 'true'` site while validation passes, giving false assurance.
    expect(() => validateEnv({ QUEUE_ENABLED: 'true ' })).toThrow(/QUEUE_ENABLED/);
    expect(() => validateEnv({ MCP_ENABLED: 'true\r' })).toThrow(/MCP_ENABLED/);
    // Canonical values, unset, and blank (a compose `${KEY:-}` forward renders '') all pass.
    expect(() => validateEnv({ QUEUE_ENABLED: 'true', MCP_ENABLED: 'false', SERVE_DASHBOARD: 'true' })).not.toThrow();
    expect(() => validateEnv({ QUEUE_ENABLED: '', SERVE_DASHBOARD: '' })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects a SEARCH_PROVIDER typo instead of silently falling back to auto', () => {
    // A bogus / typo value must fail fast at boot rather than silently selecting the default provider.
    expect(() => validateEnv({ SEARCH_PROVIDER: 'bogus' })).toThrow(/SEARCH_PROVIDER/);
    // The three documented values are accepted.
    expect(() => validateEnv({ SEARCH_PROVIDER: 'auto' })).not.toThrow();
    expect(() => validateEnv({ SEARCH_PROVIDER: 'builtin-fts' })).not.toThrow();
    expect(() => validateEnv({ SEARCH_PROVIDER: 'none' })).not.toThrow();
    // Unset is accepted (the configuration default of 'auto' applies downstream).
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

  it('rejects DATABASE_SYNCHRONIZE=true with DATABASE_TYPE=postgres (drops body_ts → /search 501)', () => {
    // The Postgres data connection hardcodes migrationsRun=true; an opted-in synchronize=true makes
    // TypeORM re-sync from entities on every boot, dropping the migration-created `body_ts` generated
    // tsvector column (not declared on the Message entity) → /search 501 every restart. The breaking
    // combo must fail fast at boot.
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'db',
        DATABASE_USERNAME: 'u',
        DATABASE_PASSWORD: 'p',
        DATABASE_SYNCHRONIZE: 'true',
      }),
    ).toThrow(/DATABASE_SYNCHRONIZE.*postgres|migrations/);
    // The production default (synchronize=false / unset) is fine on Postgres.
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'db',
        DATABASE_USERNAME: 'u',
        DATABASE_PASSWORD: 'p',
        DATABASE_SYNCHRONIZE: 'false',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'db',
        DATABASE_USERNAME: 'u',
        DATABASE_PASSWORD: 'p',
      }),
    ).not.toThrow();
    // SQLite is migration-managed only when synchronize is unset/false, but the combo is NOT breaking
    // there (SQLite has no generated-column migration to drop), so it stays allowed.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_SYNCHRONIZE: 'true' })).not.toThrow();
  });

  it('rejects a bare SQLite DATABASE_NAME (PG-name leak) that has no path separator or file extension', () => {
    // Regression for #677: .env.example shipped `DATABASE_NAME=openwa` (a PostgreSQL db name).
    // In a SQLite run that bare name becomes the file PATH → SQLite opens a file named 'openwa'
    // under the read-only app rootfs → SQLITE_CANTOPEN boot-loop. The guard catches the leak at boot.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: 'openwa' })).toThrow(/file path/);
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: 'prod_db' })).toThrow(/file path/);
    // A bare name WITH a .sqlite/.db suffix is a legitimate file in the cwd — let it pass.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: 'openwa.sqlite' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: 'cache.db' })).not.toThrow();
    // A path (with a separator) is always honored, explicit host paths included.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: '/app/data/openwa.sqlite' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: './data/openwa.sqlite' })).not.toThrow();
    // Unset falls through to the default path (configuration.ts) — the boot-loop fix.
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite' })).not.toThrow();
  });
});
