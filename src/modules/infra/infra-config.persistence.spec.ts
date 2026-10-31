import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from '../../config/app-validation';
import { recordOsEnvKeys, recordPinnedEnvKeys } from '../../config/env-precedence';
import { RestartDto } from './dto/restart.dto';
import { SaveConfigDto } from './dto/save-config.dto';
import { InfraConfigController } from './infra-config.controller';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: jest.fn(actual.writeFileSync), renameSync: jest.fn(actual.renameSync) };
});

const actualFs = jest.requireActual<typeof import('fs')>('fs');
const dotenv = jest.requireActual<typeof import('dotenv')>('dotenv');
const database = {
  DATABASE_TYPE: 'postgres',
  DATABASE_HOST: 'db.example.invalid',
  DATABASE_USERNAME: 'app',
  DATABASE_PASSWORD: 'DummyPassword123456',
};
const pinKeys = [
  'DATABASE_TYPE',
  'DATABASE_HOST',
  'DATABASE_SSL',
  'REDIS_HOST',
  'REDIS_TLS',
  'REDIS_USERNAME',
  'S3_ENDPOINT',
];
let directory: string;
let file: string;
let previous: Array<[string, string | undefined]>;

beforeEach(() => {
  directory = actualFs.mkdtempSync(path.join(os.tmpdir(), 'openwa-config-'));
  actualFs.mkdirSync(path.join(directory, 'data'));
  file = path.join(directory, 'data', '.env.generated');
  previous = pinKeys.map(key => [key, process.env[key]]);
  for (const key of pinKeys) delete process.env[key];
  recordOsEnvKeys({});
  recordPinnedEnvKeys({});
  jest.spyOn(process, 'cwd').mockReturnValue(directory);
  jest.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
  jest.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
  seed({});
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  recordOsEnvKeys(process.env);
  recordPinnedEnvKeys({});
  jest.restoreAllMocks();
  actualFs.rmSync(directory, { recursive: true, force: true });
});

function seed(values: Record<string, string>): void {
  const config = { DATABASE_TYPE: 'sqlite', STORAGE_TYPE: 'local', ENGINE_TYPE: 'baileys', ...values };
  actualFs.writeFileSync(
    file,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}

function build(available = true) {
  const stop = jest.fn().mockResolvedValue(true);
  const shutdown = jest.fn();
  return {
    stop,
    shutdown,
    controller: new InfraConfigController(
      { getAvailableEngines: () => [{ id: 'baileys' }, { id: 'whatsapp-web.js' }] } as never,
      { isDockerAvailable: () => available, stopManagedService: stop, orchestrateProfiles: jest.fn() } as never,
      { shutdown } as never,
    ),
  };
}

async function admitted<T>(body: unknown, metatype: new () => T): Promise<T> {
  return new ValidationPipe(GLOBAL_VALIDATION_OPTIONS).transform(body, { type: 'body', metatype }) as Promise<T>;
}

async function save(body: unknown) {
  return build().controller.saveConfig(await admitted(body, SaveConfigDto));
}

it.each([true, false])('preserves the SQLite file path with an explicit type %s', explicit => {
  seed({ DATABASE_NAME: './data/customer.sqlite' });
  const result = build().controller.saveConfig({
    database: explicit ? { type: 'sqlite' } : {},
    engine: { headless: false },
  });
  expect(result.saved).toBe(true);
  expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_NAME).toBe('./data/customer.sqlite');
});

