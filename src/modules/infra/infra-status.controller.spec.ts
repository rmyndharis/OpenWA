// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
  };
});

import { InfraStatusController } from './infra-status.controller';
import { InfraConfigController } from './infra-config.controller';
import type { ConfigSectionContext } from './config-sections';
import type { SaveConfigDto } from './dto/save-config.dto';
import { BLANK_SHADOWED_ENV_KEYS, recordPinnedEnvKeys } from '../../config/env-precedence';
import { producerConnectWaitMs } from '../queue/redis-connection';
import * as fs from 'fs';
import {
  FALLBACK_BUILT_IN,
  FILE_STATES,
  HOST_SPELLINGS,
  PIN_STATES,
  SERVICES,
  SERVICE_NAMES,
  fileHost,
  fileLines,
  pinnedHost,
  type FileState,
  type PinState,
  type ServiceName,
} from '../../../test/fixtures/builtin-mode-cases';

describe('InfraStatusController.getStatus DB health (active SELECT 1 probe, not just isInitialized)', () => {
  const build = (query: jest.Mock) => {
    // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
    const config = { get: (k: string, def?: unknown) => (k === 'engine.type' ? 'baileys' : def) };
    const ds = { isInitialized: true, query };
    const cache = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() } as never,
      cache as never,
      { refreshS3Availability: jest.fn() } as never,
      undefined as never,
    );
  };

  it('reports connected:true when SELECT 1 succeeds', async () => {
    const status = await build(jest.fn().mockResolvedValue([{ '1': 1 }])).getStatus();
    expect(status.database.connected).toBe(true);
  });

  it('reports connected:false when the DB is initialized but SELECT 1 fails (backend died post-init)', async () => {
    const status = await build(jest.fn().mockRejectedValue(new Error('ECONNRESET'))).getStatus();
    expect(status.database.connected).toBe(false);
  });
});

describe('InfraStatusController.getStatus queue job counts', () => {
  function buildStatusController(opts: {
    queueEnabled: boolean;
    queue?: { getJobCounts: jest.Mock; waitUntilReady?: jest.Mock };
  }) {
    const configService = {
      // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
      get: (key: string, def?: unknown) =>
        key === 'queue.enabled' ? opts.queueEnabled : key === 'engine.type' ? 'baileys' : def,
    };
    const dataSource = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) } as unknown;
    const engineFactory = { create: jest.fn() };
    const dockerService = { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() };
    const cacheService = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
    const storageService = { refreshS3Availability: jest.fn() };
    return new InfraStatusController(
      configService as never,
      dataSource as never,
      dataSource as never,
      engineFactory as never,
      dockerService as never,
      cacheService as never,
      storageService as never,
      (opts.queue && { waitUntilReady: jest.fn().mockResolvedValue(undefined), ...opts.queue }) as never,
    );
  }

  it('reports live webhook job counts when the queue is enabled (pending = wait+active+delayed)', async () => {
    const getJobCounts = jest.fn().mockResolvedValue({ wait: 2, active: 1, delayed: 3, completed: 10, failed: 1 });
    const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts } });

    const status = await controller.getStatus();

    expect(getJobCounts).toHaveBeenCalledWith('wait', 'active', 'delayed', 'completed', 'failed');
    expect(status.queue).toEqual({ enabled: true, webhooks: { pending: 6, completed: 10, failed: 1 } });
  });

  // Until the first connect BullMQ holds a queue call for as long as Redis stays unreachable.
  it('reports zeros once the connect timeout passes when Redis has never connected', async () => {
    const getJobCounts = jest.fn();
    const waitUntilReady = jest.fn(() => new Promise<never>(() => {}));
    const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts, waitUntilReady } });
    let status: Awaited<ReturnType<InfraStatusController['getStatus']>> | undefined;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      void controller.getStatus().then(s => (status = s));
      await jest.advanceTimersByTimeAsync(producerConnectWaitMs());
    } finally {
      jest.useRealTimers();
    }

    expect(getJobCounts).not.toHaveBeenCalled();
    expect(status?.queue).toEqual({ enabled: true, webhooks: { pending: 0, completed: 0, failed: 0 } });
  });

  it('reports zeros (and does not touch the queue) when the queue is disabled', async () => {
    const getJobCounts = jest.fn();
    const controller = buildStatusController({ queueEnabled: false, queue: { getJobCounts } });

    const status = await controller.getStatus();

    expect(getJobCounts).not.toHaveBeenCalled();
    expect(status.queue).toEqual({ enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } });
  });
});

