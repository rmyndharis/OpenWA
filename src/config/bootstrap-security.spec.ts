import {
  resolveCorsPolicy,
  isSwaggerEnabled,
  isValidationErrorDetailEnabled,
  isUpgradeInsecureRequestsEnabled,
  resolveBodyLimit,
  assertNoDefaultSecretsInProduction,
  isApiKeyPepperMissingInProduction,
} from './bootstrap-security';

describe('resolveCorsPolicy', () => {
  it('defaults to wildcard in development, without credentials', () => {
    expect(resolveCorsPolicy(undefined, 'development')).toEqual({
      origins: ['*'],
      allowAnyOrigin: true,
      credentials: false,
    });
  });

  it('honors an explicit allowlist and enables credentials (no wildcard)', () => {
    expect(resolveCorsPolicy('https://a.com, https://b.com', 'production')).toEqual({
      origins: ['https://a.com', 'https://b.com'],
      allowAnyOrigin: false,
      credentials: true,
    });
  });

  it('REFUSES a wildcard origin in production (collapses to same-origin, no credentials)', () => {
    expect(resolveCorsPolicy('*', 'production')).toEqual({
      origins: [],
      allowAnyOrigin: false,
      credentials: false,
    });
  });

  it('treats the default (unset) as wildcard-blocked in production', () => {
    expect(resolveCorsPolicy(undefined, 'production')).toEqual({
      origins: [],
      allowAnyOrigin: false,
      credentials: false,
    });
  });

  it('still allows wildcard in development', () => {
    expect(resolveCorsPolicy('*', 'development').allowAnyOrigin).toBe(true);
  });
});

describe('isUpgradeInsecureRequestsEnabled', () => {
  it('keeps the legacy default: on in production, off elsewhere (unset)', () => {
    expect(isUpgradeInsecureRequestsEnabled(undefined, 'production')).toBe(true);
    expect(isUpgradeInsecureRequestsEnabled(undefined, 'development')).toBe(false);
    expect(isUpgradeInsecureRequestsEnabled(undefined)).toBe(false);
  });
  it('lets an explicit value override NODE_ENV', () => {
    // HTTP-only private-network prod opts OUT so the dashboard stays reachable (#611)
    expect(isUpgradeInsecureRequestsEnabled('false', 'production')).toBe(false);
    // and it can be forced on outside production
    expect(isUpgradeInsecureRequestsEnabled('true', 'development')).toBe(true);
  });
  it('treats any non-"true"/"false" value as unset (falls back to NODE_ENV)', () => {
    expect(isUpgradeInsecureRequestsEnabled('', 'production')).toBe(true);
    expect(isUpgradeInsecureRequestsEnabled('1', 'development')).toBe(false);
  });
});

describe('isSwaggerEnabled', () => {
  it('is on by default (unset)', () => {
    expect(isSwaggerEnabled(undefined)).toBe(true);
  });
  it('is off only for the literal "false"', () => {
    expect(isSwaggerEnabled('false')).toBe(false);
    expect(isSwaggerEnabled('true')).toBe(true);
    expect(isSwaggerEnabled('')).toBe(true);
  });
  it('defaults OFF in production unless explicitly enabled (recon hygiene)', () => {
    expect(isSwaggerEnabled(undefined, 'production')).toBe(false);
    expect(isSwaggerEnabled('', 'production')).toBe(false);
    expect(isSwaggerEnabled('true', 'production')).toBe(true); // explicit opt-in still honored
    expect(isSwaggerEnabled('false', 'production')).toBe(false);
    // non-production is unchanged (default on)
    expect(isSwaggerEnabled(undefined, 'development')).toBe(true);
  });
});

describe('isValidationErrorDetailEnabled', () => {
  it('shows detail outside production but hides it in production by default (unchanged default)', () => {
    expect(isValidationErrorDetailEnabled(undefined, 'development')).toBe(true);
    expect(isValidationErrorDetailEnabled(undefined, 'production')).toBe(false);
    expect(isValidationErrorDetailEnabled('', 'production')).toBe(false);
  });
  it('honors an explicit opt-in/out regardless of env', () => {
    expect(isValidationErrorDetailEnabled('true', 'production')).toBe(true); // debug an SDK against prod
    expect(isValidationErrorDetailEnabled('false', 'development')).toBe(false);
  });
});

