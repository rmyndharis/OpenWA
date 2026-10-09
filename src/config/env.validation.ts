import { resolve } from 'path';
import { normalizeS3KeyPrefix } from '../common/storage/s3-key-prefix';
import { resolveBodyLimit } from './bootstrap-security';
import { parseBodyLimitBytes } from './inflight-body-budget';

type EnvConfig = Record<string, unknown>;

// Default SQLite file of the 'main' (auth/audit) connection. The runtime path is env-overridable via
// MAIN_DATABASE_NAME (configuration.ts), so the collision guard below must resolve the EFFECTIVE
// path — comparing against this constant alone would false-negative when MAIN_DATABASE_NAME moves
// the main DB and DATABASE_NAME follows it, and false-positive when the main DB moved away but
// DATABASE_NAME still points at the (now unused) default file.
const MAIN_DB_DEFAULT_PATH = './data/main.sqlite';
// Default SQLite file of the 'data' connection (configuration.ts / data-source.ts), for the same reason.
const DATA_DB_DEFAULT_PATH = './data/openwa.sqlite';

// Duplicated rather than imported from configuration.ts (see MAIN_DB_DEFAULT_PATH above); the spec
// asserts the two agree.
const MAX_TIMER_MS = 2147483647;

/**
 * Collision guard shared by boot validation (validateEnv below) and the migration CLI
 * (src/database/data-source.ts / data-source-main.ts — the TypeORM CLI never runs ConfigModule's
 * validate(), so both entry points apply this guard themselves). When the 'data' connection is
 * SQLite (explicit or defaulted), its file must not BE the 'main' connection's file: two TypeORM
 * connections on one SQLite file run separate migration ledgers + synchronize policies against the
 * same tables. Both paths are resolved exactly like the runtime (MAIN_DATABASE_NAME / DATABASE_NAME
 * overriding the defaults in configuration.ts) and normalized to absolute, so a relative spelling
 * ('./data/../data/main.sqlite') or an absolute path naming the same file is caught. Returns the
 * error message on collision, null otherwise.
 */
export function sqliteDataMainPathCollision(config: EnvConfig): string | null {
  const read = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  // Postgres uses a bare database NAME, never a file path — no collision is possible there.
  const dbType = read('DATABASE_TYPE');
  if (dbType !== undefined && dbType !== 'sqlite') return null;
  const dataDbName = read('DATABASE_NAME') || DATA_DB_DEFAULT_PATH;
  const mainDbPath = read('MAIN_DATABASE_NAME') || MAIN_DB_DEFAULT_PATH;
  if (resolve(dataDbName) === resolve(mainDbPath)) {
    return `DATABASE_NAME (${dataDbName}) must not point at the main database file (${mainDbPath}); use a separate file`;
  }
  return null;
}

/**
 * POSTGRES_SCHEMA rule shared by boot validation and the Infrastructure save path: a legal,
 * non-reserved, lower-case Postgres identifier. Returns the error message, or null when valid.
 */
export function postgresSchemaError(schema: string): string | null {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    return `POSTGRES_SCHEMA must be a valid lower-case Postgres identifier (a lower-case letter or underscore, then lower-case letters/digits/underscores, max 63 chars; got ${JSON.stringify(schema)})`;
  }
  if (schema.startsWith('pg_')) {
    return `POSTGRES_SCHEMA must not use the reserved "pg_" prefix (got ${JSON.stringify(schema)})`;
  }
  return null;
}

/**
 * Fail-fast environment validation. Wired as ConfigModule's `validate`
 * callback so a misconfigured deployment is rejected at BOOT instead of silently
 * coercing (e.g. a `DATABASE_TYPE=postgre` typo falling back to SQLite) or failing on
 * the first query. Hand-rolled to avoid adding a `joi` dependency; same guarantees:
 *   - DATABASE_TYPE must be a known value (no silent SQLite fallback on a typo)
 *   - Postgres requires host/username/password
 *   - PORT / DATABASE_PORT / REDIS_PORT must be valid integer ports
 */