describe('InfraStatusController.getStatus engine (reads the real engine.puppeteer.* keys)', () => {
  // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  it('reports the saved headless/browserArgs instead of stale defaults from non-existent flat keys', async () => {
    const map: Record<string, unknown> = {
      'engine.type': 'whatsapp-web.js',
      'engine.puppeteer.headless': false,
      'engine.puppeteer.args': ['--foo', '--bar'],
      'engine.sessionDataPath': './sess',
    };
    const config = { get: (key: string, def?: unknown) => (key in map ? map[key] : def) };
    const cache = { isAvailable: () => Promise.resolve(false) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const controller = new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never, // engineFactory
      { isDockerAvailable: () => false } as never, // dockerService — no Docker in unit tests
      cache as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
    );

    const status = await controller.getStatus();
    expect(status.engine.headless).toBe(false);
    expect(status.engine.browserArgs).toBe('--foo --bar');
    expect(status.engine.sessionDataPath).toBe('./sess');
  });

  it('reports the default Chromium flags when no args are configured', async () => {
    const config = { get: (key: string, def?: unknown) => (key === 'engine.type' ? 'whatsapp-web.js' : def) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const controller = new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never,
      { isDockerAvailable: () => false } as never,
      { isAvailable: () => Promise.resolve(false) } as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never,
    );

    const status = await controller.getStatus();
    expect(status.engine.browserArgs).toBe(
      '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
    );
  });
});

describe('InfraStatusController.getStatus storage (reads the real storage.localPath key)', () => {
  // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  const buildController = (map: Record<string, unknown>) => {
    const config = { get: (key: string, def?: unknown) => (key in map ? map[key] : def) };
    const cache = { isAvailable: () => Promise.resolve(false) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never, // engineFactory
      { isDockerAvailable: () => false } as never, // dockerService — no Docker in unit tests
      cache as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
    );
  };

  it('reports the configured storage.localPath, not the ./uploads fallback', async () => {
    // The bug: status read the non-existent `storage.path` key, so it always reported the
    // `./uploads` fallback instead of the real path StorageService uses (`storage.localPath`).
    const status = await buildController({
      'storage.type': 'local',
      'storage.localPath': '/srv/openwa/media',
    }).getStatus();
    expect(status.storage.path).toBe('/srv/openwa/media');
  });

  it('falls back to ./data/media (matching StorageService) when storage.localPath is unset', async () => {
    const status = await buildController({ 'storage.type': 'local' }).getStatus();
    expect(status.storage.path).toBe('./data/media');
  });

  it('reports the bucket in S3 mode so the active backend is visible', async () => {
    const status = await buildController({ 'storage.type': 's3', 'storage.s3.bucket': 'my-openwa-bucket' }).getStatus();
    expect(status.storage.type).toBe('s3');
    expect(status.storage.bucket).toBe('my-openwa-bucket');
  });

  it('omits bucket in local mode (no fabricated field)', async () => {
    const status = await buildController({ 'storage.type': 'local' }).getStatus();
    expect(status.storage.bucket).toBeUndefined();
  });

  // The endpoint this process dials, which tells a bundled MinIO that is stopped apart from an external store.
  it('reports the endpoint in S3 mode, and only there', async () => {
    const endpoint = 'http://minio:9000';
    const s3 = await buildController({ 'storage.type': 's3', 'storage.s3.endpoint': endpoint }).getStatus();
    const local = await buildController({ 'storage.type': 'local', 'storage.s3.endpoint': endpoint }).getStatus();
    const aws = await buildController({ 'storage.type': 's3' }).getStatus();

    expect([s3.storage.endpoint, local.storage.endpoint, aws.storage.endpoint]).toEqual([
      endpoint,
      undefined,
      undefined,
    ]);
  });
});

