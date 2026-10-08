import { LogLevel } from '../common/services/logger.service';
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
    // upper case rejected: the unquoted search_path folds it, TypeORM's quoted schema does not
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'OpenWA' })).toThrow(/lower-case/);
    // reserved pg_ prefix rejected
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'pg_catalog' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'Pg_temp' })).toThrow(/POSTGRES_SCHEMA/);
    // surrounding whitespace rejected, not trimmed: the app and the migration CLI use the raw value
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: ' openwa' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: 'openwa ' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: '  ' })).toThrow(/POSTGRES_SCHEMA/);
    expect(() => validateEnv({ ...pg, POSTGRES_SCHEMA: '' })).not.toThrow();
    // ignored for sqlite: a bogus value must NOT trip when not on postgres
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', POSTGRES_SCHEMA: '1bad' })).not.toThrow();
  });

  /**
   * The media knobs take RAW numbers while `BODY_SIZE_LIMIT` beside them in .env.example takes a
   * unit string. Their read sites use `Number.parseInt`, which takes the leading digits and drops
   * the unit, so `50mb` was accepted as 50: a 50-byte cap, and `30s` a 30 ms timeout. Both are
   * positive integers, so the "garbage falls back to the default" those helpers promise never
   * fired. Boot has to be the place this stops.
   */
  it('rejects a unit-suffixed media knob instead of reading its leading digits', () => {
    expect(() => validateEnv({ MEDIA_DOWNLOAD_MAX_BYTES: '50mb' })).toThrow(/MEDIA_DOWNLOAD_MAX_BYTES/);
    expect(() => validateEnv({ MEDIA_DOWNLOAD_TIMEOUT_MS: '30s' })).toThrow(/MEDIA_DOWNLOAD_TIMEOUT_MS/);
    expect(() => validateEnv({ CHAT_HISTORY_MEDIA_BUDGET_BYTES: '25mb' })).toThrow(/CHAT_HISTORY_MEDIA_BUDGET_BYTES/);
    expect(() => validateEnv({ INBOUND_MEDIA_CONCURRENCY: '4x' })).toThrow(/INBOUND_MEDIA_CONCURRENCY/);
  });

  it('rejects a non-positive media knob and accepts a plain byte count', () => {
    expect(() => validateEnv({ MEDIA_DOWNLOAD_MAX_BYTES: '0' })).toThrow(/MEDIA_DOWNLOAD_MAX_BYTES/);
    expect(() => validateEnv({ MEDIA_DOWNLOAD_MAX_BYTES: '-1' })).toThrow(/MEDIA_DOWNLOAD_MAX_BYTES/);
    expect(() => validateEnv({ INBOUND_MEDIA_CONCURRENCY: 'abc' })).toThrow(/INBOUND_MEDIA_CONCURRENCY/);
    expect(() => validateEnv({ MEDIA_DOWNLOAD_MAX_BYTES: '52428800' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_TIMEOUT_MS: '30000' })).not.toThrow();
  });

  it('accepts 0 for INBOUND_MEDIA_GLOBAL_CONCURRENCY (off) and rejects a negative or suffixed value', () => {
    expect(() => validateEnv({ INBOUND_MEDIA_GLOBAL_CONCURRENCY: '0' })).not.toThrow();
    expect(() => validateEnv({ INBOUND_MEDIA_GLOBAL_CONCURRENCY: '16' })).not.toThrow();
    expect(() => validateEnv({ INBOUND_MEDIA_GLOBAL_CONCURRENCY: '-1' })).toThrow(/INBOUND_MEDIA_GLOBAL_CONCURRENCY/);
    expect(() => validateEnv({ INBOUND_MEDIA_GLOBAL_CONCURRENCY: '4x' })).toThrow(/INBOUND_MEDIA_GLOBAL_CONCURRENCY/);
  });

  // Unset and empty stay the operator's way of taking the default; compose forwards a blank.
  it('leaves an unset or blank media knob alone', () => {
    expect(() => validateEnv({})).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_MAX_BYTES: '', MEDIA_DOWNLOAD_TIMEOUT_MS: '   ' })).not.toThrow();
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

  it('accepts MESSAGE_INLINE_MEDIA inline or archive, and refuses a typo', () => {
    expect(() => validateEnv({ MESSAGE_INLINE_MEDIA: 'inline' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_INLINE_MEDIA: 'archive', CHAT_MEDIA_ARCHIVE_ENABLED: 'true' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_INLINE_MEDIA: 'archived' })).toThrow(/MESSAGE_INLINE_MEDIA must be one of/);
  });

  it('refuses MESSAGE_INLINE_MEDIA=archive without the archiver, which would silently do nothing', () => {
    expect(() => validateEnv({ MESSAGE_INLINE_MEDIA: 'archive' })).toThrow(
      /MESSAGE_INLINE_MEDIA=archive needs CHAT_MEDIA_ARCHIVE_ENABLED=true/,
    );
    expect(() => validateEnv({ MESSAGE_INLINE_MEDIA: 'archive', CHAT_MEDIA_ARCHIVE_ENABLED: 'false' })).toThrow(
      /needs CHAT_MEDIA_ARCHIVE_ENABLED=true/,
    );
  });

  // The runtime compares these raw (`=== 'postgres'`, the engine plugin lookup, `=== 's3'`), so a
  // padded value that only matches after trimming would validate here and then take the default branch.
  it.each([
    ['DATABASE_TYPE', 'postgres '],
    ['DATABASE_TYPE', 'sqlite\r'],
    ['ENGINE_TYPE', 'baileys '],
    ['STORAGE_TYPE', ' s3'],
  ])('rejects a padded %s %j instead of validating the trimmed value', (key, value) => {
    const pg = { DATABASE_HOST: 'db', DATABASE_USERNAME: 'u', DATABASE_PASSWORD: 'p' };
    expect(() => validateEnv({ ...pg, [key]: value })).toThrow(new RegExp(`${key} must be`));
  });

  it('still treats a whitespace-only enum (a blank compose forward) as unset', () => {
    expect(() => validateEnv({ DATABASE_TYPE: '  ', ENGINE_TYPE: '', STORAGE_TYPE: ' ' })).not.toThrow();
  });

  // Every production hardening in the repo compares NODE_ENV against the exact string 'production',
  // so an unrecognised value silently selects the permissive branch of each one — including the
  // ALLOW_DEV_API_KEY rejection that stops the public `dev-admin-key` being seeded as an ADMIN
  // credential. A typo must fail the boot, not downgrade it.
  // The knob that raises the message-list media budget parses with parseInt, so `8MiB` silently
  // means 8 BYTES — every payload omitted — exactly the trap its sibling
  // EXPORT_INLINE_MEDIA_BUDGET_BYTES is boot-checked for.
  it('rejects a non-integer message-list media budget', () => {
    expect(() => validateEnv({ MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES: '8MiB' })).toThrow(
      /MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES/,
    );
    expect(() => validateEnv({ MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES: '8388608' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES: '0' })).not.toThrow();
  });

  it('rejects a NODE_ENV typo instead of silently selecting the permissive branch', () => {
    expect(() => validateEnv({ NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ NODE_ENV: 'Production' })).toThrow(/NODE_ENV/);
    // Padded values must fail too: every reader compares the RAW `process.env.NODE_ENV` against
    // 'production', so a value that only matches after trimming validates clean and then selects the
    // permissive branch anyway — the exact silent downgrade this check exists to stop.
    expect(() => validateEnv({ NODE_ENV: ' production ' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
    // Unset stays legal: it is the standard Node default and every shipped deployment sets it
    // explicitly (Dockerfile, both compose files, the Helm chart, .env.example).
    expect(() => validateEnv({})).not.toThrow();
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

  it('rejects 0 for a rate-limit limit or window or the webhook timeout (self-DoS), but allows 0 where it is meaningful', () => {
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: '0' })).toThrow(/RATE_LIMIT_SHORT_LIMIT/);
    expect(() => validateEnv({ RATE_LIMIT_MEDIUM_LIMIT: '0' })).toThrow(/RATE_LIMIT_MEDIUM_LIMIT/);
    expect(() => validateEnv({ RATE_LIMIT_LONG_LIMIT: '0' })).toThrow(/RATE_LIMIT_LONG_LIMIT/);
    expect(() => validateEnv({ WEBHOOK_TIMEOUT: '0' })).toThrow(/WEBHOOK_TIMEOUT/);
    // A 0 window expires every hit as it lands, which switches that tier off just as a 0 limit would.
    for (const key of [
      'RATE_LIMIT_SHORT_TTL',
      'RATE_LIMIT_MEDIUM_TTL',
      'RATE_LIMIT_LONG_TTL',
      'INGRESS_INSTANCE_TTL',
    ]) {
      expect(() => validateEnv({ [key]: '0' })).toThrow(new RegExp(`${key} must be a positive integer`));
    }
    // 0 stays valid where it has a real meaning: unlimited sessions, no webhook retry backoff.
    expect(() => validateEnv({ MAX_CONCURRENT_SESSIONS: '0', WEBHOOK_RETRY_DELAY: '0' })).not.toThrow();
    // a positive value still passes
    expect(() => validateEnv({ RATE_LIMIT_SHORT_LIMIT: '10', WEBHOOK_TIMEOUT: '10000' })).not.toThrow();
  });

  it('rejects a non-positive / non-integer in-flight body budget (0 would refuse every body)', () => {
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '0' })).toThrow(/INFLIGHT_BODY_BUDGET_BYTES/);
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '100mb' })).toThrow(/INFLIGHT_BODY_BUDGET_BYTES/);
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '-5' })).toThrow(/INFLIGHT_BODY_BUDGET_BYTES/);
    expect(() => validateEnv({ INFLIGHT_BODY_BUDGET_BYTES: '104857600' })).not.toThrow();
  });

  it('rejects a BODY_SIZE_LIMIT that refuses every body or would silently fall back to the default', () => {
    for (const value of ['0', '0kb', '0.5', '50M', '50MiB', '50 MiB', 'abc']) {
      expect(() => validateEnv({ BODY_SIZE_LIMIT: value })).toThrow(/BODY_SIZE_LIMIT must be a positive size/);
    }
    for (const value of ['25mb', '1.5gb', '1048576', '50 MB']) {
      expect(() => validateEnv({ BODY_SIZE_LIMIT: value })).not.toThrow();
    }
  });

  it('rejects a negative/non-integer webhook fan-out knob (0 is a documented escape hatch)', () => {
    expect(() => validateEnv({ WEBHOOK_MAX_PER_SESSION: '-1' })).toThrow(/WEBHOOK_MAX_PER_SESSION/);
    expect(() => validateEnv({ WEBHOOK_MAX_PER_SESSION: '1.5' })).toThrow(/WEBHOOK_MAX_PER_SESSION/);
    expect(() => validateEnv({ WEBHOOK_MEDIA_INLINE_MAX_BYTES: 'abc' })).toThrow(/WEBHOOK_MEDIA_INLINE_MAX_BYTES/);
    // 0 is meaningful for both: unlimited registrations / never inline media.
    expect(() => validateEnv({ WEBHOOK_MAX_PER_SESSION: '0', WEBHOOK_MEDIA_INLINE_MAX_BYTES: '0' })).not.toThrow();
  });

  it('rejects a non-integer audit retention but accepts every value documented as "disable"', () => {
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: 'ninety' })).toThrow(/AUDIT_RETENTION_DAYS/);
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: '90.5' })).toThrow(/AUDIT_RETENTION_DAYS/);
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: '30d' })).toThrow(/AUDIT_RETENTION_DAYS/);
    // audit.service.ts and docs/05 both document `<= 0` as the off switch, so BOTH spellings must
    // boot. Requiring non-negative here would refuse to start on a configuration the docs advertise.
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: '0' })).not.toThrow();
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: '-1' })).not.toThrow();
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: '90' })).not.toThrow();
  });

  it('rejects a non-integer message retention and accepts 0 and negatives as "keep forever"', () => {
    expect(() => validateEnv({ MESSAGE_RETENTION_DAYS: '30d' })).toThrow(/MESSAGE_RETENTION_DAYS/);
    expect(() => validateEnv({ MESSAGE_RETENTION_DAYS: '0' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_RETENTION_DAYS: '-1' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_RETENTION_DAYS: '30' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_RETENTION_DAYS: '36500' })).not.toThrow();
    expect(() => validateEnv({ MESSAGE_RETENTION_DAYS: '36501' })).toThrow(/MESSAGE_RETENTION_DAYS.*36500/);
  });

  // A "keep forever" row of nines binds on SQLite as a truncated year that sorts after today, so the
  // prune would delete every row. Each retention window shares the message-retention cap.
  it.each([
    'AUDIT_RETENTION_DAYS',
    'CHAT_MEDIA_ARCHIVE_TTL_DAYS',
    'WEBHOOK_FAILURE_RETENTION_DAYS',
    'WEBHOOK_OUTBOX_RETENTION_DAYS',
    'INGRESS_RETENTION_DAYS',
    'INGRESS_DEDUP_RETENTION_DAYS',
  ])('rejects a %s above 36500 days', key => {
    expect(() => validateEnv({ [key]: '9999999' })).toThrow(new RegExp(`${key} must be at most 36500`));
    expect(() => validateEnv({ [key]: '36501' })).toThrow(new RegExp(`${key} must be at most 36500`));
    expect(() => validateEnv({ [key]: '36500' })).not.toThrow();
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

  it('rejects a mistyped value for the datastore, webhook and engine booleans too', () => {
    // Read with the same bare `=== 'true'` / `!== 'false'` comparison but absent from the strict list,
    // so a typo configured the opposite of what the operator asked for, in silence. DATABASE_SSL is
    // the one that fails OPEN: `require` is the natural Postgres spelling and reads as OFF, so a
    // connection the operator believed was TLS-protected runs in plaintext.
    expect(() => validateEnv({ DATABASE_SSL: 'require' })).toThrow(/DATABASE_SSL/);
    expect(() => validateEnv({ DATABASE_SSL_REJECT_UNAUTHORIZED: '0' })).toThrow(/DATABASE_SSL_REJECT_UNAUTHORIZED/);
    expect(() => validateEnv({ MAIN_DATABASE_SYNCHRONIZE: 'False' })).toThrow(/MAIN_DATABASE_SYNCHRONIZE/);
    expect(() => validateEnv({ ALLOW_UNSIGNED_INGRESS: 'yes' })).toThrow(/ALLOW_UNSIGNED_INGRESS/);
    expect(() => validateEnv({ ALLOW_DEV_API_KEY: '1' })).toThrow(/ALLOW_DEV_API_KEY/);
    expect(() => validateEnv({ WEBHOOK_SSRF_PROTECT: 'off' })).toThrow(/WEBHOOK_SSRF_PROTECT/);
    expect(() => validateEnv({ WEBHOOK_CONTACT_DETAILS: 'on' })).toThrow(/WEBHOOK_CONTACT_DETAILS/);
    expect(() => validateEnv({ BAILEYS_SYNC_FULL_HISTORY: 'True' })).toThrow(/BAILEYS_SYNC_FULL_HISTORY/);
    expect(() => validateEnv({ BAILEYS_WA_VERSION: '2.3000' })).toThrow(/BAILEYS_WA_VERSION/);
    expect(() => validateEnv({ BAILEYS_WA_VERSION: '1.2.3' })).toThrow(/BAILEYS_WA_VERSION/);
    expect(() => validateEnv({ BAILEYS_WA_VERSION: 'abc' })).toThrow(/BAILEYS_WA_VERSION/);
    expect(() => validateEnv({ BAILEYS_WA_VERSION: '2.3000.1045340097' })).not.toThrow();
    expect(() => validateEnv({ BAILEYS_WA_VERSION: '2,3000,1045340097' })).not.toThrow();
    expect(() => validateEnv({ BAILEYS_MARK_ONLINE_ON_CONNECT: 'ture' })).toThrow(/BAILEYS_MARK_ONLINE_ON_CONNECT/);
    expect(() => validateEnv({ POSTGRES_BUILTIN: 'yes' })).toThrow(/POSTGRES_BUILTIN/);
    expect(() => validateEnv({ REDIS_BUILTIN: 'yes' })).toThrow(/REDIS_BUILTIN/);
    expect(() => validateEnv({ MINIO_BUILTIN: 'yes' })).toThrow(/MINIO_BUILTIN/);
    expect(() => validateEnv({ CACHE_ENABLED: '1' })).toThrow(/CACHE_ENABLED/);
    expect(() => validateEnv({ DATABASE_LOGGING: '1' })).toThrow(/DATABASE_LOGGING/);

    // Canonical values, and the blank a compose `${KEY:-}` forward renders, both stay legal.
    expect(() => validateEnv({ DATABASE_SSL: 'true', MAIN_DATABASE_SYNCHRONIZE: 'false' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_SSL: '', WEBHOOK_SSRF_PROTECT: '' })).not.toThrow();

    // Deliberately still tolerant, because both fail toward the SAFE state and the repo tests that
    // tolerance: mcp.server.spec.ts asserts MCP_READONLY='yes' stays read-only, and
    // PUPPETEER_HEADLESS='new' is a real Puppeteer value that works today.
    expect(() => validateEnv({ MCP_READONLY: 'yes' })).not.toThrow();
    expect(() => validateEnv({ PUPPETEER_HEADLESS: 'new' })).not.toThrow();
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

  it.each(['MEDIA_CONVERSION_ENABLED', 'CHAT_MEDIA_ARCHIVE_ENABLED', 'CHAT_MEDIA_ARCHIVE_OUTBOUND'])(
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

  it('rejects a MEDIA_DOWNLOAD_ENABLED typo instead of silently keeping the expensive default on', () => {
    // The odd one out of the boolean family: it is read with `!== 'false' && !== '0' && !== 'no'`
    // (inbound-media-cap.ts), so a typo does not disable a feature — it leaves inbound media being
    // decrypted and base64-inlined into every message row, up to MEDIA_DOWNLOAD_MAX_BYTES apiece.
    // An operator who typed it to turn that OFF gets the most expensive behaviour the gateway has,
    // with no diagnostics anywhere.
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: 'fasle' })).toThrow(/MEDIA_DOWNLOAD_ENABLED/);
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: 'ture' })).toThrow(/MEDIA_DOWNLOAD_ENABLED/);
    // Unlike the strict family this flag is read through a NORMALISING parser — inbound-media-cap.ts
    // trims and lowercases, and inbound-media-cap.spec.ts asserts 'FALSE' / ' false ' disable. Those
    // spellings demonstrably work, so validation must not reject them; only a value the read site
    // cannot recognise at all is a mistake worth failing the boot for.
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: 'False' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: ' false ' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: '0' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: 'no' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: 'true' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: 'false' })).not.toThrow();
    expect(() => validateEnv({ MEDIA_DOWNLOAD_ENABLED: '' })).not.toThrow();
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

  it('rejects a LOG_LEVEL misspelling instead of silently logging at info', () => {
    // Plausible spellings from neighbouring vocabularies that this repo's LogLevel does not carry;
    // every one of them silently meant INFO before this check existed.
    expect(() => validateEnv({ LOG_LEVEL: 'warning' })).toThrow(/LOG_LEVEL/);
    expect(() => validateEnv({ LOG_LEVEL: 'log' })).toThrow(/LOG_LEVEL/); // Nest's spelling
    expect(() => validateEnv({ LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/); // Baileys' vocabulary
    // The reader (main.ts) trims and lowercases before matching, so these keep booting.
    expect(() => validateEnv({ LOG_LEVEL: 'DEBUG' })).not.toThrow();
    expect(() => validateEnv({ LOG_LEVEL: ' warn ' })).not.toThrow();
    // Unset means INFO and passes.
    expect(() => validateEnv({})).not.toThrow();
  });

  it('accepts exactly the LogLevel values main.ts applies, no more and no fewer', () => {
    // env.validation.ts keeps its own copy of the level list while main.ts matches against the enum.
    // The rejection message prints that copy, so comparing it with the enum catches drift either way.
    const levels: string[] = Object.values(LogLevel);
    for (const level of levels) {
      expect(() => validateEnv({ LOG_LEVEL: level })).not.toThrow();
    }
    expect(() => validateEnv({ LOG_LEVEL: 'nope' })).toThrow(
      `LOG_LEVEL must be one of ${levels.map(v => `"${v}"`).join(', ')} (got "nope")`,
    );
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

  it("catches MAIN_DATABASE_NAME pointing at the data connection's default file", () => {
    // DATABASE_NAME unset resolves to ./data/openwa.sqlite at runtime, so the guard must compare that.
    expect(() => validateEnv({ MAIN_DATABASE_NAME: './data/openwa.sqlite' })).toThrow(/\.\/data\/openwa\.sqlite/);
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite', MAIN_DATABASE_NAME: './data/../data/openwa.sqlite' })).toThrow(
      /main database file/,
    );
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

  // Read with parseInt and a `> 0` guard, so `1h` became a 1 ms sweep interval rather than the default.
  it.each([
    'CHAT_MEDIA_ARCHIVE_MAX_BYTES',
    'CHAT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS',
    'CHAT_MEDIA_ORPHAN_GRACE_MS',
    'STATUS_MEDIA_MAX_BYTES',
    'STATUS_ORPHAN_SWEEP_INTERVAL_MS',
    'STATUS_ORPHAN_GRACE_MS',
    'S3_REPROBE_INTERVAL_MS',
    'STORAGE_EXPORT_TTL_MS',
    'STORAGE_EXPORT_SWEEP_MAX_AGE_MS',
    'WEBHOOK_DEGRADED_SESSION_CONCURRENCY',
  ])('rejects a unit-suffixed or non-positive %s and accepts a plain count', key => {
    expect(() => validateEnv({ [key]: '1h' })).toThrow(new RegExp(`${key} must be a positive integer`));
    expect(() => validateEnv({ [key]: '0' })).toThrow(new RegExp(`${key} must be a positive integer`));
    expect(() => validateEnv({ [key]: '3600000' })).not.toThrow();
  });

  // Each read fell back to the default on 0 or garbage, or passed a negative or fractional value on.
  it.each(['SEARCH_LIMIT_MAX', 'INGRESS_MAX_ATTEMPTS', 'WEBHOOK_WORKER_CONCURRENCY', 'INGRESS_WORKER_CONCURRENCY'])(
    'rejects a non-positive or non-integer %s and accepts a plain count',
    key => {
      for (const bad of ['0', '-5', '2.5', 'abc', '5x']) {
        expect(() => validateEnv({ [key]: bad })).toThrow(new RegExp(`${key} must be a positive integer`));
      }
      expect(() => validateEnv({ [key]: '7' })).not.toThrow();
      expect(() => validateEnv({ [key]: '' })).not.toThrow();
      expect(() => validateEnv({ [key]: '  ' })).not.toThrow();
    },
  );

  // Read as an exact 'true'/'false' override; anything else falls back to the NODE_ENV default, so
  // CSP_UPGRADE_INSECURE_REQUESTS=False kept the blank-dashboard trap on in production.
  it.each([
    'CSP_UPGRADE_INSECURE_REQUESTS',
    'ENABLE_SWAGGER',
    'VALIDATION_ERROR_DETAIL',
    'PLUGIN_INSTALL_REQUIRE_PIN',
    'WEBHOOK_SSRF_REDIRECTS',
  ])('accepts only an exact true or false for %s', key => {
    for (const bad of ['False', 'TRUE', '0', 'false\r']) {
      expect(() => validateEnv({ [key]: bad })).toThrow(new RegExp(`${key} must be "true" or "false"`));
    }
    for (const ok of ['true', 'false', '']) {
      expect(() => validateEnv({ [key]: ok })).not.toThrow();
    }
  });

  it('accepts only an exact true or false for REDIS_TLS', () => {
    expect(() => validateEnv({ REDIS_TLS: 'yes' })).toThrow(/REDIS_TLS must be "true" or "false"/);
    expect(() => validateEnv({ REDIS_TLS: 'true ' })).toThrow(/REDIS_TLS/);
    expect(() => validateEnv({ REDIS_TLS: 'true' })).not.toThrow();
    expect(() => validateEnv({ REDIS_TLS: '' })).not.toThrow();
  });

  it.each(['INGRESS_RETRY_DELAY_MS', 'REDIS_CACHE_DB'])('rejects a negative or non-integer %s and keeps 0', key => {
    for (const bad of ['-1', '1.5', 'abc']) {
      expect(() => validateEnv({ [key]: bad })).toThrow(new RegExp(`${key} must be a non-negative integer`));
    }
    expect(() => validateEnv({ [key]: '0' })).not.toThrow();
    expect(() => validateEnv({ [key]: '' })).not.toThrow();
  });

  it('rejects a unit-suffixed CHAT_MEDIA_ARCHIVE_TTL_DAYS but keeps 0 (keep forever)', () => {
    expect(() => validateEnv({ CHAT_MEDIA_ARCHIVE_TTL_DAYS: '30d' })).toThrow(/CHAT_MEDIA_ARCHIVE_TTL_DAYS/);
    expect(() => validateEnv({ CHAT_MEDIA_ARCHIVE_TTL_DAYS: '0' })).not.toThrow();
  });

  // parseInt reads a unit-suffixed value as its leading digits: `5mb` became a 5-byte plugin download cap.
  it.each([
    ['PLUGIN_DOWNLOAD_MAX_BYTES', '5mb'],
    ['PLUGIN_STORAGE_MAX_BYTES', '50mb'],
    ['PLUGIN_CAP_TIMEOUT_MS', '30s'],
    ['TEMPLATE_RENDER_MAX_CHARS', '64k'],
    ['STORAGE_IMPORT_MAX_BYTES', '200mb'],
    ['STORAGE_IMPORT_MAX_ENTRIES', '1e5'],
    ['STORAGE_IMPORT_MAX_TOTAL_BYTES', '10gb'],
    ['STORAGE_LIST_MAX_FILES', '100k'],
    ['BAILEYS_MESSAGE_STORE_LIMIT', '5k'],
  ])('rejects a unit-suffixed or zero %s', (key, bad) => {
    expect(() => validateEnv({ [key]: bad })).toThrow(new RegExp(`${key} must be a positive integer`));
    expect(() => validateEnv({ [key]: '0' })).toThrow(new RegExp(`${key} must be a positive integer`));
    expect(() => validateEnv({ [key]: '1000' })).not.toThrow();
  });

  it('rejects a unit-suffixed SHUTDOWN_DELAY_MS but keeps 0 (no drain)', () => {
    expect(() => validateEnv({ SHUTDOWN_DELAY_MS: '3s' })).toThrow(/SHUTDOWN_DELAY_MS must be a non-negative integer/);
    expect(() => validateEnv({ SHUTDOWN_DELAY_MS: '0' })).not.toThrow();
  });

  it.each([
    'WEBHOOK_FAILURE_RETENTION_DAYS',
    'WEBHOOK_OUTBOX_RETENTION_DAYS',
    'INGRESS_RETENTION_DAYS',
    'INGRESS_DEDUP_RETENTION_DAYS',
  ])('rejects a non-integer %s and keeps 0 and negatives', key => {
    expect(() => validateEnv({ [key]: 'ninety' })).toThrow(new RegExp(`${key} must be an integer`));
    expect(() => validateEnv({ [key]: '30d' })).toThrow(new RegExp(`${key} must be an integer`));
    expect(() => validateEnv({ [key]: '0' })).not.toThrow();
    expect(() => validateEnv({ [key]: '-1' })).not.toThrow();
  });

  // Node fires a timer delay above 2^31-1 ms after 1 ms, so these would spin instead of waiting.
  it.each([
    'MEDIA_CONVERSION_TIMEOUT_MS',
    'CHAT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS',
    'STATUS_ORPHAN_SWEEP_INTERVAL_MS',
    'S3_REPROBE_INTERVAL_MS',
    'STORAGE_EXPORT_TTL_MS',
    'MESSAGE_REAPER_INTERVAL_MS',
    'WEBHOOK_RECONCILE_INTERVAL_MS',
    'INGRESS_RECONCILE_INTERVAL_MS',
    'SESSION_TAKEOVER_SWEEP_MS',
    'SESSION_PROXY_TIMEOUT_MS',
    'MEDIA_DOWNLOAD_TIMEOUT_MS',
    'WEBHOOK_TIMEOUT',
    'RATE_LIMIT_SHORT_TTL',
    'RATE_LIMIT_MEDIUM_TTL',
    'RATE_LIMIT_LONG_TTL',
    'INGRESS_INSTANCE_TTL',
  ])('rejects a %s above the Node timer ceiling', key => {
    expect(() => validateEnv({ [key]: '2147483648' })).toThrow(new RegExp(`${key} must not exceed 2147483647 ms`));
    expect(() => validateEnv({ [key]: '2147483647' })).not.toThrow();
  });

  // 0 disables each sweep; a negative value used to boot clean and keep the sweep running.
  it.each(['MESSAGE_REAPER_INTERVAL_MS', 'WEBHOOK_RECONCILE_INTERVAL_MS', 'INGRESS_RECONCILE_INTERVAL_MS'])(
    'rejects a negative %s and keeps 0 as the off switch',
    key => {
      expect(() => validateEnv({ [key]: '-1' })).toThrow(new RegExp(`${key} must be a non-negative integer`));
      expect(() => validateEnv({ [key]: '0' })).not.toThrow();
    },
  );

  // A huge grace builds a cutoff whose year SQLite binds in wrapped form, matching fresh rows.
  it.each(['MESSAGE_REAPER_GRACE_MS', 'WEBHOOK_RECONCILE_GRACE_MS', 'INGRESS_RECONCILE_GRACE_MS'])(
    'rejects a malformed or oversized %s',
    key => {
      expect(() => validateEnv({ [key]: '1h' })).toThrow(new RegExp(`${key} must be a non-negative integer`));
      expect(() => validateEnv({ [key]: '-1' })).toThrow(new RegExp(`${key} must be a non-negative integer`));
      expect(() => validateEnv({ [key]: '999999999999999' })).toThrow(
        new RegExp(`${key} must be at most 3153600000000`),
      );
      expect(() => validateEnv({ [key]: '3153600000000' })).not.toThrow();
      expect(() => validateEnv({ [key]: '0' })).not.toThrow();
    },
  );

  it('rejects a non-positive or overflowing SSRF_DNS_TIMEOUT_MS', () => {
    expect(() => validateEnv({ SSRF_DNS_TIMEOUT_MS: '0' })).toThrow(/SSRF_DNS_TIMEOUT_MS must be a positive integer/);
    expect(() => validateEnv({ SSRF_DNS_TIMEOUT_MS: '10s' })).toThrow(/SSRF_DNS_TIMEOUT_MS must be a positive integer/);
    expect(() => validateEnv({ SSRF_DNS_TIMEOUT_MS: '2147483648' })).toThrow(
      /SSRF_DNS_TIMEOUT_MS must not exceed 2147483647 ms/,
    );
    expect(() => validateEnv({ SSRF_DNS_TIMEOUT_MS: '2147483647' })).not.toThrow();
  });

  // pg arms these with setTimeout and sends statement_timeout to a server capped at INT_MAX; 0 still disables.
  it.each(['DATABASE_CONNECTION_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'DATABASE_STATEMENT_TIMEOUT_MS'])(
    'rejects a %s above 2147483647 ms and keeps 0',
    key => {
      expect(() => validateEnv({ [key]: '99999999999' })).toThrow(new RegExp(`${key} must not exceed 2147483647 ms`));
      expect(() => validateEnv({ [key]: '2147483647' })).not.toThrow();
      expect(() => validateEnv({ [key]: '0' })).not.toThrow();
    },
  );

  it('rejects a SESSION_LEASE_HEARTBEAT_MS above the Node timer ceiling even inside a longer lease', () => {
    const lease = { SESSION_LEASE_TTL_MS: '5000000000' };
    expect(() => validateEnv({ ...lease, SESSION_LEASE_HEARTBEAT_MS: '2147483648' })).toThrow(
      /SESSION_LEASE_HEARTBEAT_MS must not exceed 2147483647 ms/,
    );
    expect(() => validateEnv({ ...lease, SESSION_LEASE_HEARTBEAT_MS: '2147483647' })).not.toThrow();
  });

  // Send verbs arm four times this budget, so its ceiling is a quarter of the timer ceiling.
  it('rejects a PLUGIN_CAP_TIMEOUT_MS whose send-verb budget overflows the Node timer ceiling', () => {
    expect(() => validateEnv({ PLUGIN_CAP_TIMEOUT_MS: '536870912' })).toThrow(
      /PLUGIN_CAP_TIMEOUT_MS must not exceed 536870911 ms/,
    );
    expect(() => validateEnv({ PLUGIN_CAP_TIMEOUT_MS: '536870911' })).not.toThrow();
  });

  // A direct (queue-off) delivery doubles the delay on each retry, up to 2^3 for the maximum retryCount of 5.
  it('rejects a WEBHOOK_RETRY_DELAY whose last direct-delivery backoff overflows the Node timer ceiling', () => {
    expect(() => validateEnv({ WEBHOOK_RETRY_DELAY: '268435456' })).toThrow(
      /WEBHOOK_RETRY_DELAY must not exceed 268435455 ms/,
    );
    expect(() => validateEnv({ WEBHOOK_RETRY_DELAY: '268435455' })).not.toThrow();
  });
});