describe('a SQLite file path in DATABASE_NAME', () => {
  const stored = { DATABASE_NAME: './data/customer.sqlite' };
  const postgres = { database: { type: 'postgres' as const, host: 'db.example.invalid', username: 'app' } };
  const passwordless = { ...postgres, database: { ...postgres.database, password: 'DummyPassword123456' } };

  it.each([
    ['sqlite', ''],
    ['postgres', 'appdb'],
  ])('is reported to the form as a name only under %s', (type, name) => {
    seed({ ...stored, DATABASE_TYPE: type, ...(type === 'postgres' ? { ...database, DATABASE_NAME: 'appdb' } : {}) });
    expect(build().controller.getConfig().database.database).toBe(name);
  });

  it('does not become the PostgreSQL database name on a direct switch', async () => {
    seed(stored);
    expect((await save(passwordless)).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('DATABASE_NAME');
  });

  it('does not become the PostgreSQL database name after a SQLite save', async () => {
    seed(stored);
    expect((await save({ database: { type: 'sqlite' } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_NAME).toBe('./data/customer.sqlite');
    expect((await save(passwordless)).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('DATABASE_NAME');
  });
});

it('drops the PostgreSQL database name when leaving PostgreSQL for SQLite', () => {
  seed({ DATABASE_TYPE: 'postgres', DATABASE_HOST: 'db.example.invalid', DATABASE_NAME: 'openwa' });
  const result = build().controller.saveConfig({ database: { type: 'sqlite' } });
  expect(result.saved).toBe(true);
  expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('DATABASE_NAME');
});

it('preserves the old overlay after a bounded partial write failure and lets a retry succeed', async () => {
  seed({ ...database, PUPPETEER_HEADLESS: 'true' });
  const before = actualFs.readFileSync(file);
  jest.mocked(fs.writeFileSync).mockImplementationOnce((target, data, options) => {
    actualFs.writeFileSync(
      target,
      (typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      ).subarray(0, 64),
      options,
    );
    throw Object.assign(new Error('bounded write failure'), { code: 'ENOSPC' });
  });
  expect((await save({ engine: { headless: false } })).saved).toBe(false);
  expect(actualFs.readFileSync(file)).toEqual(before);
  expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
  expect((await save({ engine: { headless: false } })).saved).toBe(true);
  expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
});

it('preserves the old overlay and removes staging after a replacement failure', async () => {
  const before = actualFs.readFileSync(file);
  jest.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error('replacement denied');
  });
  expect((await save({ engine: { headless: false } })).saved).toBe(false);
  expect(actualFs.readFileSync(file)).toEqual(before);
  expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
});

it.each(['EBUSY', 'EXDEV', 'EACCES', 'EPERM', 'EROFS'])(
  'writes in place when the replacement fails with %s',
  async code => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    jest.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('the file cannot be replaced'), { code });
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
  },
);

it.each(['EACCES', 'EPERM', 'EROFS'])('writes in place when the staged file cannot be created (%s)', async code => {
  seed({ ...database, PUPPETEER_HEADLESS: 'true' });
  jest.mocked(fs.writeFileSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('the directory cannot be written'), { code });
  });
  expect((await save({ engine: { headless: false } })).saved).toBe(true);
  expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
  expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
});

it('fails the save when the in-place write fails too, leaving the old overlay', async () => {
  seed({ ...database, PUPPETEER_HEADLESS: 'true' });
  const before = actualFs.readFileSync(file);
  jest
    .mocked(fs.writeFileSync)
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('the directory cannot be written'), { code: 'EACCES' });
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('the file cannot be written'), { code: 'EIO' });
    });
  expect((await save({ engine: { headless: false } })).saved).toBe(false);
  expect(actualFs.readFileSync(file)).toEqual(before);
});

it('never writes in place after the staged copy ran out of space', async () => {
  seed({ ...database, PUPPETEER_HEADLESS: 'true' });
  const before = actualFs.readFileSync(file);
  const writes = jest.mocked(fs.writeFileSync);
  writes.mockClear();
  writes.mockImplementationOnce(() => {
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  });
  expect((await save({ engine: { headless: false } })).saved).toBe(false);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(actualFs.readFileSync(file)).toEqual(before);
});

// A directory the app user cannot write that holds an overlay file it can: a real kernel refusal, not a mocked one.
(process.getuid?.() === 0 ? it.skip : it)(
  'saves a writable overlay file inside a directory that cannot be written',
  async () => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    actualFs.chmodSync(path.dirname(file), 0o555);
    try {
      expect((await save({ engine: { headless: false } })).saved).toBe(true);
      expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
    } finally {
      actualFs.chmodSync(path.dirname(file), 0o755);
    }
  },
);

