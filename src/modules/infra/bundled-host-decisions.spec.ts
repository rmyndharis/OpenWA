import * as fs from 'fs';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
  };
});
jest.mock('../../config/storage-root', () => {
  const actual = jest.requireActual<typeof import('../../config/storage-root')>('../../config/storage-root');
  return { ...actual, resolveStorageRoot: jest.fn((options: { configured?: string }) => options.configured ?? '') };
});

import { InfraConfigController } from './infra-config.controller';
import { InfraStatusController } from './infra-status.controller';
import { hostPinnedElsewhere } from '../docker';
import {
  BLANK_SHADOWED_ENV_KEYS,
  clearBlankEnv,
  isEnvPinned,
  recordOsEnvKeys,
  recordPinnedEnvKeys,
} from '../../config/env-precedence';
import { HOST_SPELLINGS, SERVICES, SERVICE_NAMES, type ServiceName } from '../../../test/fixtures/builtin-mode-cases';

// Every decision that asks whether a host is the bundled container, for every spelling of the shared table, with the
// host pinned or in the saved file, beside each state of the stored flag. The expected answer comes from the table
// (reach or elsewhere), not from the rule under test, so a decision that reads a spelling differently fails here.
const PROFILE: Record<ServiceName, string> = { database: 'postgres', redis: 'redis', storage: 'minio' };
const CONTAINER: Record<ServiceName, 'database' | 'cache' | 'storage'> = {
  database: 'database',
  redis: 'cache',
  storage: 'storage',
};
const STATUS_HOST: Record<ServiceName, string> = {
  database: 'dataDatabase.host',
  redis: 'redis.host',
  storage: 'storage.s3.endpoint',
};
// Strong credentials pinned for every case, so the production guard never decides a save here.
const SECRETS = {
  DATABASE_PASSWORD: 'PinnedPw456!',
  S3_ACCESS_KEY_ID: 'PinnedKey123456',
  S3_SECRET_ACCESS_KEY: 'PinnedSecret1234567',
};
const STORED_SECRETS =
  'DATABASE_PASSWORD=StoredPw789!\nS3_ACCESS_KEY_ID=StoredKey12345\nS3_SECRET_ACCESS_KEY=StoredSecret1234567890\n';
// What an external database or bucket was saved with, beside the host of the case.
const STORED_VALUES =
  'DATABASE_USERNAME=app\nDATABASE_NAME=appdb\nPOSTGRES_SCHEMA=tenant\nS3_BUCKET=media\nS3_REGION=eu-west-1\n';

type Position = 'pinned' | 'file';
type Flag = 'true' | 'false' | 'absent';
interface Case {
  service: ServiceName;
  host: string;
  reach: boolean;
  position: Position;
  flag: Flag;
}

// A storage endpoint that is not an absolute http(s) URL is refused by the save, so a save never reaches the
// decisions below with one; the blank spelling is no endpoint at all.
const isSavableHost = (service: ServiceName, host: string): boolean =>
  service !== 'storage' || host.trim() === '' || /^https?:\/\//i.test(host.trim());

const cases: Case[] = SERVICE_NAMES.flatMap(service =>
  [
    ...HOST_SPELLINGS[service].reach.map(host => ({ host, reach: true })),
    ...HOST_SPELLINGS[service].elsewhere.map(host => ({ host, reach: false })),
  ]
    .filter(({ host }) => isSavableHost(service, host))
    .flatMap(({ host, reach }) =>
      (['pinned', 'file'] as const).flatMap(position =>
        (['true', 'false', 'absent'] as const).map(flag => ({ service, host, reach, position, flag })),
      ),
    ),
);

const label = (c: Case) => `${c.service} ${JSON.stringify(c.host)} ${c.position}, flag ${c.flag}`;

let pinnedKeys: string[] = [];
let fileText = '';
let environment: NodeJS.ProcessEnv;

beforeEach(() => {
  environment = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE_|POSTGRES_|REDIS_|STORAGE_|S3_|MINIO_|QUEUE_|CACHE_|ENGINE_TYPE$)/.test(key))
      delete process.env[key];
  }
});