export function validateEnv(config: EnvConfig): EnvConfig {
  const errors: string[] = [];

  const str = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  // The engine/storage/database selectors are checked RAW, like NODE_ENV below: every reader compares
  // process.env verbatim, so a padded 'postgres ' that only matched after trimming validated clean and
  // then booted SQLite. Whitespace-only still means unset, as a blank compose forward does everywhere.
  const rawEnum = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  const dbType = rawEnum('DATABASE_TYPE');
  if (dbType && dbType !== 'sqlite' && dbType !== 'postgres') {
    errors.push(`DATABASE_TYPE must be "sqlite" or "postgres" (got ${JSON.stringify(dbType)})`);
  }

  // Whitelist the registered engine/storage ids so a typo fails fast at boot: an unknown ENGINE_TYPE
  // would otherwise fail every session start, and an unknown STORAGE_TYPE would silently fall back to
  // local. Values must match the ids registered in engine.factory / configuration.
  const checkEnum = (key: string, allowed: string[]): void => {
    const value = rawEnum(key);
    if (value !== undefined && !allowed.includes(value)) {
      errors.push(`${key} must be one of ${allowed.map(v => `"${v}"`).join(', ')} (got ${JSON.stringify(value)})`);
    }
  };
  checkEnum('ENGINE_TYPE', ['whatsapp-web.js', 'baileys']);
  checkEnum('STORAGE_TYPE', ['local', 's3']);
  checkEnum('MESSAGE_INLINE_MEDIA', ['inline', 'archive']);
  // 'archive' drops the inline copy only after the archiver stored the file; with the archiver off
  // nothing is ever stored, so the mode would silently do nothing. Refuse that rather than let an
  // operator believe the inline copies are being reclaimed.
  if (rawEnum('MESSAGE_INLINE_MEDIA') === 'archive' && config.CHAT_MEDIA_ARCHIVE_ENABLED !== 'true') {
    errors.push('MESSAGE_INLINE_MEDIA=archive needs CHAT_MEDIA_ARCHIVE_ENABLED=true');
  }
  // The S3 key root. A prefix that is absolute, traverses, or is only slashes would put this
  // deployment's objects (and its orphan sweeps' deletes) at the bucket root or outside its own root;
  // one with an empty or '.' segment builds keys an S3-compatible store refuses on every write.
  const s3KeyPrefix = str('S3_KEY_PREFIX');
  if (s3KeyPrefix !== undefined && normalizeS3KeyPrefix(s3KeyPrefix) === null) {
    errors.push(
      `S3_KEY_PREFIX must be a relative key prefix such as "staging/" with no empty, "." or ".." segment (got ${JSON.stringify(s3KeyPrefix)})`,
    );
  }
  // Every production hardening in the repo gates on the exact string 'production', so an
  // unrecognised value silently selects the permissive branch of each one — CORS, Swagger, DTO
  // error detail, the default-secret guard and the ALLOW_DEV_API_KEY rejection that stops the public
  // `dev-admin-key` being seeded as ADMIN.
  //
  // Unset stays legal because it is the standard Node default for a plain `node dist/main` outside
  // any packaged runtime — refusing it would break local runs. The packaged runtimes all set it (the
  // runtime image carries `ENV NODE_ENV=production`, the chart sets it, and both compose files forward
  // it with a default, `${NODE_ENV:-production}` and `${NODE_ENV:-development}`); only a hand-rolled
  // deployment that strips it still takes the permissive branch of every hardening listed above.
  //
  // Checked RAW rather than through `str()`: the readers compare `process.env.NODE_ENV` verbatim, so
  // a padded ' production ' that only matches after trimming would validate clean here and still take
  // the permissive branch at runtime — blessing the very downgrade this check exists to stop.
  const nodeEnvAllowed = ['production', 'development', 'test'];
  const rawNodeEnv = config.NODE_ENV;
  if (typeof rawNodeEnv === 'string' && rawNodeEnv !== '' && !nodeEnvAllowed.includes(rawNodeEnv)) {
    errors.push(`NODE_ENV must be one of ${nodeEnvAllowed.map(v => `"${v}"`).join(', ')} (got "${rawNodeEnv}")`);
  }

  if (dbType === 'postgres') {
    for (const key of ['DATABASE_HOST', 'DATABASE_USERNAME', 'DATABASE_PASSWORD']) {
      if (!str(key)) {
        errors.push(`${key} is required when DATABASE_TYPE=postgres`);
      }
    }
    // The Postgres data connection always runs migrations (app.module.ts hardcodes migrationsRun=true).
    // An opted-in DATABASE_SYNCHRONIZE=true makes TypeORM re-sync the schema from entities on every
    // boot, which immediately DROPS the migration-created `body_ts` generated tsvector column (the
    // Message entity doesn't declare it) → /search returns 501 on every restart. Prod default is
    // synchronize=false; reject only the breaking combo. Read raw (no trim) to match the exact
    // `=== 'true'` comparison at configuration.ts so the guard fires precisely when synchronize would
    // actually be enabled downstream.
    if (config['DATABASE_SYNCHRONIZE'] === 'true') {
      errors.push(
        'DATABASE_SYNCHRONIZE=true is not allowed with DATABASE_TYPE=postgres: the Postgres data connection always runs migrations, and synchronize would drop the migration-created body_ts tsvector column that /search depends on (returns 501 on every restart). Set DATABASE_SYNCHRONIZE=false (the production default) and manage the schema via migrations.',
      );
    }
    // POSTGRES_SCHEMA is optional (defaults to 'public' in configuration.ts). When set, validate it
    // is a legal, non-reserved Postgres identifier so a typo / injection-ish value fails fast at boot
    // rather than reaching CREATE TABLE "<schema>"."..." (or a search_path SET) at migration time.
    // Lower case only: the search_path startup option is unquoted, so Postgres folds it to lower
    // case, while TypeORM quotes the schema. A mixed-case name would split DDL and queries across
    // two schemas. The raw value is checked, untrimmed: the app and the migration CLI both use it
    // as set, so a padded (or whitespace-only) value must fail here as it fails in the CLI.
    const pgSchema = config.POSTGRES_SCHEMA;
    const pgSchemaError = typeof pgSchema === 'string' && pgSchema !== '' ? postgresSchemaError(pgSchema) : null;
    if (pgSchemaError) {
      errors.push(pgSchemaError);
    }
  } else {
    // SQLite (explicit or default): DATABASE_NAME is a file path for the 'data' connection. It must
    // not resolve to the 'main' DB file — two TypeORM connections on one SQLite file run separate
    // migration ledgers + synchronize policies against the same tables, risking schema divergence and
    // lock contention. The main path is resolved like the runtime (MAIN_DATABASE_NAME || default),
    // not assumed to be the default file. (Postgres DATABASE_NAME is a bare db name, so this never
    // applies there.)
    const collision = sqliteDataMainPathCollision(config);
    if (collision) {
      errors.push(collision);
    }
    const dataDbName = str('DATABASE_NAME');
    // Reject a bare name with no path separator and no .sqlite/.db suffix — the exact signature of a
    // PostgreSQL DATABASE_NAME (e.g. 'openwa') leaking into a SQLite run (#677). That bare name becomes
    // the SQLite file PATH, opening a file named 'openwa' under the read-only app rootfs →
    // SQLITE_CANTOPEN boot-loop. A genuine SQLite path always has a separator or a file suffix.
    if (dataDbName && !dataDbName.includes('/') && !dataDbName.includes('\\') && !/\.(sqlite|db)$/i.test(dataDbName)) {
      errors.push(
        `DATABASE_NAME must be a file path under the data volume for SQLite (e.g. ./data/openwa.sqlite); got ${JSON.stringify(
          dataDbName,
        )}. A bare name is the PostgreSQL DB name — leave DATABASE_NAME unset for SQLite to use the default ./data/openwa.sqlite.`,
      );
    }
  }

  // Plain decimal digits only: these numeric knobs are read downstream with parseInt(raw, 10),
  // which silently truncates spellings Number() would accept (`1e6` → 1, `0x100` → 0) — the boot
  // would validate one value and then configure another. Requiring digits keeps the validated
  // value identical to the parsed one.
  const DECIMAL_INTEGER = /^\d+$/;

  const checkPort = (key: string, read: (key: string) => string | undefined = str): void => {
    const raw = read(key);
    if (raw === undefined) return;
    const n = DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push(`${key} must be an integer port in [1, 65535] (got "${raw}")`);
    }
  };
  // PORT is read untrimmed: main.ts listens on it, and the image healthcheck and the startup banner
  // splice it into a URL, where a padded "2785 " is malformed although Node still binds 2785. Only an
  // empty value takes the default there, so validate the exact value with only '' meaning unset.
  checkPort('PORT', key => {
    const value = config[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  });
  checkPort('DATABASE_PORT');
  checkPort('REDIS_PORT');

  // Other numeric knobs: a non-integer (e.g. `RATE_LIMIT_SHORT_LIMIT=abc`) parses to NaN downstream,
  // which silently disables the corresponding limit/timeout. Reject at boot instead of coercing.
  const checkNonNegativeInt = (key: string): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 0) {
      errors.push(`${key} must be a non-negative integer (got "${raw}")`);
    }
  };
  for (const key of [
    'WEBHOOK_RETRY_DELAY',
    'DATABASE_POOL_SIZE',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_IDLE_TIMEOUT_MS',
    'DATABASE_CONNECTION_TIMEOUT_MS',
    'REDIS_CONNECT_TIMEOUT_MS',
    'MAX_CONCURRENT_SESSIONS', // 0 = unlimited
    'WEBHOOK_DISPATCH_MAX_QUEUED',
    'STATS_CACHE_TTL_MS', // 0 = memo disabled
    'WEBHOOK_MAX_PER_SESSION', // 0 = unlimited
    'AUTOMATION_MAX_PER_SESSION', // 0 = unlimited
    'WEBHOOK_MEDIA_INLINE_MAX_BYTES', // 0 = never inline media
    'WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS', // 0 = failure rows keep no payload (no redrive)
    'EXPORT_INLINE_MEDIA_BUDGET_BYTES', // 0 = a data export carries no inline media at all
    'MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES', // 0 = a message list carries no inline media at all
    'CHAT_MEDIA_ARCHIVE_TTL_DAYS', // 0 = keep archived chat media forever
    'INGRESS_RETRY_DELAY_MS', // 0 = retry without backoff
    'REDIS_CACHE_DB',
    'INBOUND_MEDIA_GLOBAL_CONCURRENCY', // 0 = no process-wide ceiling, only the per-session one
    'SHUTDOWN_DELAY_MS', // 0 = no drain; parseInt read `3s` as a 3 ms drain
    // 0 = disabled. A negative value failed the digits-only read and silently kept the default sweep.
    'MESSAGE_REAPER_INTERVAL_MS',
    'WEBHOOK_RECONCILE_INTERVAL_MS',
    'INGRESS_RECONCILE_INTERVAL_MS',
    // 0 = act on a row as soon as it is seen; the cap below keeps the cutoff inside the safe range.
    'MESSAGE_REAPER_GRACE_MS',
    'WEBHOOK_RECONCILE_GRACE_MS',
    'INGRESS_RECONCILE_GRACE_MS',
  ]) {
    checkNonNegativeInt(key);
  }

  // Retention knobs whose read site documents `<= 0` as the switch that disables pruning, so a
  // negative value is a supported spelling of "off" rather than a typo — `audit.service.ts` clamps
  // with Math.max(0, parsed) and `docs/05-database-design.md` advertises `≤ 0 disables`. The point of
  // validating them is to reject `30d` / `ninety`, which parse to NaN and silently become the
  // default; rejecting `-1` would instead refuse to boot a configuration this repo documents.
  const SIGNED_DECIMAL_INTEGER = /^-?\d+$/;
  const checkInt = (key: string): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = SIGNED_DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n)) {
      errors.push(`${key} must be an integer (got "${raw}")`);
    }
  };
  // Keep this an ARRAY LITERAL even at one entry: docs-env-example.spec.ts derives the keys it
  // requires `.env.example` to list by scanning `'KEY',` array elements in this file. Collapsing it
  // into a bare checkInt('AUDIT_RETENTION_DAYS') call would silently drop the knob out of that gate.
  for (const key of [
    'AUDIT_RETENTION_DAYS', // <= 0 disables retention
    'MESSAGE_RETENTION_DAYS', // unset or <= 0 keeps messages forever
    'WEBHOOK_FAILURE_RETENTION_DAYS', // <= 0 disables retention
    'INGRESS_RETENTION_DAYS', // <= 0 disables retention
    // <= 0 cannot disable these two: the read site warns and keeps its default.
    'WEBHOOK_OUTBOX_RETENTION_DAYS',
    'INGRESS_DEDUP_RETENTION_DAYS',
  ]) {
    checkInt(key);
  }
  // TypeORM binds a Date on SQLite with its year cut to the last 4 digits, so a cutoff before about
  // year -2000 (roughly 1.48M days back) can bind as a year that sorts after today and the prune
  // deletes every row. A "keep forever" row of nines is such a value. 36500 is a conservative cap
  // well inside the safe range. Keep in step with MAX_MESSAGE_RETENTION_DAYS in
  // message-retention.service.ts.
  for (const key of [
    'MESSAGE_RETENTION_DAYS',
    'AUDIT_RETENTION_DAYS',
    'CHAT_MEDIA_ARCHIVE_TTL_DAYS',
    'WEBHOOK_FAILURE_RETENTION_DAYS',
    'WEBHOOK_OUTBOX_RETENTION_DAYS',
    'INGRESS_RETENTION_DAYS',
    'INGRESS_DEDUP_RETENTION_DAYS',
  ]) {
    const days = str(key);
    if (days !== undefined && Number(days) > 36500) {
      errors.push(`${key} must be at most 36500 (got "${days}")`);
    }
  }
  // The same cutoff bound, expressed in hours.
  {
    const hours = str('WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS');
    if (hours !== undefined && Number(hours) > 36500 * 24) {
      errors.push(`WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS must be at most ${36500 * 24} (got "${hours}")`);
    }
  }
  // The grace windows build the same kind of cutoff (now minus the grace), so they share the cap.
  for (const key of ['MESSAGE_REAPER_GRACE_MS', 'WEBHOOK_RECONCILE_GRACE_MS', 'INGRESS_RECONCILE_GRACE_MS']) {
    const raw = str(key);
    if (raw !== undefined && DECIMAL_INTEGER.test(raw) && Number(raw) > 36500 * 86_400_000) {
      errors.push(`${key} must be at most ${36500 * 86_400_000} ms, 36500 days (got "${raw}")`);
    }
  }

  // BAILEYS_WA_VERSION: optional version pin for the Baileys engine (e.g. 2.3000.1045340097 or 2,3000,1045340097)
  for (const key of ['BAILEYS_WA_VERSION']) {
    const raw = str(key);
    if (raw !== undefined) {
      const match = raw.match(/^(\d+)[.,](\d+)[.,](\d+)$/);
      if (!match) {
        errors.push(
          `${key} must be a valid WhatsApp Web version (e.g. "2.3000.1045340097"; got ${JSON.stringify(raw)})`,
        );
      } else {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        const patch = parseInt(match[3], 10);
        if (major !== 2 || minor < 2000 || patch < 0) {
          errors.push(
            `${key} must be a valid WhatsApp Web version (e.g. "2.3000.1045340097"; got ${JSON.stringify(raw)})`,
          );
        }
      }
    }
  }

  // Some knobs are nonsensical at 0 and contradict the "non-negative" intent: a rate-limit LIMIT of 0
  // disables that tier's throttling (a self-DoS), and a webhook timeout of 0 aborts every delivery
  // immediately. Require a positive integer for these.
  const checkPositiveInt = (key: string): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`${key} must be a positive integer (got "${raw}")`);
    }
  };
  for (const key of [
    'RATE_LIMIT_SHORT_LIMIT',
    'RATE_LIMIT_MEDIUM_LIMIT',
    'RATE_LIMIT_LONG_LIMIT',
    // A 0 window expires each hit as it lands, so the tier never blocks: the same self-DoS as a 0 limit.
    'RATE_LIMIT_SHORT_TTL',
    'RATE_LIMIT_MEDIUM_TTL',
    'RATE_LIMIT_LONG_TTL',
    'INGRESS_INSTANCE_TTL',
    // WebSocket (/events) limits: 0 would disable a tier entirely (a self-DoS on the WS surface).
    'WS_RATE_LIMIT_FRAME_PER_SECOND',
    'WS_RATE_LIMIT_FRAME_BURST',
    'WS_RATE_LIMIT_HANDSHAKE_MAX',
    'WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS',
    'WS_MAX_SOCKETS_PER_KEY',
    'WEBHOOK_TIMEOUT',
    'INGRESS_INSTANCE_LIMIT',
    'INGRESS_IP_LIMIT',
    'REQUEST_TIMEOUT_MS',
    'HEADERS_TIMEOUT_MS',
    'KEEPALIVE_TIMEOUT_MS',
    'WEBHOOK_DISPATCH_CONCURRENCY',
    'WEBHOOK_DEGRADED_SESSION_CONCURRENCY',
    // 0 would reject every webhook dispatch (a total, silent webhook outage).
    'WEBHOOK_MAX_PAYLOAD_BYTES',
    // 0 would refuse every request carrying a body (a self-DoS), so the budget is positive-only.
    'INFLIGHT_BODY_BUDGET_BYTES',
    // Media conversion: each is read with a `> 0` guard that silently falls back to the default,
    // so a typo or a 0 quietly means "the default" instead of what the operator wrote.
    'MEDIA_CONVERSION_TIMEOUT_MS',
    'MEDIA_CONVERSION_MAX_OUTPUT_BYTES',
    'MEDIA_CONVERSION_CONCURRENCY',
    // Session ownership leases, same fall-back-silently reasoning.
    'SESSION_LEASE_TTL_MS',
    'SESSION_LEASE_HEARTBEAT_MS',
    'SESSION_TAKEOVER_SWEEP_MS',
    'SESSION_PROXY_TIMEOUT_MS',
    // Positive-only is the POINT here, not a convention: 0 arms no Puppeteer timer at all, so a
    // wedged renderer holds the request forever (see wwebjs-lifecycle.ts).
    'PUPPETEER_PROTOCOL_TIMEOUT_MS',
    // The read fell back to its default on garbage, so `10s` silently meant 10000.
    'SSRF_DNS_TIMEOUT_MS',
    // The media knobs take RAW numbers while their neighbours in .env.example and docs/12 take unit
    // strings (`BODY_SIZE_LIMIT=25mb`), and their read sites parse with `Number.parseInt`. That
    // accepts the leading digits of a unit-suffixed value and discards the unit, so
    // `MEDIA_DOWNLOAD_MAX_BYTES=50mb` became a 50 BYTE cap and `MEDIA_DOWNLOAD_TIMEOUT_MS=30s`
    // became 30 ms: every download fails, and the "garbage falls back to the default" the helpers
    // promise never fires because 50 is a perfectly good positive integer. Reject at boot instead,
    // which is what the two inline-media budgets below already do.
    'MEDIA_DOWNLOAD_MAX_BYTES',
    'MEDIA_DOWNLOAD_TIMEOUT_MS',
    'INBOUND_MEDIA_CONCURRENCY',
    'CHAT_HISTORY_MEDIA_BUDGET_BYTES',
    // Same parseInt read: `1h` became a 1 ms orphan sweep, re-walking all stored media every tick.
    'CHAT_MEDIA_ARCHIVE_MAX_BYTES',
    'CHAT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS',
    'CHAT_MEDIA_ORPHAN_GRACE_MS',
    'STATUS_MEDIA_MAX_BYTES',
    'STATUS_ORPHAN_SWEEP_INTERVAL_MS',
    'STATUS_ORPHAN_GRACE_MS',
    'S3_REPROBE_INTERVAL_MS',
    // Same parseInt read: `1h` deleted a fresh export archive after 1 ms, and a `24h` sweep age made
    // the boot sweep delete every archive older than 24 ms, breaking export, restart, import.
    'STORAGE_EXPORT_TTL_MS',
    'STORAGE_EXPORT_SWEEP_MAX_AGE_MS',
    // Same parseInt read: `5mb` became a 5-byte plugin download cap, `30s` a 30 ms capability timeout
    // and `64k` a 64-character template render cap.
    'PLUGIN_DOWNLOAD_MAX_BYTES',
    'PLUGIN_STORAGE_MAX_BYTES',
    'PLUGIN_CAP_TIMEOUT_MS',
    'TEMPLATE_RENDER_MAX_CHARS',
    'STORAGE_IMPORT_MAX_BYTES',
    'STORAGE_IMPORT_MAX_ENTRIES',
    'STORAGE_IMPORT_MAX_TOTAL_BYTES',
    'STORAGE_LIST_MAX_FILES',
    'BAILEYS_MESSAGE_STORE_LIMIT',
    // Each read fell back to its default on 0 or garbage, or passed a negative or fractional value on
    // (SEARCH_LIMIT_MAX reached plugin search providers as-is).
    'SEARCH_LIMIT_MAX',
    'INGRESS_MAX_ATTEMPTS',
    'WEBHOOK_WORKER_CONCURRENCY',
    'INGRESS_WORKER_CONCURRENCY',
  ]) {
    checkPositiveInt(key);
  }

  // The body cap takes a unit string. A spelling the parser does not know (`50M`, `50MiB`) silently
  // becomes the 25mb default, and a value that parses to 0 bytes refuses every request carrying a
  // body, the same self-DoS INFLIGHT_BODY_BUDGET_BYTES is refused for above.
  const bodyLimit = str('BODY_SIZE_LIMIT');
  if (bodyLimit !== undefined && (resolveBodyLimit(bodyLimit) !== bodyLimit || parseBodyLimitBytes(bodyLimit) < 1)) {
    errors.push(
      `BODY_SIZE_LIMIT must be a positive size such as 25mb or 1048576 (units b, kb, mb, gb, tb, pb; got "${bodyLimit}")`,
    );
  }

  // The ceiling matters for the same reason from the other side: the docs forbid 0, so an operator
  // who wants an effectively unlimited budget reaches for a row of nines. Rejected at boot rather
  // than clamped, so they learn the value they wrote is not the value they would have got.
  // Every knob below becomes a timer delay, where Node's overflow turns a long wait into a 1 ms spin.
  for (const [key, consequence] of [
    ['PUPPETEER_PROTOCOL_TIMEOUT_MS', 'the browser never finishes launching'],
    ['MEDIA_CONVERSION_TIMEOUT_MS', 'every conversion is killed as timed out'],
    ['CHAT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS', 'the orphan sweep reruns every millisecond'],
    ['STATUS_ORPHAN_SWEEP_INTERVAL_MS', 'the orphan sweep reruns every millisecond'],
    ['S3_REPROBE_INTERVAL_MS', 'S3 is re-probed every millisecond while it is down'],
    ['STORAGE_EXPORT_TTL_MS', 'the export archive is deleted about 1 ms after it is written'],
    ['SESSION_TAKEOVER_SWEEP_MS', 'the takeover sweep reruns every millisecond'],
    ['SESSION_LEASE_HEARTBEAT_MS', 'the lease heartbeat renews every millisecond'],
    ['SESSION_PROXY_TIMEOUT_MS', 'every proxied request times out after 1 ms'],
    ['MEDIA_DOWNLOAD_TIMEOUT_MS', 'every media download fails'],
    ['WEBHOOK_TIMEOUT', 'every webhook delivery fails'],
    ['RATE_LIMIT_SHORT_TTL', 'each hit expires after 1 ms and that rate-limit tier never blocks'],
    ['RATE_LIMIT_MEDIUM_TTL', 'each hit expires after 1 ms and that rate-limit tier never blocks'],
    ['RATE_LIMIT_LONG_TTL', 'each hit expires after 1 ms and that rate-limit tier never blocks'],
    ['INGRESS_INSTANCE_TTL', 'each hit expires after 1 ms and the ingress rate limits never block'],
    ['SSRF_DNS_TIMEOUT_MS', 'every guarded DNS lookup times out, failing webhook deliveries and URL downloads'],
    // 0 still disables these three, so they carry only the ceiling, not the positive-only check.
    ['MESSAGE_REAPER_INTERVAL_MS', 'the pending message reaper reruns every millisecond'],
    ['WEBHOOK_RECONCILE_INTERVAL_MS', 'the webhook reconciler reruns every millisecond'],
    ['INGRESS_RECONCILE_INTERVAL_MS', 'the ingress reconciler reruns every millisecond'],
    // 0 disables these two as well; pg arms both with a plain setTimeout.
    ['DATABASE_CONNECTION_TIMEOUT_MS', 'every pool connect times out'],
    ['DATABASE_IDLE_TIMEOUT_MS', 'each idle pool connection is closed 1 ms after release'],
  ]) {
    const raw = str(key);
    const n = raw !== undefined && DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(n) && n > MAX_TIMER_MS) {
      errors.push(
        `${key} must not exceed ${MAX_TIMER_MS} ms (got "${raw}"): Node's ` +
          `timers overflow above that and fire after 1 ms, so ${consequence}`,
      );
    }
  }
  // Not a Node timer, but the same ceiling: PostgreSQL's statement_timeout is an int capped at
  // 2147483647, and a larger startup value is refused on every runtime connection. 0 still disables.
  const statementTimeout = str('DATABASE_STATEMENT_TIMEOUT_MS');
  if (
    statementTimeout !== undefined &&
    DECIMAL_INTEGER.test(statementTimeout) &&
    Number(statementTimeout) > MAX_TIMER_MS
  ) {
    errors.push(
      `DATABASE_STATEMENT_TIMEOUT_MS must not exceed ${MAX_TIMER_MS} ms (got "${statementTimeout}"): ` +
        'PostgreSQL refuses a larger statement_timeout, so every runtime connection fails',
    );
  }
  // Knobs armed at a multiple of their value get that fraction of the timer's ceiling. Send verbs arm
  // four times PLUGIN_CAP_TIMEOUT_MS (SEND_CAP_TIMEOUT_FACTOR in plugin-worker-host.ts); a direct
  // (queue-off) webhook delivery doubles WEBHOOK_RETRY_DELAY on each retry, up to 2^3 for the maximum
  // retryCount of 5.
  for (const [key, factor, multiple, consequence] of [
    ['PLUGIN_CAP_TIMEOUT_MS', 4, 'send verbs wait four times this long', 'every plugin send times out'],
    [
      'WEBHOOK_RETRY_DELAY',
      8,
      'the last direct-delivery retry waits eight times this long',
      'webhook retries fire back to back',
    ],
  ] as const) {
    const raw = str(key);
    const max = Math.floor(MAX_TIMER_MS / factor);
    if (raw !== undefined && DECIMAL_INTEGER.test(raw) && Number(raw) > max) {
      errors.push(
        `${key} must not exceed ${max} ms (got "${raw}"): ${multiple}, ` +
          `and Node's timers overflow above that and fire after 1 ms, so ${consequence}`,
      );
    }
  }

  // A heartbeat that does not fit inside the lease renews too late to matter: the claim lapses
  // between ticks, peers adopt sessions from a perfectly healthy node, and nothing in the logs says
  // why. The defaults must be substituted for whatever is unset — validating only the key the
  // operator happened to set would let a lone oversized heartbeat through.
  const leaseTtlMs = Number(str('SESSION_LEASE_TTL_MS') ?? '60000');
  const heartbeatMs = Number(str('SESSION_LEASE_HEARTBEAT_MS') ?? '20000');
  // Strictly LESS than half: at exactly half, two renewals span the whole TTL, so a single missed
  // renewal lands on the expiry instant — a tie that any scheduling jitter turns into a lapse. A
  // margin below half is what lets one late or failed renewal still land inside the lease.
  if (Number.isInteger(leaseTtlMs) && Number.isInteger(heartbeatMs) && heartbeatMs * 2 >= leaseTtlMs) {
    errors.push(
      `SESSION_LEASE_HEARTBEAT_MS (${heartbeatMs}) must be less than half of SESSION_LEASE_TTL_MS (${leaseTtlMs}) ` +
        'so a renewal that is late or fails once still lands inside the lease',
    );
  }

  // The forwarder builds an absolute URL from this; a value without a scheme parses as something
  // unusable (`localhost:2785` reads as the scheme `localhost:`) and only fails at the first
  // forward, as a 500 on a request that had nothing wrong with it. Embedded credentials
  // (`http://user:pw@host`) parse fine here but undici's fetch rejects them outright — every
  // forward would 503 permanently, with the credentials sitting in sessions.nodeUrl — so refuse
  // those at boot too rather than let them reach the DB and the first forward.
  const nodeUrl = str('NODE_URL');
  if (nodeUrl) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(nodeUrl);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.push(`NODE_URL must be an absolute http(s) URL (got "${nodeUrl}")`);
    } else if (parsed.username || parsed.password) {
      errors.push('NODE_URL must not embed credentials — the forwarder cannot send a URL with a userinfo component');
    }
  }

  // Boolean feature flags read at module-eval time (app.module.ts) with a bare `=== 'true'` /
  // `!== 'false'` comparison: a typo (`True`, `1`, `yes`) or trailing whitespace/CR silently
  // (dis)ables the feature. Validate the RAW value — NOT a trimmed one — so `'true '` / `'true\r'`
  // (a Windows-edited env file forwarded verbatim by `docker run --env-file`) is rejected too rather
  // than passing validation while every read site reads it as false. Blank (a compose `${KEY:-}`
  // forward) stays legal: it behaves as unset at every read site.
  const checkBool = (key: string): void => {
    const raw = config[key];
    if (raw === undefined) return;
    if (typeof raw !== 'string') {
      errors.push(`${key} must be "true" or "false"`);
      return;
    }
    if (raw.trim() === '') return;
    if (raw !== 'true' && raw !== 'false') {
      errors.push(`${key} must be "true" or "false" (got ${JSON.stringify(raw)})`);
    }
  };
  for (const key of [
    'QUEUE_ENABLED',
    'MCP_ENABLED',
    'SERVE_DASHBOARD',
    'AUTO_START_SESSIONS',
    'STATUS_SEED_ON_READY',
    'STORE_EPHEMERAL_MESSAGES',
    'RESOLVE_LID_TO_PHONE',
    'SIMULATE_TYPING',
    'SEARCH_ENABLED',
    // Read at boot by the throttler factory (app.module.ts) and CacheService with `=== 'true'`: a
    // typo like `ture` silently downgrades rate-limit storage + cache to per-process in-memory.
    'REDIS_ENABLED',
    // `=== 'true'` in redis-options.ts: a typo silently connects in plaintext to a Redis the operator
    // expected to reach over TLS, which a TLS-only managed Redis then refuses.
    'REDIS_TLS',
    // Read by the SSRF guard's redirect loop with `=== 'true'`: a typo silently keeps the secure
    // default, but an accidental 'true'-ish string is not the flag the operator meant to audit.
    'PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS',
    // Read with `=== 'true'`, so a typo leaves sends unpaced — the silent failure this whole
    // feature exists to avoid, and invisible without this check.
    'SEND_PACING_ENABLED',
    // Opt-in feature flags read with `=== 'true'`: a typo silently leaves the feature OFF, so the
    // conversion/archive endpoints answer as if nothing was configured. Same class as the above.
    'MEDIA_CONVERSION_ENABLED',
    'CHAT_MEDIA_ARCHIVE_ENABLED',
    'CHAT_MEDIA_ARCHIVE_OUTBOUND',
    // Read with `=== 'true'` in BOTH configuration.ts and data-source.ts, and this is the one whose
    // typo fails OPEN: `DATABASE_SSL=require` is the natural Postgres spelling and reads as OFF, so
    // credentials and message bodies cross the wire in plaintext to a server the operator believed
    // was TLS-protected. Nothing logs it.
    'DATABASE_SSL',
    // `!== 'false'`, so a typo keeps the SECURE value — but it is still not the flag the operator set,
    // and it is only meaningful alongside DATABASE_SSL above.
    'DATABASE_SSL_REJECT_UNAUTHORIZED',
    // `=== 'true'`: a typo keeps the main connection on its migrations, so an operator who meant to
    // opt into synchronize for api_keys/audit_logs silently does not get it.
    'MAIN_DATABASE_SYNCHRONIZE',
    // Read with `=== 'true'` by the plugin ingress gate: a typo turns an intentional
    // `ALLOW_UNSIGNED_INGRESS=true` back off, and a route the operator meant to open stops loading.
    'ALLOW_UNSIGNED_INGRESS',
    // `=== 'true'`; already refused outright in production, but a typo in development silently
    // withholds the dev key the operator asked for.
    'ALLOW_DEV_API_KEY',
    // `!== 'false'`: a typo keeps SSRF protection on (safe) or contact enrichment off — either way
    // the webhook payload an integrator receives is not the one the operator configured.
    'WEBHOOK_SSRF_PROTECT',
    'WEBHOOK_CONTACT_DETAILS',
    // `!== 'false'`: a typo keeps caller-supplied URL fetches on the session proxy, the safe value,
    // but an operator whose proxy cannot reach arbitrary media hosts asked for the opposite and
    // would see every send-by-URL on a proxied session fail instead.
    'SESSION_PROXY_URL_FETCH',
    // `=== 'false'`: a typo leaves the outbound release check on when the operator asked for it off.
    'UPDATE_CHECK_ENABLED',
    // Engine behaviour flags: a typo leaves full-history sync off, or leaves the account marked
    // online on connect (#871 — it suppresses notifications on the operator's own phone).
    'BAILEYS_SYNC_FULL_HISTORY',
    'BAILEYS_MARK_ONLINE_ON_CONNECT',
    // Read with `=== 'true'` by DockerService. A typo does not fail silently here — it voids the
    // built-in-datastore credential exemption and the production boot refuses with a confusing
    // complaint about DATABASE_PASSWORD instead of naming the real cause.
    'POSTGRES_BUILTIN',
    'REDIS_BUILTIN',
    'MINIO_BUILTIN',
    // Perf/observability only, but same silent-typo class.
    'CACHE_ENABLED',
    'DATABASE_LOGGING',
    // Exact 'true'/'false' overrides; any other spelling silently falls back to the NODE_ENV default,
    // so `CSP_UPGRADE_INSECURE_REQUESTS=False` kept the blank-dashboard upgrade on in production and a
    // `PLUGIN_INSTALL_REQUIRE_PIN=True` outside production left the integrity pin unenforced.
    'CSP_UPGRADE_INSECURE_REQUESTS',
    'ENABLE_SWAGGER',
    'VALIDATION_ERROR_DETAIL',
    'PLUGIN_INSTALL_REQUIRE_PIN',
    // `=== 'true'` in the SSRF guard: a typo keeps redirects refused when the operator allowed them.
    'WEBHOOK_SSRF_REDIRECTS',
    // DELIBERATELY NOT LISTED. `MCP_READONLY` is read `!== 'false'` and mcp.server.spec.ts asserts
    // that `yes` keeps it read-only — a tolerance the repo tests on purpose. `PUPPETEER_HEADLESS` is
    // read `!== 'false'` and `new` is a real Puppeteer value that works today. Both fail toward the
    // safe state, so strictness here would refuse working deployments to no benefit.
  ]) {
    checkBool(key);
  }

  // MEDIA_DOWNLOAD_ENABLED is the one boolean whose read site NORMALISES before comparing
  // (`inbound-media-cap.ts` trims and lowercases, then treats 'false'/'0'/'no' as off), so the strict
  // check above would reject spellings that demonstrably work — inbound-media-cap.spec.ts asserts
  // 'FALSE' and ' false ' disable. What normalising cannot save it from is a MISSPELLING: every
  // unrecognised value means ENABLED, so `fasle` leaves inbound media being decrypted and
  // base64-inlined into every message row, up to MEDIA_DOWNLOAD_MAX_BYTES apiece — the most
  // expensive behaviour the gateway has, chosen by an operator who asked for the opposite. So accept
  // exactly the vocabulary the read site understands, and fail the boot on anything else.
  const LENIENT_BOOL_VALUES = new Set(['true', '1', 'yes', 'false', '0', 'no']);
  const lenientBoolKey = 'MEDIA_DOWNLOAD_ENABLED';
  const lenientRaw = config[lenientBoolKey];
  if (lenientRaw !== undefined) {
    if (typeof lenientRaw !== 'string') {
      errors.push(`${lenientBoolKey} must be one of true/false/1/0/yes/no`);
    } else {
      const normalized = lenientRaw.trim().toLowerCase();
      if (normalized !== '' && !LENIENT_BOOL_VALUES.has(normalized)) {
        errors.push(
          `${lenientBoolKey} must be one of true/false/1/0/yes/no (got ${JSON.stringify(lenientRaw)}) — ` +
            'an unrecognised value silently means ENABLED',
        );
      }
    }
  }

  // SEARCH_PROVIDER enum: 'auto' selects the built-in DB full-text provider at runtime, 'builtin-fts'
  // pins it explicitly, 'none' keeps the module and route mounted but registers no provider, so
  // /search returns 501; use SEARCH_ENABLED=false to omit the module entirely (route 404). Plugin ids
  // become selectable once the provider registry lands. Reject a typo at boot rather than silently
  // falling back to auto.
  // Raw read (not `str(...)`) so an untrimmed bogus value like `'auto '` is rejected, matching the
  // raw-value philosophy of `checkBool` above; also lets unit tests drive the check via the `config`
  // object instead of reaching into `process.env`.
  const provider = config['SEARCH_PROVIDER'] as string | undefined;
  if (provider !== undefined && provider !== '' && !['auto', 'builtin-fts', 'none'].includes(provider)) {
    errors.push(`SEARCH_PROVIDER must be one of: auto, builtin-fts, none (got ${JSON.stringify(provider)})`);
  }

  // LOG_LEVEL is read in main.ts by exact match after trim+toLowerCase, so any casing works today
  // and only a MISSPELLING differs: every unrecognised value silently means INFO, which is MORE
  // logging than the operator asked for (Nest-adjacent spellings like 'log', 'trace' or 'fatal'
  // included, none of them this repo's vocabulary). Validate the normalised form, mirroring the
  // read site exactly (same philosophy as MEDIA_DOWNLOAD_ENABLED above): nothing that works today
  // is refused, and a misspelling fails the boot instead of quietly logging at info.
  const LOG_LEVEL_VALUES = ['error', 'warn', 'info', 'debug', 'verbose'];
  const rawLogLevel = str('LOG_LEVEL');
  if (rawLogLevel !== undefined && !LOG_LEVEL_VALUES.includes(rawLogLevel.toLowerCase())) {
    errors.push(
      `LOG_LEVEL must be one of ${LOG_LEVEL_VALUES.map(v => `"${v}"`).join(', ')} (got ${JSON.stringify(rawLogLevel)})`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