describe('an overlay that is a symbolic link', () => {
  const managed = () => path.join(directory, 'managed', 'overlay.env');

  it('is written through to its target and stays a link', async () => {
    actualFs.mkdirSync(path.dirname(managed()));
    actualFs.renameSync(file, managed());
    actualFs.symlinkSync(managed(), file);
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect(actualFs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(managed())).PUPPETEER_HEADLESS).toBe('false');
    expect(actualFs.readdirSync(path.dirname(file)).sort()).toEqual(['.env.generated']);
    expect(actualFs.readdirSync(path.dirname(managed()))).toEqual(['overlay.env']);
  });

  it('is created at its target when the link points nowhere', async () => {
    actualFs.unlinkSync(file);
    actualFs.symlinkSync(path.join(directory, 'data', 'created.env'), file);
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect(actualFs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(path.join(directory, 'data', 'created.env'))).PUPPETEER_HEADLESS).toBe(
      'false',
    );
  });
});

it('creates and replaces the overlay owner-only', async () => {
  actualFs.unlinkSync(file);
  expect((await save({ engine: { headless: false } })).saved).toBe(true);
  expect((await save({ engine: { headless: true } })).saved).toBe(true);
  if (process.platform !== 'win32') expect(actualFs.statSync(file).mode & 0o777).toBe(0o600);
  expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('true');
});

const invalidBootCases: Array<{
  name: string;
  stored: Record<string, string>;
  pins: Record<string, string>;
  body: unknown;
}> = [
  {
    name: 'missing PostgreSQL host and user',
    stored: {},
    pins: {},
    body: { database: { type: 'postgres', password: 'DummyPassword123456' } },
  },
  {
    name: 'a PostgreSQL bare name under a SQLite type pin',
    stored: {},
    pins: { DATABASE_TYPE: 'sqlite' },
    body: { database: { type: 'postgres', builtIn: true } },
  },
  { name: 'an exponent-form pool size', stored: database, pins: {}, body: { database: { poolSize: 1e21 } } },
  {
    name: 'a true TLS pin for bundled PostgreSQL',
    stored: { ...database, POSTGRES_BUILTIN: 'true', DATABASE_HOST: 'postgres' },
    pins: { DATABASE_SSL: 'true' },
    body: { database: { type: 'postgres', builtIn: true } },
  },
];
for (const example of invalidBootCases) {
  it(`refuses ${example.name} before persisting`, async () => {
    seed(example.stored);
    Object.assign(process.env, example.pins);
    recordPinnedEnvKeys(example.pins);
    const before = actualFs.readFileSync(file);
    const input = await admitted(example.body, SaveConfigDto);
    expect(() => build().controller.saveConfig(input)).toThrow(BadRequestException);
    expect(actualFs.readFileSync(file)).toEqual(before);
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
  });
}