function arrange(c: Case, stored = ''): void {
  const spec = SERVICES[c.service];
  // A pinned host must outrank the file's, so the file holds a host of the other kind.
  const fileHost = c.position === 'file' ? c.host : c.reach ? spec.externalHost : spec.bundledHost;
  // Unrelated stored database fields still belong to a complete PostgreSQL connection.
  const lines = [
    'DATABASE_TYPE=postgres',
    'DATABASE_HOST=db.external.example',
    'DATABASE_USERNAME=openwa',
    `${spec.selection}=${spec.selected}`,
    `${spec.host}=${fileHost}`,
  ];
  if (c.flag !== 'absent') lines.push(`${spec.flag}=${c.flag}`);
  fileText = `${lines.join('\n')}\n${STORED_SECRETS}${stored}`;
  const pins: Record<string, string> = { ...SECRETS, ...(c.position === 'pinned' ? { [spec.host]: c.host } : {}) };
  Object.assign(process.env, pins);
  pinnedKeys = Object.keys(pins);
  // Credentials are OS-supplied; the case's host pin is a project .env assignment, including a real blank.
  recordOsEnvKeys(SECRETS);
  recordPinnedEnvKeys(pins);
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  (fs.readFileSync as jest.Mock).mockReturnValue(fileText);
  (fs.writeFileSync as jest.Mock).mockClear();
}

afterEach(() => {
  for (const key of pinnedKeys) delete process.env[key];
  pinnedKeys = [];
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) delete process.env[key];
  }
  Object.assign(process.env, environment);
  recordOsEnvKeys(process.env);
  recordPinnedEnvKeys({});
  (fs.existsSync as jest.Mock).mockReturnValue(false);
  (fs.readFileSync as jest.Mock).mockReturnValue('');
});

const controller = (docker: Record<string, unknown> = {}) =>
  new InfraConfigController({} as never, docker as never, { shutdown: jest.fn() } as never);

function saved(payload: unknown): Record<string, string> {
  controller().saveConfig(payload as never);
  const text = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
  return jest.requireActual<typeof import('dotenv')>('dotenv').parse(text);
}

async function restart(body: { profiles?: string[]; profilesToRemove?: string[] }) {
  const stopManagedService = jest.fn().mockResolvedValue(true);
  const result = await controller({
    isDockerAvailable: () => true,
    stopManagedService,
    orchestrateProfiles: jest.fn().mockResolvedValue({}),
  }).requestRestart(body);
  return { result, stopped: stopManagedService.mock.calls.length > 0 };
}

