import { resolve } from 'path';

type EnvConfig = Record<string, unknown>;

// Default SQLite file of the 'main' (auth/audit) connection. The runtime path is env-overridable via
// MAIN_DATABASE_NAME (configuration.ts), so the collision guard below must resolve the EFFECTIVE
// path — comparing against this constant alone would false-negative when MAIN_DATABASE_NAME moves
// the main DB and DATABASE_NAME follows it, and false-positive when the main DB moved away but
// DATABASE_NAME still points at the (now unused) default file.
const MAIN_DB_DEFAULT_PATH = './data/main.sqlite';

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
  const dataDbName = read('DATABASE_NAME');
  if (!dataDbName) return null;
  const mainDbPath = read('MAIN_DATABASE_NAME') || MAIN_DB_DEFAULT_PATH;
  if (resolve(dataDbName) === resolve(mainDbPath)) {
    return `DATABASE_NAME must not point at the main database file (${mainDbPath}); use a separate file`;
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

  const dbType = str('DATABASE_TYPE');
  if (dbType && dbType !== 'sqlite' && dbType !== 'postgres') {
    errors.push(`DATABASE_TYPE must be "sqlite" or "postgres" (got "${dbType}")`);
  }

  // Whitelist the registered engine/storage ids so a typo fails fast at boot instead of silently
  // falling back to the default (engine.factory swallows an unknown ENGINE_TYPE → legacy wwebjs;
  // STORAGE_TYPE → local). Values must match the ids registered in engine.factory / configuration.
  const checkEnum = (key: string, allowed: string[]): void => {
    const value = str(key);
    if (value !== undefined && !allowed.includes(value)) {
      errors.push(`${key} must be one of ${allowed.map(v => `"${v}"`).join(', ')} (got "${value}")`);
    }
  };
  checkEnum('ENGINE_TYPE', ['whatsapp-web.js', 'baileys']);
  checkEnum('STORAGE_TYPE', ['local', 's3']);

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
    const pgSchema = str('POSTGRES_SCHEMA');
    if (pgSchema !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(pgSchema)) {
        errors.push(
          `POSTGRES_SCHEMA must be a valid Postgres identifier (a letter or underscore, then letters/digits/underscores, max 63 chars; got ${JSON.stringify(pgSchema)})`,
        );
      } else if (pgSchema.toLowerCase().startsWith('pg_')) {
        errors.push(`POSTGRES_SCHEMA must not use the reserved "pg_" prefix (got ${JSON.stringify(pgSchema)})`);
      }
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

  const checkPort = (key: string): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push(`${key} must be an integer port in [1, 65535] (got "${raw}")`);
    }
  };
  checkPort('PORT');
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
    'RATE_LIMIT_SHORT_TTL',
    'RATE_LIMIT_MEDIUM_TTL',
    'RATE_LIMIT_LONG_TTL',
    'WEBHOOK_RETRY_DELAY',
    'DATABASE_POOL_SIZE',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_IDLE_TIMEOUT_MS',
    'DATABASE_CONNECTION_TIMEOUT_MS',
    'REDIS_CONNECT_TIMEOUT_MS',
    'MAX_CONCURRENT_SESSIONS', // 0 = unlimited
    'INGRESS_INSTANCE_TTL',
    'WEBHOOK_DISPATCH_MAX_QUEUED',
    'STATS_CACHE_TTL_MS', // 0 = memo disabled
    'WEBHOOK_MAX_PER_SESSION', // 0 = unlimited
    'AUTOMATION_MAX_PER_SESSION', // 0 = unlimited
    'WEBHOOK_MEDIA_INLINE_MAX_BYTES', // 0 = never inline media
  ]) {
    checkNonNegativeInt(key);
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
    // WebSocket (/events) limits: 0 would disable a tier entirely (a self-DoS on the WS surface).
    'WS_RATE_LIMIT_FRAME_PER_SECOND',
    'WS_RATE_LIMIT_FRAME_BURST',
    'WS_RATE_LIMIT_HANDSHAKE_MAX',
    'WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS',
    'WS_MAX_SOCKETS_PER_KEY',
    'WEBHOOK_TIMEOUT',
    'INGRESS_INSTANCE_LIMIT',
    'REQUEST_TIMEOUT_MS',
    'HEADERS_TIMEOUT_MS',
    'KEEPALIVE_TIMEOUT_MS',
    'WEBHOOK_DISPATCH_CONCURRENCY',
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
  ]) {
    checkPositiveInt(key);
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
  ]) {
    checkBool(key);
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

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
