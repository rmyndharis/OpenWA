import {
  resolveCorsPolicy,
  isSwaggerEnabled,
  resolveBodyLimit,
  assertNoDefaultSecretsInProduction,
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

describe('isSwaggerEnabled', () => {
  it('is on by default (unset)', () => {
    expect(isSwaggerEnabled(undefined)).toBe(true);
  });
  it('is off only for the literal "false"', () => {
    expect(isSwaggerEnabled('false')).toBe(false);
    expect(isSwaggerEnabled('true')).toBe(true);
    expect(isSwaggerEnabled('')).toBe(true);
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
});
