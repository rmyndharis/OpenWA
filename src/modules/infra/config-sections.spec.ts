import { recordOsEnvKeys, recordPinnedEnvKeys } from '../../config/env-precedence';
import {
  applyDatabaseSection,
  applyRedisSection,
  applyStorageSection,
  type ConfigSectionContext,
} from './config-sections';

const cases: Array<readonly [string, string, boolean | undefined, string, boolean]> = [
  'database',
  'redis',
  'storage',
].flatMap(service =>
  ['omitted', 'same', 'changed'].flatMap(selection =>
    [undefined, true, false].flatMap(builtIn =>
      ['none', 'bundled', 'external'].map(pin => [service, selection, builtIn, pin, false] as const),
    ),
  ),
);
cases.push(
  ...['database', 'storage'].flatMap(service =>
    [undefined, true].flatMap(builtIn =>
      ['none', 'bundled', 'external'].map(pin => [service, 'changed', builtIn, pin, true] as const),
    ),
  ),
);
const envKeys = /^(DATABASE_|POSTGRES_|REDIS_|STORAGE_|S3_|MINIO_|QUEUE_|CACHE_)/;
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => envKeys.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  recordOsEnvKeys({});
  recordPinnedEnvKeys({});
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (envKeys.test(key)) delete process.env[key];
  Object.assign(process.env, previous);
  recordOsEnvKeys({});
  recordPinnedEnvKeys({});
});

