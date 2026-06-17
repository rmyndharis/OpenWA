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

  if (str('TRANSLATION_ENABLED') === 'true' && !str('LIBRETRANSLATE_URL')) {
    errors.push('LIBRETRANSLATE_URL is required when TRANSLATION_ENABLED=true');
  }

  const checkInt = (key: string, min: number): void => {
    const raw = str(key);
    if (raw === undefined) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      errors.push(`${key} must be an integer >= ${min} (got "${raw}")`);
    }
  };
  checkInt('LIBRETRANSLATE_TIMEOUT_MS', 1);
  checkInt('TRANSLATION_MIN_LENGTH', 0);
  checkInt('TRANSLATION_MAX_LENGTH', 1);
  checkInt('TRANSLATION_THROTTLE_INTERVAL_MS', 0);

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
