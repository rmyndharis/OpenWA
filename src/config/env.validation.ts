import { resolve } from 'path';

type EnvConfig = Record<string, unknown>;

// The 'main' (auth/audit) connection is always this fixed SQLite file (not env-overridable).
const MAIN_DB_PATH = './data/main.sqlite';

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
    // lock contention. (Postgres DATABASE_NAME is a bare db name, so this never applies there.)
    const dataDbName = str('DATABASE_NAME');
    if (dataDbName && resolve(dataDbName) === resolve(MAIN_DB_PATH)) {
      errors.push(`DATABASE_NAME must not point at the main database file (${MAIN_DB_PATH}); use a separate file`);
    }
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

  const checkPort = (key: string): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = Number(raw);
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
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      errors.push(`${key} must be a non-negative integer (got "${raw}")`);
    }
  };
  for (const key of [
    'RATE_LIMIT_SHORT_TTL',
    'RATE_LIMIT_MEDIUM_TTL',
    'RATE_LIMIT_LONG_TTL',
    'WEBHOOK_MAX_RETRIES',
    'WEBHOOK_RETRY_DELAY',
    'DATABASE_POOL_SIZE',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_IDLE_TIMEOUT_MS',
    'DATABASE_CONNECTION_TIMEOUT_MS',
    'REDIS_CONNECT_TIMEOUT_MS',
    'MAX_CONCURRENT_SESSIONS', // 0 = unlimited
    'INGRESS_INSTANCE_TTL',
  ]) {
    checkNonNegativeInt(key);
  }

  // Some knobs are nonsensical at 0 and contradict the "non-negative" intent: a rate-limit LIMIT of 0
  // disables that tier's throttling (a self-DoS), and a webhook timeout of 0 aborts every delivery
  // immediately. Require a positive integer for these.
  const checkPositiveInt = (key: string): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`${key} must be a positive integer (got "${raw}")`);
    }
  };
  for (const key of [
    'RATE_LIMIT_SHORT_LIMIT',
    'RATE_LIMIT_MEDIUM_LIMIT',
    'RATE_LIMIT_LONG_LIMIT',
    'WEBHOOK_TIMEOUT',
    'INGRESS_INSTANCE_LIMIT',
    'REQUEST_TIMEOUT_MS',
    'HEADERS_TIMEOUT_MS',
    'KEEPALIVE_TIMEOUT_MS',
    'WEBHOOK_DISPATCH_CONCURRENCY',
  ]) {
    checkPositiveInt(key);
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
    'STORE_EPHEMERAL_MESSAGES',
    'RESOLVE_LID_TO_PHONE',
    'SIMULATE_TYPING',
    'SEARCH_ENABLED',
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