it.each(cases)(
  '%s selection %s with builtIn %s and %s host pin, selection pinned %s',
  (service, selection, builtIn, pin, pinSelection) => {
    const changed = selection === 'changed';
    const ctx: ConfigSectionContext = { updates: {}, staleKeys: new Set(), profiles: [] };
    const existing: Record<string, string> =
      service === 'database'
        ? {
            DATABASE_TYPE: changed ? 'sqlite' : 'postgres',
            POSTGRES_BUILTIN: 'true',
            DATABASE_HOST: 'openwa-postgres',
            DATABASE_PORT: '6432',
            DATABASE_USERNAME: 'app',
            DATABASE_PASSWORD: 'StoredPassword123456',
            DATABASE_NAME: changed ? './data/openwa.sqlite' : 'appdb',
            POSTGRES_SCHEMA: 'tenant',
            DATABASE_SSL: 'false',
          }
        : service === 'redis'
          ? {
              REDIS_ENABLED: changed ? 'false' : 'true',
              REDIS_BUILTIN: 'true',
              REDIS_HOST: 'openwa-redis',
              REDIS_PORT: '6380',
              REDIS_PASSWORD: 'StoredRedis123456',
            }
          : {
              STORAGE_TYPE: changed ? 'local' : 's3',
              MINIO_BUILTIN: 'true',
              S3_ENDPOINT: 'http://openwa-minio:9000',
              S3_ACCESS_KEY: 'StoredKey123456',
              S3_SECRET_KEY: 'StoredSecret1234567890',
              S3_BUCKET: 'media',
              S3_REGION: 'eu-west-1',
            };
    const hostKey = service === 'database' ? 'DATABASE_HOST' : service === 'redis' ? 'REDIS_HOST' : 'S3_ENDPOINT';
    if (pin !== 'none') {
      const value =
        pin === 'bundled'
          ? existing[hostKey]
          : service === 'storage'
            ? 'https://storage.external.example'
            : 'external.example';
      process.env[hostKey] = value;
      recordPinnedEnvKeys({ [hostKey]: value });
    }
    if (pinSelection) {
      const key = service === 'database' ? 'DATABASE_TYPE' : 'STORAGE_TYPE';
      process.env[key] = service === 'database' ? 'postgres' : 's3';
      recordPinnedEnvKeys({
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => envKeys.test(name))),
        [key]: process.env[key],
      });
    }
    const expected = { ...existing };
    const flagKey =
      service === 'database' ? 'POSTGRES_BUILTIN' : service === 'redis' ? 'REDIS_BUILTIN' : 'MINIO_BUILTIN';
    if (builtIn !== undefined) expected[flagKey] = String(builtIn);
    if (selection !== 'omitted')
      expected[service === 'database' ? 'DATABASE_TYPE' : service === 'redis' ? 'REDIS_ENABLED' : 'STORAGE_TYPE'] =
        service === 'database' ? 'postgres' : service === 'redis' ? 'true' : 's3';

    if (service === 'database') {
      const fields =
        builtIn === false
          ? {
              host: 'new.external.example',
              port: '6433',
              username: 'newuser',
              password: 'NewPassword123456',
              database: 'newdb',
              schema: 'new_schema',
            }
          : {};
      applyDatabaseSection(
        {
          ...(selection === 'omitted' ? {} : { type: 'postgres' }),
          ...(builtIn === undefined ? {} : { builtIn }),
          ...fields,
        },
        existing,
        ctx,
      );
      if (builtIn === false)
        Object.assign(expected, {
          DATABASE_HOST: 'new.external.example',
          DATABASE_PORT: '6433',
          DATABASE_USERNAME: 'newuser',
          DATABASE_PASSWORD: 'NewPassword123456',
          DATABASE_NAME: 'newdb',
          POSTGRES_SCHEMA: 'new_schema',
        });
      else if (!(builtIn === undefined && pin === 'external' && !changed))
        Object.assign(expected, {
          DATABASE_HOST: 'postgres',
          DATABASE_PORT: '5432',
          DATABASE_USERNAME: !changed && pin !== 'external' ? 'app' : 'openwa',
          DATABASE_PASSWORD: changed ? 'openwa' : existing.DATABASE_PASSWORD,
          DATABASE_NAME: !changed && pin !== 'external' ? 'appdb' : 'openwa',
          POSTGRES_SCHEMA: !changed && pin !== 'external' ? 'tenant' : 'public',
        });
    } else if (service === 'redis') {
      const fields =
        builtIn === false ? { host: 'new.external.example', port: '6381', password: 'NewRedis123456' } : {};
      applyRedisSection(
        {
          ...(selection === 'omitted' ? {} : { enabled: true }),
          ...(builtIn === undefined ? {} : { builtIn }),
          ...fields,
        },
        existing,
        ctx,
      );
      if (builtIn === false)
        Object.assign(expected, {
          REDIS_HOST: 'new.external.example',
          REDIS_PORT: '6381',
          REDIS_PASSWORD: 'NewRedis123456',
        });
      else if (!(builtIn === undefined && pin === 'external')) {
        Object.assign(expected, { REDIS_HOST: 'redis', REDIS_PORT: '6379' });
        if (pin !== 'external') expected.REDIS_TLS = 'false';
        delete expected.REDIS_PASSWORD;
      }
    } else {
      const fields =
        builtIn === false
          ? {
              s3Endpoint: 'https://new.external.example',
              s3Bucket: 'new-bucket',
              s3Region: 'new-region',
              s3AccessKey: 'NewKey123456',
              s3SecretKey: 'NewSecret1234567890',
            }
          : {};
      applyStorageSection(
        {
          ...(selection === 'omitted' ? {} : { type: 's3' }),
          ...(builtIn === undefined ? {} : { builtIn }),
          ...fields,
        },
        existing,
        ctx,
      );
      if (builtIn === false) {
        delete expected.S3_ACCESS_KEY;
        delete expected.S3_SECRET_KEY;
        Object.assign(expected, {
          S3_ENDPOINT: 'https://new.external.example',
          S3_BUCKET: 'new-bucket',
          S3_REGION: 'new-region',
          S3_ACCESS_KEY_ID: 'NewKey123456',
          S3_SECRET_ACCESS_KEY: 'NewSecret1234567890',
        });
      } else if (!(builtIn === undefined && pin === 'external' && !changed))
        Object.assign(expected, {
          S3_ENDPOINT: 'http://minio:9000',
          S3_BUCKET: !changed && pin !== 'external' ? 'media' : 'openwa',
          S3_REGION: !changed && pin !== 'external' ? 'eu-west-1' : 'us-east-1',
          S3_ACCESS_KEY_ID: changed ? 'minioadmin' : existing.S3_ACCESS_KEY,
          S3_SECRET_ACCESS_KEY: changed ? 'minioadmin' : existing.S3_SECRET_KEY,
        });
    }
    const merged = { ...existing, ...ctx.updates };
    for (const key of ctx.staleKeys) delete merged[key];
    expect(merged).toEqual(expected);
  },
);

function savedValues(existing: Record<string, string>, ctx: ConfigSectionContext): Record<string, string> {
  const saved = { ...existing, ...ctx.updates };
  for (const key of ctx.staleKeys) delete saved[key];
  return saved;
}

function context(): ConfigSectionContext {
  return { updates: {}, staleKeys: new Set(), profiles: [] };
}

it.each(['true', 'false'])(
  'preserves stored bundled TLS keys beneath an external host pin with startup flag %s',
  flag => {
    process.env.DATABASE_HOST = 'db.external.example';
    process.env.DATABASE_SSL = 'true';
    recordPinnedEnvKeys({ DATABASE_HOST: process.env.DATABASE_HOST, DATABASE_SSL: 'true' });
    const existing = {
      DATABASE_TYPE: 'postgres',
      DATABASE_HOST: 'openwa-POSTGRES.',
      POSTGRES_BUILTIN: flag,
      DATABASE_PASSWORD: 'StoredPassword123456',
      DATABASE_SSL: 'false',
      DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    };
    const ctx = context();

    applyDatabaseSection({ type: 'postgres', sslEnabled: true, sslRejectUnauthorized: true }, existing, ctx);

    expect(savedValues(existing, ctx)).toEqual(existing);
  },
);

