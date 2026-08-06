import { readFileSync } from 'fs';
import { join } from 'path';
import { DockerService, MANAGED_DOCKER_PROFILES } from './docker.service';

// js-yaml has no bundled types here; require + cast (matches the compose-network.spec.ts pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface ComposeHealthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
}

interface ComposeService {
  image: string;
  container_name: string;
  profiles?: string[];
  restart?: string;
  networks?: string[];
  security_opt?: string[];
  environment?: Record<string, string>;
  command?: string;
  volumes?: string[];
  ports?: string[];
  labels?: string[];
  healthcheck?: ComposeHealthcheck;
  mem_limit?: string;
  pids_limit?: number;
  deploy?: unknown;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes: Record<string, { name?: string }>;
  networks: Record<string, { name?: string }>;
}

/** The subset of Docker.ContainerCreateOptions that createService populates from a spec. */
interface CapturedConfig {
  name: string;
  Image: string;
  Cmd?: string[];
  Env?: string[];
  Labels: Record<string, string>;
  HostConfig: {
    NetworkMode: string;
    RestartPolicy: { Name: string };
    Binds?: string[];
    SecurityOpt?: string[];
    PortBindings?: Record<string, { HostIp: string; HostPort: string }[]>;
    Memory?: number;
    NanoCpus?: number;
    PidsLimit?: number;
  };
  Healthcheck?: { Test: string[]; Interval: number; Timeout: number; Retries: number };
  NetworkingConfig: { EndpointsConfig: Record<string, { Aliases: string[] }> };
}

const PROFILES = ['postgres', 'redis', 'minio'] as const;

const VOLUME_PATH: Record<string, string> = {
  postgres: '/var/lib/postgresql/data',
  redis: '/data',
  minio: '/data',
};

/** Compose durations are strings like '5s'; the Docker API wants nanoseconds. */
const seconds = (v: string): number => {
  const m = /^(\d+)s$/.exec(v);
  if (!m) throw new Error(`unexpected compose duration: ${v}`);
  return parseInt(m[1], 10) * 1e9;
};

const labelsToMap = (list: string[]): Record<string, string> =>
  Object.fromEntries(list.map(l => l.split('=') as [string, string]));

/**
 * Runs createService against a fake daemon and returns the exact ContainerCreateOptions the
 * profile's spec produces — parity is asserted on what would actually be sent to the daemon.
 */
async function capture(profile: string): Promise<CapturedConfig> {
  const service = new DockerService();
  jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);
  let captured: CapturedConfig | undefined;
  const fakeDocker = {
    pull: (_image: string, cb: (err: Error | null, stream: null) => void) => cb(null, null),
    modem: { followProgress: (_stream: null, cb: (err: Error | null) => void) => cb(null) },
    createVolume: jest.fn().mockResolvedValue({}),
    createContainer: (config: CapturedConfig) => {
      captured = config;
      return Promise.resolve({ start: () => Promise.resolve() });
    },
  };
  Object.assign(service as unknown as Record<string, unknown>, { docker: fakeDocker, isAvailable: true });
  await service.createService(profile);
  if (!captured) throw new Error(`createService(${profile}) never created a container`);
  return captured;
}

/**
 * Regression lock: the Docker-API orchestration path (DockerService.getContainerSpec) must stay
 * in parity with the equivalent services in docker-compose.yml. Reads the real compose file so a
 * drift on EITHER side fails here. Deliberate differences (built-in credentials, the postgres
 * init-script mount) are locked too — see the getContainerSpec docblock for the rationale.
 */
