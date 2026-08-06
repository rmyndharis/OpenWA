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
    expect(() => validateEnv({ MAX_CONCURRENT_SESSIONS: '0', RATE_LIMIT_SHORT_TTL: '0' })).not.toThrow();
    // a positive value still passes
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: '10', WEBHOOK_TIMEOUT: '10000' })).not.toThrow();
  });

  it('rejects a non-positive / non-integer in-flight body budget (0 would refuse every body)', () => {
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '0' })).toThrow(/INFLIGHT_BODY_BUDGET_BYTES/);
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '100mb' })).toThrow(/INFLIGHT_BODY_BUDGET_BYTES/);
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '-5' })).toThrow(/INFLIGHT_BODY_BUDGET_BYTES/);
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '104857600' })).not.toThrow();
  });

  it('rejects a negative/non-integer webhook fan-out knob (0 is a documented escape hatch)', () => {
    expect(() => validateEnv({ WEBHOOK_MAX_PER_SESSION: '-1' })).toThrow(/WEBHOOK_MAX_PER_SESSION/);
    expect(() => validateEnv({ WEBHOOK_MAX_PER_SESSION: '1.5' })).toThrow(/WEBHOOK_MAX_PER_SESSION/);
    expect(() => validateEnv({ WEBHOOK_MEDIA_INLINE_MAX_BYTES: 'abc' })).toThrow(/WEBHOOK_MEDIA_INLINE_MAX_BYTES/);
    // 0 is meaningful for both: unlimited registrations / never inline media.
    expect(() => validateEnv({ WEBHOOK_MAX_PER_SESSION: '0', WEBHOOK_MEDIA_INLINE_MAX_BYTES: '0' })).not.toThrow();
  });

  it('rejects a non-positive / non-integer WEBHOOK_MAX_PAYLOAD_BYTES (0 would reject every dispatch)', () => {
    expect(() => validateEnv({ WEBHOOK_MAX_PAYLOAD_BYTES: '0' })).toThrow(/WEBHOOK_MAX_PAYLOAD_BYTES/);
    expect(() => validateEnv({ WEBHOOK_MAX_PAYLOAD_BYTES: 'abc' })).toThrow(/WEBHOOK_MAX_PAYLOAD_BYTES/);
    expect(() => validateEnv({ WEBHOOK_MAX_PAYLOAD_BYTES: '-5' })).toThrow(/WEBHOOK_MAX_PAYLOAD_BYTES/);
    expect(() => validateEnv({ WEBHOOK_MAX_PAYLOAD_BYTES: '1048576' })).not.toThrow();
  });

  it('rejects non-decimal integer spellings that parseInt would silently truncate', () => {
    // Number('1e6') is a valid integer, but the config readers use parseInt(raw, 10) — which reads
    // `1e6` as 1 and `0x100` as 0. Validation must reject these so the validated value and the
    // parsed value can never disagree.
    expect(() => validateEnv({ WEBHOOK_MEDIA_INLINE_MAX_BYTES: '1e6' })).toThrow(/WEBHOOK_MEDIA_INLINE_MAX_BYTES/);
    expect(() => validateEnv({ WEBHOOK_MEDIA_INLINE_MAX_BYTES: '0x100' })).toThrow(/WEBHOOK_MEDIA_INLINE_MAX_BYTES/);
    expect(() => validateEnv({ PORT: '0x50' })).toThrow(/PORT/);
    expect(() => validateEnv({ RATE_LIMIT_SHORT_TTL: '1e3' })).toThrow(/RATE_LIMIT_SHORT_TTL/);
    // Plain decimal integers still pass.
    expect(() => validateEnv({ WEBHOOK_MEDIA_INLINE_MAX_BYTES: '1048576', PORT: '2785' })).not.toThrow();
  });

  it('rejects a non-canonical boolean feature flag instead of silently disabling the feature', () => {
    // QUEUE_ENABLED / MCP_ENABLED / SERVE_DASHBOARD are read at module-eval with `=== 'true'` /
    // `!== 'false'`, so a typo silently (dis)ables the feature with zero diagnostics. Boot must reject it.
    expect(() => validateEnv({ QUEUE_ENABLED: 'True' })).toThrow(/QUEUE_ENABLED/);
    expect(() => validateEnv({ QUEUE_ENABLED: '1' })).toThrow(/QUEUE_ENABLED/);
    expect(() => validateEnv({ MCP_ENABLED: 'yes' })).toThrow(/MCP_ENABLED/);
    expect(() => validateEnv({ SERVE_DASHBOARD: 'no' })).toThrow(/SERVE_DASHBOARD/);
    expect(() => validateEnv({ STATUS_SEED_ON_READY: 'yes' })).toThrow(/STATUS_SEED_ON_READY/);
    // The raw value is checked, NOT a trimmed one: a trailing space / CR (Windows-edited env file
    // forwarded verbatim by `docker run --env-file`) must still be rejected — otherwise the flag reads
    // false at every `=== 'true'` site while validation passes, giving false assurance.
    expect(() => validateEnv({ QUEUE_ENABLED: 'true ' })).toThrow(/QUEUE_ENABLED/);
    expect(() => validateEnv({ MCP_ENABLED: 'true\r' })).toThrow(/MCP_ENABLED/);
    // Canonical values, unset, and blank (a compose `${KEY:-}` forward renders '') all pass.
    expect(() =>
      validateEnv({
        QUEUE_ENABLED: 'true',
        MCP_ENABLED: 'false',
        SERVE_DASHBOARD: 'true',
        STATUS_SEED_ON_READY: 'false',
      }),
    ).not.toThrow();
    expect(() => validateEnv({ QUEUE_ENABLED: '', SERVE_DASHBOARD: '' })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects a REDIS_ENABLED typo instead of silently downgrading throttler+cache to in-memory', () => {
    // REDIS_ENABLED is read at boot with `=== 'true'` (throttler storage in app.module.ts,
    // CacheService), so a typo flips rate limiting + caching to per-process in-memory with zero
    // diagnostics — a silent behavior/security downgrade on a multi-replica deployment.
    expect(() => validateEnv({ REDIS_ENABLED: 'ture' })).toThrow(/REDIS_ENABLED/);
    expect(() => validateEnv({ REDIS_ENABLED: 'True' })).toThrow(/REDIS_ENABLED/);
    expect(() => validateEnv({ REDIS_ENABLED: '1' })).toThrow(/REDIS_ENABLED/);
    // Canonical values, blank (compose `${KEY:-}` forward), and unset all pass.
    expect(() => validateEnv({ REDIS_ENABLED: 'true' })).not.toThrow();
    expect(() => validateEnv({ REDIS_ENABLED: 'false' })).not.toThrow();
    expect(() => validateEnv({ REDIS_ENABLED: '' })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it.each(['MEDIA_CONVERSION_ENABLED', 'CHAT_MEDIA_ARCHIVE_ENABLED'])(
    'rejects a %s typo instead of silently leaving the feature off',
    key => {
      // Both are read at boot with `=== 'true'`, so a typo silently disables the feature and the
      // endpoints answer as if it was never configured — the same silent-off class as SEND_PACING.
      expect(() => validateEnv({ [key]: 'ture' })).toThrow(new RegExp(key));
      expect(() => validateEnv({ [key]: 'True' })).toThrow(new RegExp(key));
      expect(() => validateEnv({ [key]: 'true' })).not.toThrow();
      expect(() => validateEnv({ [key]: 'false' })).not.toThrow();
      expect(() => validateEnv({ [key]: '' })).not.toThrow();
    },
  );

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

  it('resolves the main DB path from MAIN_DATABASE_NAME like the runtime (no false-negative/-positive)', () => {
    // The runtime main path is MAIN_DATABASE_NAME || ./data/main.sqlite (configuration.ts). When it
    // is overridden, a DATABASE_NAME following it to the same file must still be caught — comparing
    // against the hardcoded default alone would miss this.
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'sqlite',
        MAIN_DATABASE_NAME: '/srv/openwa/main.sqlite',
        DATABASE_NAME: '/srv/openwa/main.sqlite',
      }),
    ).toThrow(/DATABASE_NAME/);
    // Same collision via a non-normalized spelling (relative/absolute forms of one file).
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'sqlite',
        MAIN_DATABASE_NAME: './custom/main.sqlite',
        DATABASE_NAME: './custom/../custom/main.sqlite',
      }),
    ).toThrow(/DATABASE_NAME/);
    // And the reverse: when MAIN_DATABASE_NAME moves the main DB elsewhere, the DEFAULT main file
    // is no longer the runtime main DB, so using it for data must NOT be rejected.
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'sqlite',
        MAIN_DATABASE_NAME: '/srv/openwa/main.sqlite',
        DATABASE_NAME: './data/main.sqlite',
      }),
    ).not.toThrow();
    // Distinct overridden paths pass.
    expect(() =>
      validateEnv({
        DATABASE_TYPE: 'sqlite',
        MAIN_DATABASE_NAME: './data/auth.sqlite',
        DATABASE_NAME: './data/openwa.sqlite',
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

  // A renewal that does not fit inside the lease renews too late to matter: the claim lapses between
  // ticks and peers adopt sessions from a healthy node, with nothing in the logs saying why.
  it('rejects a lease heartbeat that does not comfortably fit inside the TTL', () => {
    expect(() => validateEnv({ SESSION_LEASE_TTL_MS: '60000', SESSION_LEASE_HEARTBEAT_MS: '50000' })).toThrow(
      /less than half/,
    );
    // The defaults stand in for whatever is unset, so a lone oversized heartbeat cannot slip past.
    expect(() => validateEnv({ SESSION_LEASE_HEARTBEAT_MS: '45000' })).toThrow(/less than half/);
    expect(() => validateEnv({ SESSION_LEASE_TTL_MS: '20000' })).toThrow(/less than half/);
    expect(() => validateEnv({ SESSION_LEASE_TTL_MS: '120000', SESSION_LEASE_HEARTBEAT_MS: '30000' })).not.toThrow();
    // Exactly half is rejected too: a single missed renewal then lands on the expiry instant.
    expect(() => validateEnv({ SESSION_LEASE_TTL_MS: '60000', SESSION_LEASE_HEARTBEAT_MS: '30000' })).toThrow(
      /less than half/,
    );
    expect(() => validateEnv({})).not.toThrow();
  });

  // The forwarder builds an absolute URL from NODE_URL; a scheme-less value only fails at the first
  // forward, as a 500 on a request that had nothing wrong with it.
  it('rejects a NODE_URL that is not an absolute http(s) URL', () => {
    expect(() => validateEnv({ NODE_URL: 'localhost:2785' })).toThrow(/absolute http/);
    expect(() => validateEnv({ NODE_URL: '10.0.0.5:2785' })).toThrow(/absolute http/);
    expect(() => validateEnv({ NODE_URL: 'ftp://10.0.0.5' })).toThrow(/absolute http/);
    // Embedded credentials parse as a valid URL but undici's fetch refuses them, so reject at boot.
    expect(() => validateEnv({ NODE_URL: 'http://user:pw@10.0.0.5:2785' })).toThrow(/must not embed credentials/);
    expect(() => validateEnv({ NODE_URL: 'http://10.0.0.5:2785' })).not.toThrow();
    expect(() => validateEnv({ NODE_URL: 'https://node-a.internal' })).not.toThrow();
  });

  it('rejects a non-positive media-conversion knob instead of silently using the default', () => {
    expect(() => validateEnv({ MEDIA_CONVERSION_CONCURRENCY: '0' })).toThrow(/positive integer/);
    expect(() => validateEnv({ MEDIA_CONVERSION_TIMEOUT_MS: 'abc' })).toThrow(/positive integer/);
    expect(() => validateEnv({ MEDIA_CONVERSION_MAX_OUTPUT_BYTES: '52428800' })).not.toThrow();
  });
});