it.each([true, false])('writes explicitly chosen database TLS under an external host pin, builtIn %s', builtIn => {
  process.env.DATABASE_HOST = 'db.pinned.example';
  recordPinnedEnvKeys({ DATABASE_HOST: process.env.DATABASE_HOST });
  const existing = { DATABASE_TYPE: 'postgres', DATABASE_HOST: 'postgres', DATABASE_SSL: 'false' };
  const ctx = context();

  applyDatabaseSection({ builtIn, sslEnabled: true, sslRejectUnauthorized: false }, existing, ctx);

  expect(savedValues(existing, ctx)).toMatchObject({
    DATABASE_SSL: 'true',
    DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
  });
});

const credentialNames = [
  ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
  ['S3_ACCESS_KEY', 'S3_SECRET_KEY'],
] as const;

it.each(credentialNames)('removes inactive S3 credentials %s and %s when selecting local storage', (access, secret) => {
  const existing = {
    STORAGE_TYPE: 's3',
    S3_ENDPOINT: 'https://s3.old.example',
    [access]: 'StoredKey123456',
    [secret]: 'StoredSecret1234567890',
  };
  const ctx = context();

  applyStorageSection({ type: 'local' }, existing, ctx);

  expect(savedValues(existing, ctx)).toEqual({ STORAGE_TYPE: 'local', MINIO_BUILTIN: 'false' });
});

it.each(['true', 'false'])(
  'keeps only credentials belonging to the selected external database with startup flag %s',
  flag => {
    for (const type of ['postgres', 'sqlite']) {
      for (const host of ['db.external.example', ' OpenWA-POSTGRES. ']) {
        const existing = {
          DATABASE_TYPE: type,
          DATABASE_HOST: host,
          POSTGRES_BUILTIN: flag,
          DATABASE_PASSWORD: 'StoredPassword123456',
        };
        const ctx = context();

        applyDatabaseSection(
          { type: 'postgres', builtIn: false, host: 'db.external.example', password: '' },
          existing,
          ctx,
        );

        expect(savedValues(existing, ctx).DATABASE_PASSWORD).toBe(
          type === 'postgres' && host === 'db.external.example' ? 'StoredPassword123456' : undefined,
        );
      }
    }
  },
);

it.each(credentialNames)(
  'keeps only credentials %s and %s belonging to selected external S3 storage',
  (access, secret) => {
    for (const flag of ['true', 'false']) {
      for (const type of ['s3', 'local']) {
        for (const endpoint of ['https://s3.external.example', 'http://OpenWA-MINIO.:9000']) {
          const existing = {
            STORAGE_TYPE: type,
            S3_ENDPOINT: endpoint,
            MINIO_BUILTIN: flag,
            [access]: 'StoredKey123456',
            [secret]: 'StoredSecret1234567890',
          };
          const ctx = context();

          applyStorageSection(
            { type: 's3', builtIn: false, s3Endpoint: 'https://s3.external.example', s3AccessKey: '', s3SecretKey: '' },
            existing,
            ctx,
          );

          const saved = savedValues(existing, ctx);
          expect([saved[access], saved[secret]]).toEqual(
            type === 's3' && endpoint === 'https://s3.external.example'
              ? ['StoredKey123456', 'StoredSecret1234567890']
              : [undefined, undefined],
          );
        }
      }
    }
  },
);

it.each(credentialNames)('fresh S3 credentials replace inactive %s and %s', (access, secret) => {
  const existing = { STORAGE_TYPE: 'local', [access]: 'OldKey123456', [secret]: 'OldSecret1234567890' };
  const ctx = context();

  applyStorageSection(
    { type: 's3', builtIn: false, s3AccessKey: 'NewKey123456', s3SecretKey: 'NewSecret1234567890' },
    existing,
    ctx,
  );

  expect(savedValues(existing, ctx)).toMatchObject({
    S3_ACCESS_KEY_ID: 'NewKey123456',
    S3_SECRET_ACCESS_KEY: 'NewSecret1234567890',
  });
  expect(savedValues(existing, ctx).S3_ACCESS_KEY).toBeUndefined();
  expect(savedValues(existing, ctx).S3_SECRET_KEY).toBeUndefined();
});

it('does not carry the bundled S3 endpoint into a newly selected external service', () => {
  const ctx = context();
  const existing = { STORAGE_TYPE: 's3', MINIO_BUILTIN: 'false', S3_ENDPOINT: 'http://OpenWA-MINIO.:9000' };

  applyStorageSection(
    { builtIn: false, s3AccessKey: 'NewKey123456', s3SecretKey: 'NewSecret1234567890' },
    existing,
    ctx,
  );

  expect(savedValues(existing, ctx).S3_ENDPOINT).toBeUndefined();
});