describe('DockerService managed specs ↔ docker-compose.yml parity', () => {
  const compose = yaml.load(readFileSync(join(__dirname, '../../../docker-compose.yml'), 'utf8')) as ComposeFile;

  // getContainerSpec reads the S3 credential env vars at call time; scrub them so the
  // default-fallback assertions don't depend on the developer's shell.
  const S3_VARS = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = {};
    for (const k of S3_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of S3_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('the managed profiles are exactly the compose services labeled as built-in', () => {
    const builtin = Object.entries(compose.services)
      .filter(([, svc]) => (svc.labels ?? []).includes('com.openwa.builtin=true'))
      .map(([name]) => name)
      .sort();
    expect([...MANAGED_DOCKER_PROFILES].sort()).toEqual(builtin);
    for (const profile of MANAGED_DOCKER_PROFILES) {
      expect(compose.services[profile].profiles).toContain(profile);
    }
  });

  it.each(PROFILES)('%s: pins the exact compose image and container name', async profile => {
    const cfg = await capture(profile);
    expect(cfg.Image).toBe(compose.services[profile].image);
    expect(cfg.Image).toContain(':'); // an explicit tag, never the floating default
    expect(cfg.name).toBe(compose.services[profile].container_name);
  });

  it.each(PROFILES)('%s: attaches to the fixed openwa-network like the compose service', async profile => {
    const cfg = await capture(profile);
    expect(cfg.HostConfig.NetworkMode).toBe('openwa-network');
    expect(compose.networks['openwa-network'].name).toBe('openwa-network');
    expect(compose.services[profile].networks).toContain('openwa-network');
    // Compose DNS resolves peers by service name; the Docker-API path adds it as an alias.
    expect(cfg.NetworkingConfig.EndpointsConfig['openwa-network'].Aliases).toContain(profile);
  });

  it.each(PROFILES)('%s: uses the same restart policy as compose', async profile => {
    const cfg = await capture(profile);
    expect(compose.services[profile].restart).toBe('unless-stopped');
    expect(cfg.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
  });

  it.each(PROFILES)('%s: carries the same labels as the compose service', async profile => {
    const cfg = await capture(profile);
    expect(cfg.Labels).toEqual(labelsToMap(compose.services[profile].labels ?? []));
  });

  it.each(PROFILES)('%s: applies the same no-new-privileges hardening as compose', async profile => {
    const cfg = await capture(profile);
    expect(compose.services[profile].security_opt).toContain('no-new-privileges:true');
    expect(cfg.HostConfig.SecurityOpt).toEqual(compose.services[profile].security_opt);
  });

  it.each(PROFILES)('%s: binds the same pinned named volume as compose', async profile => {
    const cfg = await capture(profile);
    const composeVol = `${profile}-data`;
    expect(compose.services[profile].volumes).toContain(`${composeVol}:${VOLUME_PATH[profile]}`);
    // The compose volume name is pinned to the literal name the Docker-API path binds.
    expect(compose.volumes[composeVol].name).toBe(`openwa_${composeVol}`);
    expect(cfg.HostConfig.Binds).toEqual([`openwa_${composeVol}:${VOLUME_PATH[profile]}`]);
  });

  it.each(PROFILES)('%s: matches the compose healthcheck timing', async profile => {
    const cfg = await capture(profile);
    const hc = compose.services[profile].healthcheck!;
    expect(cfg.Healthcheck).toMatchObject({
      Interval: seconds(hc.interval),
      Timeout: seconds(hc.timeout),
      Retries: hc.retries,
    });
  });

  it.each(PROFILES)('%s: sets no CPU/memory/PID limits on either path (only openwa-api is limited)', async profile => {
    const svc = compose.services[profile];
    expect(svc.mem_limit).toBeUndefined();
    expect(svc.pids_limit).toBeUndefined();
    expect(svc.deploy).toBeUndefined();
    const cfg = await capture(profile);
    expect(cfg.HostConfig.Memory).toBeUndefined();
    expect(cfg.HostConfig.NanoCpus).toBeUndefined();
    expect(cfg.HostConfig.PidsLimit).toBeUndefined();
  });

  it('postgres: provisions the fixed built-in credentials; compose defaults agree on user/db only', async () => {
    const cfg = await capture('postgres');
    expect(cfg.Env).toEqual(['POSTGRES_USER=openwa', 'POSTGRES_PASSWORD=openwa', 'POSTGRES_DB=openwa']);
    const env = compose.services.postgres.environment!;
    // Compose is the manual operator path: same user/db defaults, but deliberately NO default
    // password (the image fails fast on an empty one). The orchestrated built-in path instead
    // provisions the fixed credential the production boot guard exempts for the built-in,
    // internal-host deployment (see the getContainerSpec docblock).
    expect(env.POSTGRES_USER).toBe('${DATABASE_USERNAME:-openwa}');
    expect(env.POSTGRES_DB).toBe('${DATABASE_NAME:-openwa}');
    expect(env.POSTGRES_PASSWORD).toBe('${DATABASE_PASSWORD:-}');
  });

  it('postgres: healthcheck resolves to the same pg_isready command as compose', async () => {
    const cfg = await capture('postgres');
    const composeTest = compose.services.postgres.healthcheck!.test;
    // Compose interpolates the manual-path user default; the built-in user is always openwa.
    expect(cfg.Healthcheck!.Test[0]).toBe(composeTest[0]);
    expect(cfg.Healthcheck!.Test[1]).toBe(composeTest[1].replace('${DATABASE_USERNAME:-openwa}', 'openwa'));
  });

  it('postgres: publishes no host ports, like compose', async () => {
    const cfg = await capture('postgres');
    expect(compose.services.postgres.ports).toBeUndefined();
    expect(cfg.HostConfig.PortBindings).toBeUndefined();
  });

  it('redis: runs the same command and healthcheck, with no credentials, like compose', async () => {
    const cfg = await capture('redis');
    expect(cfg.Cmd?.join(' ')).toBe(compose.services.redis.command);
    expect(cfg.Healthcheck!.Test).toEqual(compose.services.redis.healthcheck!.test);
    expect(compose.services.redis.environment).toBeUndefined();
    expect(cfg.Env).toBeUndefined();
  });

  // docker-compose.yml has NO env_file — the `environment:` list is an explicit allow-list, so a
  // variable missing from it never reaches the container and the feature it gates stays silently
  // off however the operator's .env is written. Exactly how AUTO_START_SESSIONS was inert before
  // v0.12.0, and how SEND_PACING_* / MEDIA_CONVERSION_* shipped inert alongside CHAT_MEDIA_*.
  const apiForwards = (): Set<string> => {
    const api = (compose.services as Record<string, { environment?: string[] }>)['openwa-api'];
    return new Set((api.environment ?? []).map(line => line.split('=')[0]));
  };

  it.each([
    ['CHAT_MEDIA_*', 'config/configuration.ts', /CHAT_MEDIA_[A-Z_]+/g],
    ['MEDIA_CONVERSION_*/FFMPEG_PATH', 'config/configuration.ts', /MEDIA_CONVERSION_[A-Z_]+|FFMPEG_PATH/g],
    ['SEND_PACING_*', 'modules/message/send-pacing.config.ts', /SEND_PACING_[A-Z_]+/g],
  ])('forwards every %s variable the app reads to the api container', (_family, sourcePath, pattern) => {
    // Derived from the reading source file rather than hardcoded, so a new flag cannot be added to
    // the app and forgotten here.
    const src = readFileSync(join(__dirname, '..', '..', sourcePath), 'utf8');
    const read = [...new Set(src.match(pattern) ?? [])];
    expect(read.length).toBeGreaterThan(0);
    const forwarded = apiForwards();
    expect(read.filter(name => !forwarded.has(name))).toEqual([]);
  });

  it('forwards the session-ownership keys multi-node deployments set (.env.example "Session ownership")', () => {
    const forwarded = apiForwards();
    const keys = [
      'NODE_ID',
      'NODE_URL',
      'SESSION_LEASE_TTL_MS',
      'SESSION_LEASE_HEARTBEAT_MS',
      'SESSION_TAKEOVER_SWEEP_MS',
      'SESSION_PROXY_TIMEOUT_MS',
    ];
    expect(keys.filter(name => !forwarded.has(name))).toEqual([]);
  });

  it('redis: sets the noeviction maxmemory policy BullMQ requires, on both launch paths', async () => {
    const cfg = await capture('redis');
    // The parity assertion above only proves the two launch paths AGREE — dropping the flag from
    // both would keep it green. BullMQ needs noeviction: under any other policy Redis may evict
    // queue keys once maxmemory is reached, losing queued jobs with no error surfaced anywhere.
    expect(compose.services.redis.command).toContain('--maxmemory-policy noeviction');
    expect(cfg.Cmd).toEqual(expect.arrayContaining(['--maxmemory-policy', 'noeviction']));
  });

  it('redis: publishes no host ports, like compose', async () => {
    const cfg = await capture('redis');
    expect(compose.services.redis.ports).toBeUndefined();
    expect(cfg.HostConfig.PortBindings).toBeUndefined();
  });

  it('minio: runs the same server command and healthcheck as compose', async () => {
    const cfg = await capture('minio');
    // Compose quotes the console address; the argv form needs no quotes.
    expect(cfg.Cmd?.join(' ')).toBe(compose.services.minio.command!.replace(/"/g, ''));
    expect(cfg.Healthcheck!.Test).toEqual(compose.services.minio.healthcheck!.test);
  });

  it('minio: falls back to the fixed built-in credentials the dashboard saves', async () => {
    const cfg = await capture('minio');
    expect(cfg.Env).toEqual(['MINIO_ROOT_USER=minioadmin', 'MINIO_ROOT_PASSWORD=minioadmin']);
    const env = compose.services.minio.environment!;
    // Compose (manual path) deliberately ships no default and fails fast on empty creds; the
    // orchestrated path provisions the built-in default instead (see the getContainerSpec docblock).
    expect(env.MINIO_ROOT_USER).toBe('${S3_ACCESS_KEY_ID:-${S3_ACCESS_KEY:-}}');
    expect(env.MINIO_ROOT_PASSWORD).toBe('${S3_SECRET_ACCESS_KEY:-${S3_SECRET_KEY:-}}');
  });

  it('minio: prefers the canonical S3 credential env vars, then the legacy ones', async () => {
    process.env.S3_ACCESS_KEY = 'legacy-user';
    process.env.S3_SECRET_KEY = 'legacy-secret';
    let cfg = await capture('minio');
    expect(cfg.Env).toEqual(['MINIO_ROOT_USER=legacy-user', 'MINIO_ROOT_PASSWORD=legacy-secret']);

    process.env.S3_ACCESS_KEY_ID = 'canonical-user';
    process.env.S3_SECRET_ACCESS_KEY = 'canonical-secret';
    cfg = await capture('minio');
    expect(cfg.Env).toEqual(['MINIO_ROOT_USER=canonical-user', 'MINIO_ROOT_PASSWORD=canonical-secret']);
  });

  it('minio: publishes the same localhost-only ports as compose', async () => {
    const cfg = await capture('minio');
    expect(compose.services.minio.ports).toEqual(['127.0.0.1:9000:9000', '127.0.0.1:9001:9001']);
    expect(cfg.HostConfig.PortBindings).toEqual({
      '9000/tcp': [{ HostIp: '127.0.0.1', HostPort: '9000' }],
      '9001/tcp': [{ HostIp: '127.0.0.1', HostPort: '9001' }],
    });
  });
});
