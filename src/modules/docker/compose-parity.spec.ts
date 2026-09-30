import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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
async function capture(profile: string, Service: typeof DockerService = DockerService): Promise<CapturedConfig> {
  const service = new Service();
  jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);
  let captured: CapturedConfig | undefined;
  const fakeDocker = {
    getImage: () => ({ inspect: () => Promise.reject(Object.assign(new Error('no such image'), { statusCode: 404 })) }),
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
    expect(cfg.Image).not.toMatch(/:latest(@|$)/);
    expect(cfg.name).toBe(compose.services[profile].container_name);
  });

  it('minio: pins a release tag and an image digest, and not the withdrawn minio/minio image', async () => {
    // The equality above keeps both sides the same; this keeps the digest from being dropped from both.
    const cfg = await capture('minio');
    expect(cfg.Image).toMatch(/:RELEASE\.[0-9T-]+Z@sha256:[0-9a-f]{64}$/);
    expect(cfg.Image).not.toMatch(/^(quay\.io\/)?minio\/minio[:@]/);
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
  // v0.12.0, how SEND_PACING_* / MEDIA_CONVERSION_* shipped inert alongside CHAT_MEDIA_*, and how
  // the v0.20.0 WEBHOOK_SSRF_REDIRECTS / PLUGIN_INSTALL_REQUIRE_PIN opt-outs spent a release
  // unreachable from .env. Family-by-family and strict-boolean derivations only ever caught these
  // one prefix or one type at a time, so the rule is now wholesale: every knob .env.example
  // documents that the app actually reads must be forwarded in BOTH compose files, unless a
  // NOT_FORWARDED entry names it with a reason. env-precedence.spec.ts covers the other direction
  // (every blank forward must be cleared when blank, and must not ship uncommented in .env.example).
  const apiForwards = (file: string): Set<string> => {
    const text = readFileSync(join(__dirname, '../../..', file), 'utf8');
    const keys = new Set<string>();
    for (const line of text.split('\n')) {
      const match = /^\s*-\s*([A-Z0-9_]+)=/.exec(line);
      if (match) keys.add(match[1]);
    }
    return keys;
  };

  /** Keys .env.example documents (commented or not): `#?KEY=`. */
  const documentedKeys = (): Set<string> => {
    const example = readFileSync(join(__dirname, '../../../.env.example'), 'utf8');
    const keys = new Set<string>();
    for (const match of example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})=/gm)) keys.add(match[1]);
    return keys;
  };

  /**
   * Keys the backend reads from the environment, excluding specs. Beyond the direct
   * `process.env.KEY` form, three indirections appear in src and must count as reads, or a knob
   * routed through one of them ships unreachable while the gate stays green:
   *   `env.KEY` / `env['KEY']`: a parameter defaulting to `process.env` (reapers, rate limits)
   *   `xyzEnv('KEY')`:          env-helper wrappers (resolveNonNegativeIntEnv & friends)
   *   `.get('KEY')`:            ConfigService.get with an UPPER_SNAKE literal (METRICS_TOKEN)
   */
  const READ_PATTERNS: RegExp[] = [
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /\benv\??\.([A-Z][A-Z0-9_]{2,})/g,
    /\benv\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
    /\b[A-Za-z]+Env\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /\.get<[^>]*>\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\)/g,
    /\.get\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\)/g,
  ];
  const readKeys = (): Set<string> => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
            ? [join(dir, entry.name)]
            : [],
      );
    const keys = new Set<string>();
    for (const file of walk(join(__dirname, '../../..', 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const pattern of READ_PATTERNS) {
        for (const match of src.matchAll(pattern)) keys.add(match[1]);
      }
    }
    return keys;
  };

  // Deliberately NOT forwarded. Each entry states why, so adding a key here is a decision rather
  // than an omission. Shared by both files unless a per-file entry overrides the reason.
  const NOT_FORWARDED: Record<string, Record<string, string>> = {
    'docker-compose.yml': {
      // Owned by the dashboard's Infrastructure page, which writes data/.env.generated on the mounted
      // volume — that file IS read inside the container, so these are settable, just not via .env.
      POSTGRES_BUILTIN: 'dashboard-managed',
      REDIS_BUILTIN: 'dashboard-managed',
      MINIO_BUILTIN: 'dashboard-managed',
      QUEUE_ENABLED: 'dashboard-managed (.env.example documents that a host value is not forwarded)',
      // A typo or an absent value leaves these at the SECURE / documented-default state, so not
      // forwarding them cannot degrade a deployment.
      WEBHOOK_SSRF_PROTECT: 'fails safe (default on)',
      ALLOW_DEV_API_KEY: 'refused outright in production',
    },
    'docker-compose.dev.yml': {
      POSTGRES_BUILTIN: 'dashboard-managed',
      REDIS_BUILTIN: 'dashboard-managed',
      MINIO_BUILTIN: 'dashboard-managed',
      QUEUE_ENABLED: 'dashboard-managed (.env.example documents that a host value is not forwarded)',
      WEBHOOK_SSRF_PROTECT: 'fails safe (default on)',
      // The dev stack manages no built-in datastores; its daemon is the host's local socket, and a
      // stray DOCKER_HOST would point the app at an unrelated daemon.
      DOCKER_HOST: 'local socket is the dev default (production pins its socket-proxy)',
    },
  };

  it.each(['docker-compose.yml', 'docker-compose.dev.yml'])(
    '%s forwards every documented knob the app reads, or names it in the allowlist',
    file => {
      const documented = documentedKeys();
      const read = readKeys();
      // Guards the derivation: either set silently matching nothing would make the test vacuous.
      expect(documented.size).toBeGreaterThan(150);
      expect([...documented].filter(key => read.has(key)).length).toBeGreaterThan(120);

      const forwarded = apiForwards(file);
      const allowlist = NOT_FORWARDED[file];
      const required = [...documented].filter(key => read.has(key));
      expect(required.filter(key => !forwarded.has(key) && !(key in allowlist))).toEqual([]);

      // Keep the allowlist honest in the other direction too: an entry that IS forwarded, or that is
      // no longer a documented knob the app reads, is stale and should be deleted.
      const stale = Object.keys(allowlist).filter(key => forwarded.has(key) || !documented.has(key) || !read.has(key));
      expect(stale).toEqual([]);
    },
  );

  // A compose `environment:` entry overrides the image ENV even when it renders BLANK, and the blank
  // is then cleared by load-env, so a `- PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH:-}`
  // forward deletes the Dockerfile's path inside the container and puppeteer falls back to a
  // bundled Chromium the image deliberately does not ship (PUPPETEER_SKIP_CHROMIUM_DOWNLOAD). The
  // forward must therefore carry the image's own value as its default, kept in sync by this test.
  it('forwards PUPPETEER_EXECUTABLE_PATH with the Dockerfile default, not blank', () => {
    const imageValue = /^ENV PUPPETEER_EXECUTABLE_PATH=(\S+)$/m.exec(
      readFileSync(join(__dirname, '../../../Dockerfile'), 'utf8'),
    )?.[1];
    expect(imageValue).toBeDefined();
    for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
      const line = readFileSync(join(__dirname, '../../..', file), 'utf8')
        .split('\n')
        .find(l => l.trim().startsWith('- PUPPETEER_EXECUTABLE_PATH='));
      expect(line?.trim()).toBe(`- PUPPETEER_EXECUTABLE_PATH=\${PUPPETEER_EXECUTABLE_PATH:-${imageValue}}`);
    }
  });

  // .env.example documents API_PORT as the host port Docker Compose publishes, and the README quick
  // start runs the dev file, so a hardcoded 2785 there ignores the knob when that port is taken.
  it.each(['docker-compose.yml', 'docker-compose.dev.yml'])('%s publishes the API on the API_PORT host port', file => {
    const parsed = yaml.load(readFileSync(join(__dirname, '../../..', file), 'utf8')) as ComposeFile;
    const api = Object.values(parsed.services).find(service => service.container_name === 'openwa-api');
    expect(api?.ports).toEqual([expect.stringMatching(/:\$\{API_PORT:-2785\}:2785$/)]);
  });

  it('openwa-api uses the same readiness healthcheck in both compose files and the image', () => {
    const root = join(__dirname, '../../..');
    const apiHealthcheck = (file: string): string[] | undefined => {
      const parsed = yaml.load(readFileSync(join(root, file), 'utf8')) as ComposeFile;
      return Object.values(parsed.services).find(service => service.container_name === 'openwa-api')?.healthcheck?.test;
    };
    const url = 'http://localhost:2785/api/health/ready';
    expect(apiHealthcheck('docker-compose.yml')).toEqual(['CMD', 'curl', '-f', url]);
    expect(apiHealthcheck('docker-compose.dev.yml')).toEqual(apiHealthcheck('docker-compose.yml'));
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`CMD curl -f ${url} || exit 1`);
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
    // Compose (manual path) deliberately ships no default credentials; the orchestrated path
    // provisions the built-in default instead (see the getContainerSpec docblock). The user default
    // stays empty: a non-empty placeholder would be a valid access key paired with a real password.
    expect(env.MINIO_ROOT_USER).toBe('${S3_ACCESS_KEY_ID:-${S3_ACCESS_KEY:-}}');
    expect(env.MINIO_ROOT_PASSWORD).toBe('${S3_SECRET_ACCESS_KEY:-${S3_SECRET_KEY:-unset}}');
  });

  it('minio: compose falls back to a password too short to be valid, so no secret means no start', () => {
    // Both credentials empty would start the server on its built-in default pair. A placeholder
    // under the 8-character minimum stops it instead; a longer one would become a working default.
    const placeholder = /:-([^:}]*)}}$/.exec(compose.services.minio.environment!.MINIO_ROOT_PASSWORD)?.[1];
    expect(placeholder).toBeTruthy();
    expect(placeholder!.length).toBeLessThan(8);
  });

  it.each(['README.md', 'docs/08-development-guidelines.md'])(
    '%s tells a fresh install not to pair the minio profile with the dashboard built-in storage',
    file => {
      // The dashboard route writes its credentials to data/.env.generated, which compose never reads,
      // so a compose minio started next to it has no password and never comes up. startService then
      // finds that container by its label and only restarts it, so the built-in option cannot recover.
      const text = readFileSync(join(__dirname, '../../..', file), 'utf8').replace(/\s+/g, ' ');
      expect(text).toContain('do not also start the `minio` or `full` profile');
      expect(text).toContain('docker rm -f openwa-minio');
      // Built-in PostgreSQL and Redis also create their own containers. The compose postgres service
      // refuses to initialize without DATABASE_PASSWORD, and startService would only restart it, so
      // the dashboard route must not be told to start any profile.
      expect(text).toContain('each built-in option creates its own container');
      expect(text).not.toContain('--profile postgres --profile redis');
    },
  );

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

  it('minio: provisions the credentials the next boot reads, not the ones this process booted with', async () => {
    // External keys saved from the dashboard reached process.env from data/.env.generated at boot; a
    // switch to built-in storage has since rewritten that file with minioadmin, and the restart that
    // creates the container runs in this old process. Fresh modules: the precedence snapshot is global.
    const dir = mkdtempSync(join(tmpdir(), 'openwa-minio-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(
      join(dir, 'data', '.env.generated'),
      'S3_ACCESS_KEY_ID=minioadmin\nS3_SECRET_ACCESS_KEY=minioadmin\n',
    );
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      let FreshDockerService: typeof DockerService = DockerService;
      jest.isolateModules(() => {
        // require() (not dynamic import()): the relative specifier trips TS2835 under nodenext.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const precedence = require('../../config/env-precedence') as typeof import('../../config/env-precedence');
        precedence.recordOsEnvKeys({});
        precedence.recordPinnedEnvKeys({});
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        FreshDockerService = (require('./docker.service') as typeof import('./docker.service')).DockerService;
      });
      process.env.S3_ACCESS_KEY_ID = 'AKIAEXTERNAL';
      process.env.S3_SECRET_ACCESS_KEY = 'external-secret';
      const cfg = await capture('minio', FreshDockerService);
      expect(cfg.Env).toEqual(['MINIO_ROOT_USER=minioadmin', 'MINIO_ROOT_PASSWORD=minioadmin']);
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('minio: built-in publishes no host ports, compose keeps its loopback ports', async () => {
    // The built-in container runs the fixed built-in credentials, which the boot guard exempts only
    // because nothing outside the internal network can reach it. Compose is the manual path with
    // operator-set credentials, so it keeps its loopback publish.
    const cfg = await capture('minio');
    expect(cfg.HostConfig.PortBindings).toBeUndefined();
    expect(compose.services.minio.ports).toEqual(['127.0.0.1:9000:9000', '127.0.0.1:9001:9001']);
  });
});

/**
 * The image's pg_dump/psql must never be OLDER than the Postgres it talks to: pg_dump refuses a
 * newer server outright ("aborting because of server version mismatch"), so an in-container
 * backup of a DATABASE_TYPE=postgres deployment fails on version alone. The server major is
 * declared once for the compose stack and again for the container the app orchestrates itself,
 * while the client major lives in the Dockerfile, so bumping either server silently breaks backups
 * until this fails.
 */
describe('PostgreSQL client is not older than the servers the stack ships', () => {
  const root = join(__dirname, '../../..');

  const major = (file: string, pattern: RegExp): number => {
    const match = readFileSync(join(root, file), 'utf8').match(pattern);
    if (!match) throw new Error(`could not read a Postgres major version from ${file} via ${String(pattern)}`);
    return Number(match[1]);
  };

  it('the Dockerfile client covers both the compose server and the managed-container server', () => {
    const client = major('Dockerfile', /postgresql-client-(\d+)/);
    const composeServer = major('docker-compose.yml', /image:\s*postgres:(\d+)/);
    const managedServer = major('src/modules/docker/docker.service.ts', /image: 'postgres:(\d+)/);

    // Reported together so a failure names every version at once rather than the first mismatch.
    expect({
      client,
      composeServerCovered: composeServer <= client,
      managedServerCovered: managedServer <= client,
    }).toEqual({ client, composeServerCovered: true, managedServerCovered: true });
  });
});