// #1082: the Infrastructure page used to INFER an environment pin from "running != saved", which also
// describes a save that has not been restarted yet. getStatus now reports the real thing.
describe('InfraStatusController.getStatus envPinned', () => {
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  const buildController = () => {
    const config = { get: (_key: string, def?: unknown) => def };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never,
      { isDockerAvailable: () => false } as never,
      { isAvailable: () => Promise.resolve(false) } as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never,
    );
  };

  it('reports only the editable selection keys a shadowing layer supplies', async () => {
    // Snapshot as load-env does: ENGINE_TYPE comes from the host/.env, REDIS_ENABLED from the file.
    recordPinnedEnvKeys({ ENGINE_TYPE: 'whatsapp-web.js', PATH: '/usr/bin' });

    const status = await buildController().getStatus();

    expect(status.envPinned).toEqual(['ENGINE_TYPE']);
    // PATH is shadowing too but has no control on the page — naming it would be noise.
    expect(status.envPinned).not.toContain('PATH');
  });

  it('reports the storage path and engine launch options the Quick Start stack pins', async () => {
    // docker-compose.dev.yml forwards these four with non-empty defaults, so a dashboard edit reverts.
    recordPinnedEnvKeys({
      SESSION_DATA_PATH: '/app/data/sessions',
      PUPPETEER_HEADLESS: 'true',
      PUPPETEER_ARGS: '--no-sandbox',
      STORAGE_LOCAL_PATH: '/app/data/media',
      PATH: '/usr/bin',
    });

    const status = await buildController().getStatus();

    expect(status.envPinned).toEqual([
      'STORAGE_LOCAL_PATH',
      'PUPPETEER_HEADLESS',
      'SESSION_DATA_PATH',
      'PUPPETEER_ARGS',
    ]);
  });

  // A pinned host decides the Use Built-in mode of its service whatever the page saves.
  it('reports the three datastore hosts when a shadowing layer supplies them', async () => {
    recordPinnedEnvKeys({
      DATABASE_HOST: 'db.example',
      REDIS_HOST: 'cache.example',
      S3_ENDPOINT: 'https://s3.example',
    });

    expect((await buildController().getStatus()).envPinned).toEqual(['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT']);
  });

  it('reports a Redis TLS pin beside the built-in selection', async () => {
    recordPinnedEnvKeys({ REDIS_TLS: 'true' });

    expect((await buildController().getStatus()).envPinned).toEqual(['REDIS_TLS']);
  });

  it('reports an empty list when nothing above data/.env.generated supplies a selection key', async () => {
    recordPinnedEnvKeys({});

    expect((await buildController().getStatus()).envPinned).toEqual([]);
  });

  // A pinned key the page writes outranks the saved value at every boot, so the page must hear of each one: an
  // unreported pin under an edited field reads as a change the next boot makes (a bucket or database switch).
  it('reports every key a save from the page writes, and no other', async () => {
    recordPinnedEnvKeys({});
    const engines = { getAvailableEngines: () => [{ id: 'whatsapp-web.js' }, { id: 'baileys' }] };
    const saver = new InfraConfigController(engines as never, {} as never, {} as never) as unknown as {
      applyConfigSections: (config: SaveConfigDto, existing: Record<string, string>, ctx: ConfigSectionContext) => void;
    };
    const payloads = [
      {
        database: {
          type: 'postgres',
          builtIn: false,
          host: 'db.example',
          port: '5433',
          username: 'app',
          password: 'secret',
          database: 'appdb',
          schema: 'tenant',
          poolSize: 20,
          sslEnabled: true,
          sslRejectUnauthorized: false,
        },
        redis: { enabled: true, builtIn: false, host: 'cache.example', port: '6380', password: 'secret' },
        queue: { enabled: true },
        storage: {
          type: 's3',
          builtIn: false,
          s3Bucket: 'media',
          s3Region: 'eu-west-1',
          s3AccessKey: 'key',
          s3SecretKey: 'secret',
          s3Endpoint: 'https://s3.example',
        },
        engine: { type: 'baileys', headless: false, sessionDataPath: './data/s', browserArgs: '--no-sandbox' },
      },
      {
        database: { type: 'postgres', builtIn: true },
        redis: { enabled: true, builtIn: true },
        storage: { type: 's3', builtIn: true },
      },
      { database: { type: 'sqlite' }, redis: { enabled: false }, storage: { type: 'local', localPath: './data/m' } },
    ];
    const written = new Set<string>();
    for (const payload of payloads) {
      const ctx: ConfigSectionContext = { updates: {}, staleKeys: new Set(), profiles: [] };
      saver.applyConfigSections(payload as SaveConfigDto, {}, ctx);
      [...Object.keys(ctx.updates), ...ctx.staleKeys].forEach(key => written.add(key));
    }
    // Removing legacy aliases changes the canonical credential fields, which are the ones the form writes.
    written.delete('S3_ACCESS_KEY');
    written.delete('S3_SECRET_KEY');
    // Every compose forward is pinned beside them, so a reported key no save writes would show up too.
    recordPinnedEnvKeys(Object.fromEntries([...BLANK_SHADOWED_ENV_KEYS, ...written].map(key => [key, 'x'])));

    const reported = (await buildController().getStatus()).envPinned;

    expect([...reported].sort()).toEqual([...written].sort());
  });
});

