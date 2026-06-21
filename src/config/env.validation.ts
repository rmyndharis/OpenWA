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
  } else {
    // SQLite (explicit or default): DATABASE_NAME is a file path for the 'data' connection. It must
    // not resolve to the 'main' DB file — two TypeORM connections on one SQLite file run separate
    // migration ledgers + synchronize policies against the same tables, risking schema divergence and
    // lock contention. (Postgres DATABASE_NAME is a bare db name, so this never applies there.)
    const dataDbName = str('DATABASE_NAME');
    if (dataDbName && resolve(dataDbName) === resolve(MAIN_DB_PATH)) {
      errors.push(`DATABASE_NAME must not point at the main database file (${MAIN_DB_PATH}); use a separate file`);
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
    'RATE_LIMIT_SHORT_LIMIT',
    'RATE_LIMIT_MEDIUM_TTL',
    'RATE_LIMIT_MEDIUM_LIMIT',
    'RATE_LIMIT_LONG_TTL',
    'RATE_LIMIT_LONG_LIMIT',
    'WEBHOOK_TIMEOUT',
    'WEBHOOK_MAX_RETRIES',
    'WEBHOOK_RETRY_DELAY',
    'DATABASE_POOL_SIZE',
  ]) {
    checkNonNegativeInt(key);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