it.each(['true', 'false'])('keeps external Redis credentials independently of startup flag %s', flag => {
  const existing = {
    REDIS_ENABLED: 'true',
    REDIS_BUILTIN: flag,
    REDIS_HOST: 'redis.external.example',
    REDIS_PASSWORD: 'StoredRedis123456',
  };
  const ctx = context();

  applyRedisSection({ enabled: true, builtIn: false, host: existing.REDIS_HOST, password: '' }, existing, ctx);

  expect(savedValues(existing, ctx).REDIS_PASSWORD).toBe('StoredRedis123456');
});

describe('Redis username ownership', () => {
  const existing = {
    REDIS_ENABLED: 'true',
    REDIS_BUILTIN: 'true',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6381',
    REDIS_USERNAME: 'worker',
    REDIS_PASSWORD: 'DummyRedisPassword123456',
    REDIS_TLS: 'false',
  };

  it.each([true, undefined])('clears a generated username for the bundled preset %s', builtIn => {
    const ctx = context();
    applyRedisSection({ enabled: true, builtIn, password: '' }, existing, ctx);
    expect(savedValues(existing, ctx).REDIS_USERNAME).toBeUndefined();
  });

  it('preserves the explicit preset tuple beside an external host pin', () => {
    process.env.REDIS_HOST = 'cache.external.invalid';
    recordPinnedEnvKeys({ REDIS_HOST: process.env.REDIS_HOST });
    const ctx = context();
    applyRedisSection({ enabled: true, builtIn: true, password: '' }, existing, ctx);
    const saved = savedValues(existing, ctx);
    expect(saved.REDIS_USERNAME).toBe('worker');
    expect(saved.REDIS_PORT).toBe('6379');
    expect(saved.REDIS_PASSWORD).toBeUndefined();
  });

  it('keeps a named external username when the choice stays external', () => {
    const ctx = context();
    applyRedisSection({ enabled: true, builtIn: false, host: 'cache.external.invalid', password: '' }, existing, ctx);
    expect(savedValues(existing, ctx).REDIS_USERNAME).toBe('worker');
  });
});

describe('PostgreSQL database name', () => {
  const external = { host: 'db.example.invalid', username: 'app', password: 'DummyPassword123456' };

  it.each([['sqlite'], [undefined]])('does not keep a SQLite file path as the name (stored type %s)', type => {
    const existing = { ...(type ? { DATABASE_TYPE: type } : {}), DATABASE_NAME: './data/customer.sqlite' };
    const ctx = context();
    applyDatabaseSection({ type: 'postgres', builtIn: false, ...external }, existing, ctx);
    expect(savedValues(existing, ctx)).not.toHaveProperty('DATABASE_NAME');
  });

  it.each([
    ['the host environment', true],
    ['the project .env', false],
  ])('keeps the stored name when %s alone sets the type to postgres', (_origin, host) => {
    process.env.DATABASE_TYPE = 'postgres';
    recordOsEnvKeys(host ? { DATABASE_TYPE: 'postgres' } : {});
    recordPinnedEnvKeys({ DATABASE_TYPE: 'postgres' });
    const existing = { DATABASE_NAME: 'appdb', DATABASE_HOST: 'db.example.invalid' };
    const ctx = context();
    applyDatabaseSection({ builtIn: false, ...external }, existing, ctx);
    expect(savedValues(existing, ctx).DATABASE_NAME).toBe('appdb');
  });

  it('still drops a SQLite file path when the environment pins the type to sqlite', () => {
    process.env.DATABASE_TYPE = 'sqlite';
    recordPinnedEnvKeys({ DATABASE_TYPE: 'sqlite' });
    const existing = { DATABASE_NAME: './data/customer.sqlite' };
    const ctx = context();
    applyDatabaseSection({ type: 'postgres', builtIn: false, ...external }, existing, ctx);
    expect(savedValues(existing, ctx)).not.toHaveProperty('DATABASE_NAME');
  });

  it('keeps the stored name of a PostgreSQL configuration and writes one that is sent', () => {
    const existing = { DATABASE_TYPE: 'postgres', DATABASE_NAME: 'appdb' };
    const kept = context();
    applyDatabaseSection({ type: 'postgres', builtIn: false, ...external }, existing, kept);
    expect(savedValues(existing, kept).DATABASE_NAME).toBe('appdb');
    const sent = context();
    applyDatabaseSection({ type: 'postgres', builtIn: false, ...external, database: 'other' }, existing, sent);
    expect(savedValues(existing, sent).DATABASE_NAME).toBe('other');
  });
});