// With Docker unreachable the status falls back to the saved flag, the environment's first. A host name proves
// nothing without a container to see (an external server may be called postgres), so a pinned bundled host must not
// read as built-in there: it would replace the stored external credentials with the bundled defaults on a save. Nor
// does a flag beside a host that does not reach the bundled container: the process dials that host.
describe('InfraStatusController.getStatus built-in fallback reads the flag only when Docker is unreachable', () => {
  // The hosts the process runs with, as configuration.ts reads them at boot.
  const build = (hosts: Partial<Record<ServiceName, string>> = {}) => {
    const key: Record<string, string | undefined> = {
      'dataDatabase.host': hosts.database,
      'redis.host': hosts.redis,
      'storage.s3.endpoint': hosts.storage,
    };
    const config = { get: (k: string, def?: unknown) => (k === 'engine.type' ? 'baileys' : (key[k] ?? def)) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() } as never,
      { isAvailable: jest.fn().mockResolvedValue(false) } as never,
      { refreshS3Availability: jest.fn() } as never,
      undefined as never,
    );
  };
  const otherState = (state: FileState): FileState => (state === 'stored-true' ? 'stored-false' : 'stored-true');
  const otherPin = (pin: PinState): PinState => (pin === 'external' ? 'bundled' : 'external');
  let pinnedKeys: string[] = [];

  afterEach(() => {
    for (const key of pinnedKeys) delete process.env[key];
    pinnedKeys = [];
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  for (const service of SERVICE_NAMES) {
    for (const state of FILE_STATES) {
      for (const pin of PIN_STATES) {
        it(`${service}: a ${state} file with ${pin === 'none' ? 'no host pin' : `the host pinned ${pin}`}`, async () => {
          const lines: string[] = [];
          const pins: Record<string, string> = {};
          const hosts: Partial<Record<ServiceName, string>> = {};
          for (const name of SERVICE_NAMES) {
            const own = name === service;
            lines.push(...fileLines(name, own ? state : otherState(state)));
            const host = pinnedHost(name, own ? pin : otherPin(pin));
            if (host !== undefined) pins[SERVICES[name].host] = host;
            hosts[name] = host ?? fileHost(name, own ? state : otherState(state));
          }
          recordPinnedEnvKeys(pins);
          for (const [key, value] of Object.entries(pins)) process.env[key] = value;
          pinnedKeys = Object.keys(pins);
          (fs.existsSync as jest.Mock).mockReturnValue(true);
          (fs.readFileSync as jest.Mock).mockReturnValue(`${lines.join('\n')}\n`);

          const status = await build(hosts).getStatus();

          expect(status[service].builtIn).toBe(FALLBACK_BUILT_IN[state][pin]);
        });
      }
    }
  }

  it('a flag pinned by the environment wins over the file, and a pinned host still proves nothing', async () => {
    const pins = {
      POSTGRES_BUILTIN: 'true',
      REDIS_BUILTIN: 'false',
      DATABASE_HOST: 'postgres',
      REDIS_HOST: 'redis',
      S3_ENDPOINT: 'http://minio:9000',
    };
    recordPinnedEnvKeys(pins);
    Object.assign(process.env, pins);
    pinnedKeys = Object.keys(pins);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('POSTGRES_BUILTIN=false\nREDIS_BUILTIN=true\nMINIO_BUILTIN=false\n');

    const status = await build({ database: 'postgres', redis: 'redis', storage: 'http://minio:9000' }).getStatus();

    expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([true, false, false]);
  });

  // The page switched the three services to external servers beside flags the environment pins true, and the restart
  // applied it: the flags still start the containers at boot, but the process dials the external hosts.
  it('a flag pinned true beside a host that does not reach the bundled container reads as no built-in', async () => {
    const pins = { POSTGRES_BUILTIN: 'true', REDIS_BUILTIN: 'true', MINIO_BUILTIN: 'true' };
    recordPinnedEnvKeys(pins);
    Object.assign(process.env, pins);
    pinnedKeys = Object.keys(pins);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.ext.example\nREDIS_ENABLED=true\n' +
        'REDIS_BUILTIN=false\nREDIS_HOST=cache.ext.example\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
        'S3_ENDPOINT=https://s3.ext.example\n',
    );

    const status = await build({
      database: 'db.ext.example',
      redis: 'cache.ext.example',
      storage: 'https://s3.ext.example',
    }).getStatus();

    expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([false, false, false]);
  });
});

