type EnvConfig = Record<string, unknown>;

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

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