async function status(c: Case, creator: 'compose' | 'openwa') {
  const values: Record<string, unknown> = {
    'dataDatabase.type': 'postgres',
    'storage.type': 's3',
    [STATUS_HOST[c.service]]: c.host,
  };
  const running = { database: false, cache: false, storage: false, [CONTAINER[c.service]]: creator };
  const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
  const savedRedisHost = process.env.REDIS_HOST;
  if (c.service === 'redis') process.env.REDIS_HOST = c.host;
  try {
    return await new InfraStatusController(
      { get: (k: string, def?: unknown) => values[k] ?? def } as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      { isDockerAvailable: () => true, getRunningBuiltinServices: jest.fn().mockResolvedValue(running) } as never,
      { isAvailable: jest.fn().mockResolvedValue(false) } as never,
      { refreshS3Availability: jest.fn().mockResolvedValue(true) } as never,
      undefined as never,
    ).getStatus();
  } finally {
    if (savedRedisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = savedRedisHost;
  }
}

describe.each(cases.map(c => [label(c), c] as const))('%s', (_label, c) => {
  const profile = PROFILE[c.service];
  const spec = SERVICES[c.service];
  // The host the next boot dials reaches the container exactly when this case's host does: a pinned one outranks a
  // file host of the other kind, and a file host is read as is.
  const reached = c.reach;
  const blankProjectDatabaseHost = c.service === 'database' && c.position === 'pinned' && c.host.trim() === '';

  it('may start the container unless a pin names another server', async () => {
    arrange(c);
    expect(hostPinnedElsewhere(profile)).toBe(c.position === 'pinned' && !c.reach);
    const { result } = await restart({ profiles: [profile] });
    expect(result.profiles).toEqual(c.position === 'pinned' && !c.reach ? [] : [profile]);
  });

  it('may stop the container only when the next boot does not reach it', async () => {
    arrange(c);
    const { result, stopped } = await restart({ profilesToRemove: [profile] });
    expect(stopped).toBe(!reached);
    expect(result.profilesToRemove).toEqual(reached ? [] : [profile]);
  });

  it('reads the built-in mode from the host', () => {
    arrange(c);
    const mode = controller().getConfig()[c.service];
    // A flag of true beside a file host elsewhere is a saved choice of that host: the flag only starts the container.
    const expected =
      c.position === 'pinned'
        ? { builtIn: c.reach, builtInSet: false }
        : c.flag !== 'true' && c.reach
          ? { builtIn: true, builtInSet: false }
          : { builtIn: c.reach, builtInSet: c.flag !== 'absent' };
    expect({ builtIn: mode.builtIn, builtInSet: mode.builtInSet }).toEqual(expected);
  });

  it("reports a running container as backing the service by the host, and as this instance's by the flag", async () => {
    arrange(c);
    const compose = await status(c, 'compose');
    expect(compose[c.service].builtIn).toBe(c.reach);
    expect(compose[c.service].running).toBe(false);
    const openwa = await status(c, 'openwa');
    expect(openwa[c.service].running).toBe(c.flag === 'true');
  });

  if (c.service !== 'redis') {
    it('keeps the stored credentials of a built-in save only when the bundled container already uses them', () => {
      arrange(c);
      const payload =
        c.service === 'database'
          ? { database: { type: 'postgres', builtIn: true } }
          : { storage: { type: 's3', builtIn: true } };
      if (blankProjectDatabaseHost) {
        expect(() => saved(payload)).toThrow(/DATABASE_HOST is required/);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        return;
      }
      const env = saved(payload);
      const keep = c.position === 'pinned' || reached;
      if (c.service === 'database') expect(env.DATABASE_PASSWORD).toBe(keep ? 'StoredPw789!' : 'openwa');
      else
        expect([env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY]).toEqual(
          keep ? ['StoredKey12345', 'StoredSecret1234567890'] : ['minioadmin', 'minioadmin'],
        );
    });
  }

  if (c.service !== 'redis') {
    it('keeps the stored user, database and schema, or bucket and region, of a built-in save only when the bundled container already serves them', () => {
      arrange(c, STORED_VALUES);
      const payload =
        c.service === 'database'
          ? { database: { type: 'postgres', builtIn: true } }
          : { storage: { type: 's3', builtIn: true } };
      if (blankProjectDatabaseHost) {
        expect(() => saved(payload)).toThrow(/DATABASE_HOST is required/);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        return;
      }
      const env = saved(payload);
      if (c.service === 'database')
        expect([env.DATABASE_USERNAME, env.DATABASE_NAME, env.POSTGRES_SCHEMA]).toEqual(
          reached ? ['app', 'appdb', 'tenant'] : ['openwa', 'openwa', 'public'],
        );
      else expect([env.S3_BUCKET, env.S3_REGION]).toEqual(reached ? ['media', 'eu-west-1'] : ['openwa', 'us-east-1']);
    });
  }

  it('keeps the stored mode of a section sent without its flag, and a stored built-in host with it', () => {
    arrange(c);
    const section =
      c.service === 'database'
        ? { database: { type: 'postgres', host: c.host, port: '5432' } }
        : c.service === 'redis'
          ? { redis: { enabled: true, host: c.host, port: '6379' }, queue: { enabled: false } }
          : { storage: { type: 's3', s3Endpoint: c.host, s3Region: 'us-east-1' } };
    if (blankProjectDatabaseHost) {
      expect(() => saved(section)).toThrow(/DATABASE_HOST is required/);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      return;
    }
    const env = saved(section);
    expect(env[spec.flag]).toBe(c.flag === 'absent' ? undefined : c.flag);
    const sentHost = c.service === 'storage' ? c.host || undefined : c.host.trim() || 'localhost';
    const storedBundled = c.position === 'pinned' ? !c.reach : c.reach;
    expect(env[spec.host]).toBe(storedBundled ? spec.bundledHost : sentHost);
  });
});

it.each(['', ' \t ', '\r'])('lets a blank OS database host %j use the valid generated host', blank => {
  arrange({ service: 'database', host: blank, reach: false, position: 'pinned', flag: 'false' });
  const hostEnvironment: NodeJS.ProcessEnv = { ...SECRETS, DATABASE_HOST: blank };
  clearBlankEnv(hostEnvironment, BLANK_SHADOWED_ENV_KEYS);
  delete process.env.DATABASE_HOST;
  Object.assign(process.env, hostEnvironment);
  recordOsEnvKeys(hostEnvironment);
  recordPinnedEnvKeys(hostEnvironment);

  expect(isEnvPinned('DATABASE_HOST')).toBe(false);
  const env = saved({ queue: { enabled: false } });
  expect(env.DATABASE_HOST).toBe('postgres');
  expect(env.QUEUE_ENABLED).toBe('false');
});