describe('resolveBodyLimit', () => {
  it('defaults to a media-aware 25mb', () => {
    expect(resolveBodyLimit(undefined)).toBe('25mb');
    expect(resolveBodyLimit('')).toBe('25mb');
  });
  it('honors an explicit limit', () => {
    expect(resolveBodyLimit('5mb')).toBe('5mb');
  });
  it('falls back to the default for a value the body-size parser cannot understand (which would silently disable the cap)', () => {
    expect(resolveBodyLimit('unlimited')).toBe('25mb');
    expect(resolveBodyLimit('none')).toBe('25mb');
    expect(resolveBodyLimit('abc')).toBe('25mb');
  });
  it('still honors valid numeric/unit limits, preserving case and unit', () => {
    expect(resolveBodyLimit('10MB')).toBe('10MB');
    expect(resolveBodyLimit('1024')).toBe('1024');
    expect(resolveBodyLimit('1.5gb')).toBe('1.5gb');
  });
});

describe('assertNoDefaultSecretsInProduction', () => {
  it('is a no-op outside production, even with default secrets', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'development',
        databaseType: 'postgres',
        databasePassword: 'openwa',
        storageType: 's3',
        s3AccessKey: 'minioadmin',
        s3SecretKey: 'minioadmin',
      }),
    ).not.toThrow();
  });

  it('refuses prod with a default Postgres password', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'openwa',
      }),
    ).toThrow(/DATABASE_PASSWORD/);
  });

  it('refuses prod with an empty Postgres password', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({ nodeEnv: 'production', databaseType: 'postgres', databasePassword: '' }),
    ).toThrow(/DATABASE_PASSWORD/);
  });

  it('allows the built-in Postgres/MinIO default credentials in prod (internal-only network) (#488 review)', () => {
    // The bundled containers are reachable only on the internal Docker network (not published), so the
    // known 'openwa'/'minioadmin' creds the built-in flow provisions must not crash-loop a prod boot.
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'openwa',
        postgresBuiltIn: 'true',
        storageType: 's3',
        s3AccessKey: 'minioadmin',
        s3SecretKey: 'minioadmin',
        minioBuiltIn: 'true',
      }),
    ).not.toThrow();
  });

  it('still refuses an EXTERNAL Postgres with a default password even when MinIO is built-in', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'openwa',
        postgresBuiltIn: 'false',
      }),
    ).toThrow(/DATABASE_PASSWORD/);
  });

  it('does NOT exempt a weak secret when the built-in flag is set but the host is EXTERNAL', () => {
    // POSTGRES_BUILTIN=true but DATABASE_HOST points at a reachable external DB → still enforced.
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'openwa',
        postgresBuiltIn: 'true',
        databaseHost: 'db.example.com',
      }),
    ).toThrow(/DATABASE_PASSWORD/);
    // MINIO_BUILTIN=true but S3_ENDPOINT is an external bucket → still enforced.
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        storageType: 's3',
        s3AccessKey: 'minioadmin',
        s3SecretKey: 'minioadmin',
        minioBuiltIn: 'true',
        s3Endpoint: 'https://s3.amazonaws.com',
      }),
    ).toThrow(/S3_ACCESS_KEY/);
  });

  it('exempts the built-in defaults when the host is the internal bundled service', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'openwa',
        postgresBuiltIn: 'true',
        databaseHost: 'postgres',
        storageType: 's3',
        s3AccessKey: 'minioadmin',
        s3SecretKey: 'minioadmin',
        minioBuiltIn: 'true',
        s3Endpoint: 'http://minio:9000',
      }),
    ).not.toThrow();
  });

  it('refuses prod with default MinIO/S3 credentials', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        storageType: 's3',
        s3AccessKey: 'minioadmin',
        s3SecretKey: 'minioadmin',
      }),
    ).toThrow(/S3_ACCESS_KEY, S3_SECRET_KEY/);
  });

  it('refuses prod with a placeholder API_MASTER_KEY', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', apiMasterKey: 'dev-master-key' })).toThrow(
      /API_MASTER_KEY/,
    );
  });

  it('refuses prod when ALLOW_DEV_API_KEY=true (it seeds the public dev-admin-key as ADMIN)', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', allowDevApiKey: 'true' })).toThrow(
      /ALLOW_DEV_API_KEY/,
    );
  });

  it('refuses prod with API_MASTER_KEY set to the well-known dev-admin-key', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', apiMasterKey: 'dev-admin-key' })).toThrow(
      /API_MASTER_KEY/,
    );
  });

  it('allows ALLOW_DEV_API_KEY=true outside production (the dev opt-in still works)', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'development', allowDevApiKey: 'true' })).not.toThrow();
  });

  it('refuses prod with a placeholder REDIS_PASSWORD', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', redisPassword: 'changeme' })).toThrow(
      /REDIS_PASSWORD/,
    );
  });

  it('allows prod with an empty REDIS_PASSWORD (passwordless private-network Redis is supported)', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', redisPassword: '' })).not.toThrow();
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production' })).not.toThrow();
  });

  it('allows prod with a strong REDIS_PASSWORD', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({ nodeEnv: 'production', redisPassword: 'a-strong-unique-redis-secret' }),
    ).not.toThrow();
  });

  it('allows the default sqlite + local-storage prod setup (no secrets needed)', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({ nodeEnv: 'production', databaseType: 'sqlite', storageType: 'local' }),
    ).not.toThrow();
  });

  it('allows prod with strong, unique secrets', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'Xy7$kP2qLm9wRt4z',
        storageType: 's3',
        s3AccessKey: 'AKIA-not-default-123',
        s3SecretKey: 'long-random-secret-value-098',
      }),
    ).not.toThrow();
  });

  it('does not check the DB password when using sqlite', () => {
    // DATABASE_PASSWORD is irrelevant for sqlite, so a leftover default must not block boot.
    expect(() =>
      assertNoDefaultSecretsInProduction({ nodeEnv: 'production', databaseType: 'sqlite', databasePassword: 'openwa' }),
    ).not.toThrow();
  });

  it('refuses prod with common default passwords (123456, qwerty, root, test, demo)', () => {
    for (const weak of ['123456', 'qwerty', 'root', 'test', 'demo']) {
      expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', apiMasterKey: weak })).toThrow(
        /API_MASTER_KEY/,
      );
    }
  });

  it('matches blocklisted defaults case-insensitively', () => {
    expect(() => assertNoDefaultSecretsInProduction({ nodeEnv: 'production', apiMasterKey: 'QWERTY' })).toThrow(
      /API_MASTER_KEY/,
    );
    expect(() =>
      assertNoDefaultSecretsInProduction({ nodeEnv: 'production', databaseType: 'postgres', databasePassword: 'Root' }),
    ).toThrow(/DATABASE_PASSWORD/);
  });

  // Load-bearing invariant: the blocklist is an EXACT full-value match, never a substring scan, so
  // adding short words (test/root/demo) must not reject a strong secret that merely contains one.
  it('does not reject a strong secret that only contains a blocklisted word (exact match, not substring)', () => {
    expect(() =>
      assertNoDefaultSecretsInProduction({
        nodeEnv: 'production',
        databaseType: 'postgres',
        databasePassword: 'my-test-key-9f3',
      }),
    ).not.toThrow();
    expect(() =>
      assertNoDefaultSecretsInProduction({ nodeEnv: 'production', apiMasterKey: 'root-pw-8821x' }),
    ).not.toThrow();
  });
});

describe('isApiKeyPepperMissingInProduction', () => {
  it('is true in production when no pepper is set (incl. empty/whitespace)', () => {
    expect(isApiKeyPepperMissingInProduction('production', undefined)).toBe(true);
    expect(isApiKeyPepperMissingInProduction('production', '')).toBe(true);
    expect(isApiKeyPepperMissingInProduction('production', '   ')).toBe(true);
  });

  it('is false in production when a pepper is set', () => {
    expect(isApiKeyPepperMissingInProduction('production', 'a-real-server-pepper')).toBe(false);
  });

  it('is false outside production regardless of pepper (no dev warning noise)', () => {
    expect(isApiKeyPepperMissingInProduction('development', undefined)).toBe(false);
    expect(isApiKeyPepperMissingInProduction(undefined, undefined)).toBe(false);
  });
});