describe('the save refuses what the boot would refuse beside the built-in Redis and an S3 store', () => {
  const builtInRedis = { redis: { enabled: true, builtIn: true } };
  const pin = (key: string, value: string, origin: string) => {
    process.env[key] = value;
    recordOsEnvKeys(origin === 'host' ? { [key]: value } : {});
    recordPinnedEnvKeys({ [key]: value });
  };
  const refused = async (body: unknown, message: RegExp) => {
    const before = actualFs.readFileSync(file);
    const input = await admitted(body, SaveConfigDto);
    expect(() => build().controller.saveConfig(input)).toThrow(message);
    expect(actualFs.readFileSync(file)).toEqual(before);
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
  };

  it.each(['host', 'project file'])('refuses a true %s REDIS_TLS pin', async origin => {
    seed({ REDIS_ENABLED: 'true' });
    pin('REDIS_TLS', 'true', origin);
    await refused(builtInRedis, /REDIS_TLS=true cannot/);
  });

  it.each(['REDIS_ENABLED', 'QUEUE_ENABLED', 'CACHE_ENABLED'])(
    'refuses a named REDIS_USERNAME pin for the %s consumer',
    async consumer => {
      seed({ REDIS_ENABLED: consumer === 'REDIS_ENABLED' ? 'true' : 'false', [consumer]: 'true' });
      pin('REDIS_USERNAME', 'worker', 'host');
      await refused(
        { redis: { enabled: consumer === 'REDIS_ENABLED', builtIn: true } },
        /REDIS_USERNAME must be unset/,
      );
    },
  );

  it('refuses an S3 endpoint that is not an http(s) URL', async () => {
    await refused(
      {
        storage: {
          type: 's3',
          s3Endpoint: 'minio:9000',
          s3AccessKey: 'AKIAREALKEY123456',
          s3SecretKey: 'RealSecretKey1234567890',
          s3Bucket: 'b',
        },
      },
      /S3_ENDPOINT must be an absolute/,
    );
  });

  it('still saves a switch back to local storage over a stored endpoint without a scheme', async () => {
    seed({ STORAGE_TYPE: 's3', S3_ENDPOINT: 'minio:9000' });
    expect((await save({ storage: { type: 'local' } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('S3_ENDPOINT');
  });
});

it('accepts a valid partial PostgreSQL change and preserves an absent pool value', async () => {
  seed({ ...database, DATABASE_POOL_SIZE: '17' });
  expect((await save({ database: { poolSize: null } })).saved).toBe(true);
  expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_POOL_SIZE).toBe('17');
  expect((await save({ database: { poolSize: 18 } })).saved).toBe(true);
  expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_POOL_SIZE).toBe('18');
});

const disabledServices: Array<{
  profile: string;
  stored: Record<string, string>;
  pins: Record<string, string>;
  body: SaveConfigDto;
}> = [
  {
    profile: 'postgres',
    stored: { ...database, POSTGRES_BUILTIN: 'true', DATABASE_HOST: 'postgres' },
    pins: { DATABASE_HOST: 'postgres' },
    body: { database: { type: 'sqlite' } },
  },
  {
    profile: 'minio',
    stored: {
      STORAGE_TYPE: 's3',
      MINIO_BUILTIN: 'true',
      S3_ENDPOINT: 'http://minio:9000',
      S3_ACCESS_KEY_ID: 'minioadmin',
      S3_SECRET_ACCESS_KEY: 'minioadmin',
    },
    pins: { S3_ENDPOINT: 'http://minio:9000' },
    body: { storage: { type: 'local' } },
  },
  {
    profile: 'redis',
    stored: {
      REDIS_ENABLED: 'true',
      REDIS_BUILTIN: 'true',
      REDIS_HOST: 'redis',
      QUEUE_ENABLED: 'false',
      CACHE_ENABLED: 'false',
    },
    pins: { REDIS_HOST: 'redis' },
    body: { redis: { enabled: false, builtIn: true } },
  },
];
for (const example of disabledServices) {
  it(`stops unused ${example.profile} despite its bundled host pin`, async () => {
    seed(example.stored);
    Object.assign(process.env, example.pins);
    recordPinnedEnvKeys(example.pins);
    expect((await save(example.body)).saved).toBe(true);
    const { controller, stop } = build();
    const input = await admitted({ profilesToRemove: [example.profile] }, RestartDto);
    expect((await controller.requestRestart(input)).profilesToRemove).toEqual([example.profile]);
    expect(stop).toHaveBeenCalledWith(example.profile);
  });
}

it.each(['QUEUE_ENABLED', 'CACHE_ENABLED'])('keeps Redis for its active %s consumer', async consumer => {
  seed({ REDIS_HOST: 'redis', REDIS_ENABLED: 'false', [consumer]: 'true' });
  process.env.REDIS_HOST = 'redis';
  recordPinnedEnvKeys({ REDIS_HOST: 'redis' });
  const { controller, stop } = build();
  expect((await controller.requestRestart({ profilesToRemove: ['redis'] })).profilesToRemove).toEqual([]);
  expect(stop).not.toHaveBeenCalled();
});

it('writes the same unused-profile stop to the signal-file fallback', async () => {
  process.env.DATABASE_HOST = 'OpenWA-POSTGRES.';
  recordPinnedEnvKeys({ DATABASE_HOST: process.env.DATABASE_HOST });
  const { controller, stop } = build(false);
  expect((await controller.requestRestart({ profilesToRemove: ['postgres'] })).profilesToRemove).toEqual(['postgres']);
  expect(
    (
      JSON.parse(actualFs.readFileSync(path.join(directory, 'data', '.orchestration-request.json'), 'utf8')) as {
        profilesToRemove: string[];
      }
    ).profilesToRemove,
  ).toEqual(['postgres']);
  expect(stop).not.toHaveBeenCalled();
});