// `running` reports a bundled container OpenWA created that is up, apart from whether the service uses it: the page
// stops one whose host the environment pins elsewhere. One Docker Compose created belongs to the deployment, and one
// beside a configuration that never chose the built-in service belongs to no setup of this instance (a second
// instance on the same daemon sees the first one's containers under the same names).
describe('InfraStatusController.getStatus running bundled containers', () => {
  const FLAGS_TRUE = 'POSTGRES_BUILTIN=true\nREDIS_BUILTIN=true\nMINIO_BUILTIN=true\n';
  const withFile = (contents: string | null) => {
    (fs.existsSync as jest.Mock).mockReturnValue(contents !== null);
    (fs.readFileSync as jest.Mock).mockReturnValue(contents ?? '');
  };
  beforeEach(() => withFile(FLAGS_TRUE));
  afterEach(() => {
    withFile(null);
    recordPinnedEnvKeys({});
    for (const flag of ['POSTGRES_BUILTIN', 'REDIS_BUILTIN', 'MINIO_BUILTIN']) delete process.env[flag];
  });

  const build = (containers: Record<'database' | 'cache' | 'storage', false | 'compose' | 'openwa'> | null) => {
    const values: Record<string, unknown> = {
      'engine.type': 'baileys',
      'dataDatabase.type': 'postgres',
      'dataDatabase.host': 'db.ext.example',
      'redis.host': 'redis',
      'storage.type': 's3',
      'storage.s3.endpoint': 'https://s3.ext.example',
    };
    const config = { get: (k: string, def?: unknown) => values[k] ?? def };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      {
        isDockerAvailable: () => containers !== null,
        getRunningBuiltinServices: jest.fn().mockResolvedValue(containers),
      } as never,
      { isAvailable: jest.fn().mockResolvedValue(false) } as never,
      { refreshS3Availability: jest.fn().mockResolvedValue(true) } as never,
      undefined as never,
    );
  };
  const savedRedisHost = process.env.REDIS_HOST;

  beforeEach(() => delete process.env.REDIS_HOST);
  afterAll(() => {
    if (savedRedisHost !== undefined) process.env.REDIS_HOST = savedRedisHost;
  });

  it('reports a container OpenWA created as running whether or not the service uses it', async () => {
    const status = await build({ database: 'openwa', cache: 'compose', storage: 'openwa' }).getStatus();

    expect([status.database.builtIn, status.database.running]).toEqual([false, true]);
    expect([status.redis.builtIn, status.redis.running]).toEqual([true, false]);
    expect([status.storage.builtIn, status.storage.running]).toEqual([false, true]);
  });

  it('reports none of the three running when Docker Compose created them', async () => {
    const status = await build({ database: 'compose', cache: 'compose', storage: 'compose' }).getStatus();

    expect([status.database.running, status.redis.running, status.storage.running]).toEqual([false, false, false]);
    expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([false, true, false]);
  });

  it.each([
    ['a first-boot file', 'POSTGRES_BUILTIN=false\nREDIS_BUILTIN=false\nMINIO_BUILTIN=false\n'],
    ['no saved file', null],
  ])('reports none of the three running beside %s that never chose them', async (_label, contents) => {
    withFile(contents);
    const status = await build({ database: 'openwa', cache: 'openwa', storage: 'openwa' }).getStatus();

    expect([status.database.running, status.redis.running, status.storage.running]).toEqual([false, false, false]);
  });

  it('reads the flag the environment pins over the saved one', async () => {
    withFile('POSTGRES_BUILTIN=false\nREDIS_BUILTIN=true\nMINIO_BUILTIN=false\n');
    process.env.POSTGRES_BUILTIN = 'true';
    process.env.REDIS_BUILTIN = 'false';
    recordPinnedEnvKeys({ POSTGRES_BUILTIN: 'true', REDIS_BUILTIN: 'false' });
    const status = await build({ database: 'openwa', cache: 'openwa', storage: 'openwa' }).getStatus();

    expect([status.database.running, status.redis.running, status.storage.running]).toEqual([true, false, false]);
  });

  it('reports nothing running when no bundled container is up', async () => {
    const status = await build({ database: false, cache: false, storage: false }).getStatus();

    expect([status.database.running, status.redis.running, status.storage.running]).toEqual([false, false, false]);
  });

  // A running bundled container backs the service when its host reaches the container in any spelling.
  describe.each([
    ['database', 'dataDatabase.host', 'database'],
    ['redis', 'redis.host', 'cache'],
    ['storage', 'storage.s3.endpoint', 'storage'],
  ] as const)('%s built-in under another spelling of its host', (service, configKey, container) => {
    const statusFor = async (host: string) => {
      const values: Record<string, unknown> = {
        'dataDatabase.type': 'postgres',
        'storage.type': 's3',
        'storage.s3.endpoint': 'https://s3.ext.example',
        [configKey]: host,
      };
      const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
      const running = { database: false, cache: false, storage: false, [container]: 'compose' };
      return new InfraStatusController(
        { get: (k: string, def?: unknown) => values[k] ?? def } as never,
        ds as never,
        ds as never,
        { create: jest.fn() } as never,
        { isDockerAvailable: () => true, getRunningBuiltinServices: jest.fn().mockResolvedValue(running) } as never,
        { isAvailable: jest.fn().mockResolvedValue(false) } as never,
        { refreshS3Availability: jest.fn().mockResolvedValue(true) } as never,
        undefined as never,
      ).getStatus();
    };
    it.each([
      ...HOST_SPELLINGS[service].reach.map(host => [host, true] as const),
      ...HOST_SPELLINGS[service].elsewhere.filter(Boolean).map(host => [host, false] as const),
    ])('%j reads built-in: %s', async (host, builtIn) => {
      expect((await statusFor(host))[service].builtIn).toBe(builtIn);
    });
  });

  // Nothing can be seen or stopped then, so a reader cannot take the absence of a container for a fact.
  it('leaves running out when Docker is unreachable', async () => {
    const status = await build(null).getStatus();

    expect(['running' in status.database, 'running' in status.redis, 'running' in status.storage]).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('InfraStatusController unavailable Docker inventory', () => {
  let previousHost: string | undefined;
  beforeEach(() => {
    previousHost = process.env.REDIS_HOST;
    process.env.REDIS_HOST = 'redis';
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('REDIS_BUILTIN=true\n');
  });
  afterEach(() => {
    if (previousHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = previousHost;
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  it('distinguishes an unavailable inventory from an observed empty list and later recovery', async () => {
    const running = { database: false, cache: 'openwa', storage: false };
    const inventory = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        database: false,
        cache: false,
        storage: false,
      })
      .mockResolvedValueOnce(running);
    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'redis.host' ? 'redis' : key === 'engine.type' ? 'baileys' : fallback,
    };
    const database = { isInitialized: true, query: jest.fn().mockResolvedValue([]) };
    const controller = new InfraStatusController(
      config as never,
      database as never,
      database as never,
      {} as never,
      { isDockerAvailable: () => true, getRunningBuiltinServices: inventory } as never,
      { isAvailable: jest.fn().mockResolvedValue(false) } as never,
      {} as never,
    );
    const unavailable = await controller.getStatus();
    const empty = await controller.getStatus();
    const recovered = await controller.getStatus();

    expect(unavailable.redis.builtIn).toBe(true);
    expect(unavailable.redis).not.toHaveProperty('running');
    expect(empty.redis.builtIn).toBe(false);
    expect(empty.redis.running).toBe(false);
    expect(recovered.redis.builtIn).toBe(true);
    expect(recovered.redis.running).toBe(true);
  });
});
