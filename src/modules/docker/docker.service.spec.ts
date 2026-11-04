import Docker from 'dockerode';
import { DockerService, prestartBuiltinDatabase } from './docker.service';
import { recordOsEnvKeys, recordPinnedEnvKeys } from '../../config/env-precedence';
import { HOST_SPELLINGS } from '../../../test/fixtures/builtin-mode-cases';

// Prevent actual Docker connections on module init during tests
jest.mock('dockerode');

// The auto-mocked constructor: initializeDocker does `new Docker(...)` internally, so the
// onModuleInit/isDockerAvailable tests steer the daemon by replacing its implementation.
const DockerMock = Docker as unknown as jest.Mock;

/** A daemon with no local copy of any image: inspect answers 404, so createService pulls. */
const imageNotCached = () => ({
  inspect: jest.fn().mockRejectedValue(Object.assign(new Error('no such image'), { statusCode: 404 })),
});

describe('DockerService.getRunningBuiltinServices', () => {
  const container = (name: string, service: string, state: string, labels: Record<string, string> = {}) => ({
    id: name,
    name,
    state,
    status: state,
    labels: { 'com.openwa.service': service, 'com.openwa.builtin': 'true', ...labels },
  });

  it('reports a service built-in only when its labeled container is actually running', async () => {
    const service = new DockerService();
    jest
      .spyOn(service, 'listContainers')
      .mockResolvedValue([
        container('openwa-postgres', 'database', 'running'),
        container('openwa-redis', 'cache', 'exited'),
      ]);

    expect(await service.getRunningBuiltinServices()).toEqual({ database: 'openwa', cache: false, storage: false });
  });

  it('names a running container Docker Compose created, by its project label', async () => {
    const service = new DockerService();
    jest
      .spyOn(service, 'listContainers')
      .mockResolvedValue([
        container('openwa-postgres', 'database', 'running', { 'com.docker.compose.project': 'openwa' }),
        container('openwa-redis', 'cache', 'running'),
        container('openwa-minio', 'storage', 'exited', { 'com.docker.compose.project': 'openwa' }),
      ]);

    expect(await service.getRunningBuiltinServices()).toEqual({ database: 'compose', cache: 'openwa', storage: false });
  });

  it('reports all false when a live inventory contains no bundled containers', async () => {
    const service = new DockerService();
    jest.spyOn(service, 'listContainers').mockResolvedValue([]);
    expect(await service.getRunningBuiltinServices()).toEqual({ database: false, cache: false, storage: false });
  });
});

describe('DockerService.buildDockerOptions', () => {
  let service: DockerService;
  const originalDockerHost = process.env.DOCKER_HOST;

  beforeEach(() => {
    service = new DockerService();
  });

  afterEach(() => {
    if (originalDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = originalDockerHost;
    }
  });

  it('returns TCP options when DOCKER_HOST is set to tcp://host:port', () => {
    process.env.DOCKER_HOST = 'tcp://docker-proxy:2375';
    expect(service.buildDockerOptions()).toEqual({
      host: 'docker-proxy',
      port: 2375,
      protocol: 'http',
    });
  });

  it('falls back to unix socket when DOCKER_HOST is not set', () => {
    delete process.env.DOCKER_HOST;
    expect(service.buildDockerOptions()).toEqual({
      socketPath: '/var/run/docker.sock',
    });
  });

  it('falls back to unix socket for unsupported DOCKER_HOST schemes', () => {
    process.env.DOCKER_HOST = 'unix:///run/docker.sock';
    expect(service.buildDockerOptions()).toEqual({
      socketPath: '/var/run/docker.sock',
    });
  });
});

describe('DockerService.stopManagedService (stop-only teardown)', () => {
  // Teardown is deliberately stop-only: the pinned docker-socket-proxy v0.5.0 never reads its
  // DELETE env flag (deletion is admitted only as an undocumented side effect of its POST
  // method gate), so the code must not depend on container.remove() at all.
  const makeService = (container: unknown) => {
    const service = new DockerService();
    const getContainerByService = jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);
    return { service, getContainerByService };
  };

  it('maps the profile to its service label and stops a running container without removing it', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: true } }),
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    };
    const { service, getContainerByService } = makeService(container);

    await expect(service.stopManagedService('postgres')).resolves.toBe(true);

    expect(getContainerByService).toHaveBeenCalledWith('database');
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).not.toHaveBeenCalled();
  });

  it('leaves an already-stopped container alone (no stop, no remove)', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      stop: jest.fn(),
      remove: jest.fn(),
    };
    const { service } = makeService(container);

    await expect(service.stopManagedService('redis')).resolves.toBe(true);

    expect(container.stop).not.toHaveBeenCalled();
    expect(container.remove).not.toHaveBeenCalled();
  });

  it('returns true when the container is already gone', async () => {
    const { service } = makeService(null);
    await expect(service.stopManagedService('minio')).resolves.toBe(true);
  });

  it('reports failure honestly when stop fails (and still never removes)', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: true } }),
      stop: jest.fn().mockRejectedValue(new Error('daemon gone')),
      remove: jest.fn(),
    };
    const { service } = makeService(container);

    await expect(service.stopManagedService('postgres')).resolves.toBe(false);

    expect(container.remove).not.toHaveBeenCalled();
  });
});

describe('DockerService.getContainerByService exact-name fallback', () => {
  // Label lookup returns nothing → exercises the name fallback. The fallback must match the exact
  // OpenWA-managed container name, never a substring (a substring — and especially the empty string —
  // would let an arbitrary container be resolved and torn down).
  function withFakeDocker(containers: Array<{ Id: string; Names: string[] }>) {
    const service = new DockerService();
    const listContainers = jest
      .fn()
      .mockResolvedValueOnce([]) // label-filtered lookup: no match
      .mockResolvedValueOnce(containers); // fallback: all containers
    const getContainer = jest.fn((id: string) => ({ id }));
    Object.assign(service as unknown as Record<string, unknown>, {
      docker: { listContainers, getContainer },
      isAvailable: true,
    });
    return { service, getContainer };
  }

  it('does not resolve any container for an empty service name', async () => {
    const { service, getContainer } = withFakeDocker([{ Id: 'abc', Names: ['/openwa-postgres'] }]);
    expect(await service.getContainerByService('')).toBeNull();
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('does not resolve a container by substring of its name', async () => {
    const { service, getContainer } = withFakeDocker([{ Id: 'abc', Names: ['/openwa-postgres-primary'] }]);
    // 'postgres' is a substring of 'openwa-postgres-primary' but not the exact managed name.
    expect(await service.getContainerByService('postgres')).toBeNull();
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('resolves the exact openwa-<service> container', async () => {
    const { service, getContainer } = withFakeDocker([
      { Id: 'p', Names: ['/openwa-postgres'] },
      { Id: 'r', Names: ['/openwa-redis'] },
    ]);
    const result = await service.getContainerByService('redis');
    expect(getContainer).toHaveBeenCalledWith('r');
    expect(result).toEqual({ id: 'r' });
  });
});

describe('DockerService.onModuleInit', () => {
  // The probe runs against whatever buildDockerOptions() points at, but the dockerode
  // constructor is the auto-mock — the "daemon" is whatever the test's fake says it is,
  // so no real socket is ever touched.
  const ENV_KEYS = [
    'DOCKER_HOST',
    'REDIS_BUILTIN',
    'POSTGRES_BUILTIN',
    'MINIO_BUILTIN',
    'DATABASE_TYPE',
    'STORAGE_TYPE',
    'REDIS_ENABLED',
    'QUEUE_ENABLED',
    'CACHE_ENABLED',
    'DATABASE_HOST',
    'REDIS_HOST',
    'S3_ENDPOINT',
  ];
  let savedEnv: Record<string, string | undefined> = {};

  const happyDocker = () => ({
    ping: jest.fn().mockResolvedValue(undefined),
    listContainers: jest.fn().mockResolvedValue([]),
    getImage: imageNotCached,
    pull: (_image: string, cb: (err: Error | null, stream: null) => void) => cb(null, null),
    modem: { followProgress: (_stream: null, cb: (err: Error | null) => void) => cb(null) },
    createVolume: jest.fn().mockResolvedValue({}),
    createContainer: jest.fn().mockResolvedValue({ start: jest.fn().mockResolvedValue(undefined) }),
  });

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    recordPinnedEnvKeys({});
    DockerMock.mockReset();
  });

  it('does not throw when the Docker socket is absent — orchestration is disabled and bootstrap is skipped', async () => {
    DockerMock.mockImplementation(() => ({
      ping: jest.fn().mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock')),
    }));
    const service = new DockerService();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.isDockerAvailable()).toBe(false);
  });

  it('bootstraps the env-configured built-in profiles when the daemon is reachable', async () => {
    process.env.REDIS_BUILTIN = 'true';
    process.env.REDIS_ENABLED = 'true';
    const docker = happyDocker();
    DockerMock.mockImplementation(() => docker);
    const service = new DockerService();

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(service.isDockerAvailable()).toBe(true);
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ name: 'openwa-redis' }));
  });

  it('logs a warning but still resolves when bootstrap orchestration fails', async () => {
    process.env.REDIS_BUILTIN = 'true';
    process.env.REDIS_ENABLED = 'true';
    const docker = {
      ...happyDocker(),
      pull: (_image: string, cb: (err: Error | null, stream: null) => void) => cb(new Error('pull denied'), null),
    };
    DockerMock.mockImplementation(() => docker);
    const service = new DockerService();
    const warn = jest
      .spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.isDockerAvailable()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Bootstrap Orchestration] Issues'));
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  // A built-in flag starts its container only for a datastore this boot uses: a flag left beside a SQLite database,
  // local storage or a Redis nothing reaches would otherwise run a container on every boot that nothing dials.
  // Redis is reached by the queue and the cache as well as by REDIS_ENABLED.
  describe.each([
    ['openwa-postgres', 'POSTGRES_BUILTIN', [{ DATABASE_TYPE: 'postgres' }], [{}, { DATABASE_TYPE: 'sqlite' }]],
    [
      'openwa-redis',
      'REDIS_BUILTIN',
      [{ REDIS_ENABLED: 'true' }, { QUEUE_ENABLED: 'true' }, { CACHE_ENABLED: 'true' }],
      [{}, { REDIS_ENABLED: 'false', QUEUE_ENABLED: 'false', CACHE_ENABLED: 'false' }],
    ],
    ['openwa-minio', 'MINIO_BUILTIN', [{ STORAGE_TYPE: 's3' }], [{}, { STORAGE_TYPE: 'local' }]],
  ] as const)('%s', (container, flag, used, unused) => {
    const started = async (env: Record<string, string>): Promise<boolean> => {
      Object.assign(process.env, { [flag]: 'true' }, env);
      const docker = happyDocker();
      DockerMock.mockImplementation(() => docker);
      await new DockerService().onModuleInit();
      return docker.createContainer.mock.calls.some(([spec]) => (spec as { name: string }).name === container);
    };

    it.each(used.map(env => [JSON.stringify(env), env]))('is started when %s', async (_label, env) => {
      expect(await started(env)).toBe(true);
    });

    it.each(unused.map(env => [JSON.stringify(env), env]))('is not started when %s', async (_label, env) => {
      expect(await started(env)).toBe(false);
    });
  });

  // The host the environment pins outranks the saved file at boot, so a bundled container started for a host pinned
  // elsewhere would run with nothing dialling it. A pinned host that reaches the container in any spelling still starts
  // it: the next boot dials it.
  describe.each([
    ['openwa-postgres', 'POSTGRES_BUILTIN', { DATABASE_TYPE: 'postgres' }, 'DATABASE_HOST', 'database'],
    ['openwa-redis', 'REDIS_BUILTIN', { REDIS_ENABLED: 'true' }, 'REDIS_HOST', 'redis'],
    ['openwa-minio', 'MINIO_BUILTIN', { STORAGE_TYPE: 's3' }, 'S3_ENDPOINT', 'storage'],
  ] as const)('%s with its host pinned', (container, flag, use, hostKey, service) => {
    it.each([
      ...HOST_SPELLINGS[service].reach.map(host => [host, true] as const),
      ...HOST_SPELLINGS[service].elsewhere.map(host => [host, false] as const),
    ])('to %j is started: %s', async (host, expected) => {
      Object.assign(process.env, { [flag]: 'true', [hostKey]: host }, use);
      recordPinnedEnvKeys({ [hostKey]: host });
      const docker = happyDocker();
      DockerMock.mockImplementation(() => docker);
      await new DockerService().onModuleInit();

      const names = docker.createContainer.mock.calls.map(([spec]) => (spec as { name: string }).name);
      expect(names.includes(container)).toBe(expected);
    });
  });
});

describe('prestartBuiltinDatabase', () => {
  const builtin = { DATABASE_TYPE: 'postgres', POSTGRES_BUILTIN: 'true' };

  afterEach(() => DockerMock.mockReset());

  it('starts a stopped built-in postgres container through a real DockerService', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      start: jest.fn().mockResolvedValue(undefined),
    };
    const docker = {
      ping: jest.fn().mockResolvedValue(undefined),
      listContainers: jest.fn().mockResolvedValue([{ Id: 'pg' }]),
      getContainer: jest.fn().mockReturnValue(container),
    };
    DockerMock.mockImplementation(() => docker);

    await prestartBuiltinDatabase(builtin, new DockerService());

    expect(docker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['com.openwa.service=database'] },
      abortSignal: expect.any(AbortSignal) as unknown,
    });
    expect(container.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an sqlite deployment', { DATABASE_TYPE: 'sqlite', POSTGRES_BUILTIN: 'true' }],
    ['an external postgres', { DATABASE_TYPE: 'postgres', POSTGRES_BUILTIN: 'false' }],
    ['no built-in flag', { DATABASE_TYPE: 'postgres' }],
  ])('does nothing for %s', async (_label, env) => {
    const service = { startBuiltinDatabase: jest.fn().mockResolvedValue(undefined) };
    await prestartBuiltinDatabase(env, service);
    expect(service.startBuiltinDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ...HOST_SPELLINGS.database.reach.map(host => [host, 1] as const),
    ...HOST_SPELLINGS.database.elsewhere.map(host => [host, 0] as const),
  ])('with DATABASE_HOST pinned to %j starts the container %i times', async (host, calls) => {
    recordPinnedEnvKeys({ DATABASE_HOST: host });
    const service = { startBuiltinDatabase: jest.fn().mockResolvedValue(undefined) };
    try {
      await prestartBuiltinDatabase({ ...builtin, DATABASE_HOST: host }, service);
    } finally {
      recordPinnedEnvKeys({});
    }
    expect(service.startBuiltinDatabase).toHaveBeenCalledTimes(calls);
  });

  it('gives up after the timeout when the Docker endpoint never answers', async () => {
    const service = { startBuiltinDatabase: () => new Promise<void>(() => undefined) };
    await expect(prestartBuiltinDatabase(builtin, service, 10)).resolves.toBeUndefined();
  });

  it('never throws, so boot proceeds to the data connection as before', async () => {
    const service = { startBuiltinDatabase: jest.fn().mockRejectedValue(new Error('boom')) };
    await expect(prestartBuiltinDatabase(builtin, service)).resolves.toBeUndefined();
  });
});

describe('DockerService.isDockerAvailable', () => {
  const originalDockerHost = process.env.DOCKER_HOST;

  afterEach(() => {
    if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = originalDockerHost;
    DockerMock.mockReset();
  });

  it('returns the live availability flag', () => {
    delete process.env.DOCKER_HOST; // no re-probe: the flag is reported as-is
    const service = new DockerService();
    expect(service.isDockerAvailable()).toBe(false);
    Object.assign(service as unknown as Record<string, unknown>, { isAvailable: true });
    expect(service.isDockerAvailable()).toBe(true);
  });

  it('re-probes once in the background when DOCKER_HOST is set and the first probe failed', async () => {
    process.env.DOCKER_HOST = 'tcp://docker-proxy:2375';
    const ping = jest.fn().mockResolvedValue(undefined);
    DockerMock.mockImplementation(() => ({ ping }));
    const service = new DockerService();

    // The first call reports the stale false and kicks off the one-shot re-probe...
    expect(service.isDockerAvailable()).toBe(false);
    // ...and the in-flight guard stops a second probe from piling up.
    expect(service.isDockerAvailable()).toBe(false);
    expect(DockerMock).toHaveBeenCalledTimes(1);

    await new Promise(resolve => setImmediate(resolve));

    expect(ping).toHaveBeenCalledTimes(1);
    expect(service.isDockerAvailable()).toBe(true);
  });
});

describe('DockerService.listContainers', () => {
  const makeService = (listContainers: jest.Mock) => {
    const service = new DockerService();
    Object.assign(service as unknown as Record<string, unknown>, {
      docker: { listContainers },
      isAvailable: true,
    });
    return service;
  };

  it('returns no live inventory when Docker is unavailable', async () => {
    expect(await new DockerService().listContainers()).toBeNull();
  });

  it('maps only OpenWA containers (label or /openwa- name) to ContainerInfo', async () => {
    const service = makeService(
      jest.fn().mockResolvedValue([
        {
          Id: 'aabbccddeeff00112233',
          Names: ['/openwa-postgres'],
          State: 'running',
          Status: 'Up 2 hours',
          Labels: { 'com.openwa.service': 'database', 'com.openwa.builtin': 'true' },
        },
        { Id: '11223344556677889900', Names: ['/openwa-redis'], State: 'exited', Status: 'Exited (0) yesterday' },
        // Label-only match with sparse fields: falls back to 'unknown' placeholders.
        { Id: 'ffee0011223344556677', Labels: { 'com.openwa.service': 'cache' } },
        { Id: 'deadbeef0011', Names: ['/unrelated'], State: 'running', Status: 'Up', Labels: {} },
      ]),
    );

    expect(await service.listContainers()).toEqual([
      {
        id: 'aabbccddeeff',
        name: 'openwa-postgres',
        state: 'running',
        status: 'Up 2 hours',
        labels: { 'com.openwa.service': 'database', 'com.openwa.builtin': 'true' },
      },
      { id: '112233445566', name: 'openwa-redis', state: 'exited', status: 'Exited (0) yesterday', labels: {} },
      {
        id: 'ffee00112233',
        name: 'unknown',
        state: 'unknown',
        status: 'unknown',
        labels: { 'com.openwa.service': 'cache' },
      },
    ]);
  });

  it('returns no live inventory when the daemon listing fails', async () => {
    const service = makeService(jest.fn().mockRejectedValue(new Error('daemon gone')));
    expect(await service.listContainers()).toBeNull();
  });
});

describe('DockerService.getContainerByService label match and guard rails', () => {
  it('returns null when Docker is unavailable', async () => {
    expect(await new DockerService().getContainerByService('database')).toBeNull();
  });

  it('resolves the container by its com.openwa.service label', async () => {
    const service = new DockerService();
    const listContainers = jest.fn().mockResolvedValue([{ Id: 'label-hit-1', Names: ['/openwa-postgres'] }]);
    const getContainer = jest.fn((id: string) => ({ id }));
    Object.assign(service as unknown as Record<string, unknown>, {
      docker: { listContainers, getContainer },
      isAvailable: true,
    });

    const result = await service.getContainerByService('database');

    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['com.openwa.service=database'] },
      abortSignal: expect.any(AbortSignal) as unknown,
    });
    expect(getContainer).toHaveBeenCalledWith('label-hit-1');
    expect(result).toEqual({ id: 'label-hit-1' });
  });

  it('returns null when the daemon lookup fails', async () => {
    const service = new DockerService();
    Object.assign(service as unknown as Record<string, unknown>, {
      docker: { listContainers: jest.fn().mockRejectedValue(new Error('daemon gone')) },
      isAvailable: true,
    });
    expect(await service.getContainerByService('database')).toBeNull();
  });
});

describe('DockerService.createService', () => {
  const withDocker = (docker: unknown) => {
    const service = new DockerService();
    Object.assign(service as unknown as Record<string, unknown>, { docker, isAvailable: true });
    return service;
  };

  it('returns false when Docker is unavailable', async () => {
    expect(await new DockerService().createService('redis')).toBe(false);
  });

  it('returns false for an unknown profile', async () => {
    expect(await withDocker({}).createService('not-a-profile')).toBe(false);
  });

  it('returns true without pulling when the container already exists and is running', async () => {
    const service = withDocker({});
    const container = { inspect: jest.fn().mockResolvedValue({ State: { Running: true } }), start: jest.fn() };
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);

    await expect(service.createService('postgres')).resolves.toBe(true);
    expect(container.start).not.toHaveBeenCalled();
  });

  it('starts the retained container when it exists but is stopped', async () => {
    const service = withDocker({});
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      start: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);

    await expect(service.createService('redis')).resolves.toBe(true);
    expect(container.start).toHaveBeenCalledTimes(1);
  });

  it('pulls, creates the volume and container, and starts it (a pre-existing volume is fine)', async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    const docker = {
      getImage: imageNotCached,
      pull: (_image: string, cb: (err: Error | null, stream: null) => void) => cb(null, null),
      modem: { followProgress: (_stream: null, cb: (err: Error | null) => void) => cb(null) },
      // EEXIST races are normal — the volume may survive from an earlier run.
      createVolume: jest.fn().mockRejectedValue(new Error('volume already exists')),
      createContainer: jest.fn().mockResolvedValue({ start }),
    };
    const service = withDocker(docker);
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);

    await expect(service.createService('redis')).resolves.toBe(true);

    expect(docker.createVolume).toHaveBeenCalledWith({ Name: 'openwa_redis-data' });
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'openwa-redis', Image: 'redis:7-alpine' }),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('returns false when the daemon rejects the image pull', async () => {
    const docker = {
      modem: {},
      getImage: imageNotCached,
      pull: (_image: string, cb: (err: Error | null, stream: null) => void) =>
        cb(new Error('pull access denied'), null),
    };
    const service = withDocker(docker);
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);

    await expect(service.createService('redis')).resolves.toBe(false);
  });

  it('creates the container from a cached image without pulling it', async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    const getImage = jest.fn(() => ({ inspect: jest.fn().mockResolvedValue({ Id: 'sha256:abc' }) }));
    const docker = {
      modem: {},
      getImage,
      pull: jest.fn(),
      createVolume: jest.fn().mockResolvedValue({}),
      createContainer: jest.fn().mockResolvedValue({ start }),
    };
    const service = withDocker(docker);
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);

    await expect(service.createService('redis')).resolves.toBe(true);

    expect(getImage).toHaveBeenCalledWith('redis:7-alpine');
    expect(docker.pull).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('pulls the pinned image once when it is not on the host', async () => {
    const pull = jest.fn((_image: string, cb: (err: Error | null, stream: null) => void) => cb(null, null));
    const docker = {
      getImage: imageNotCached,
      pull,
      modem: { followProgress: (_stream: null, cb: (err: Error | null) => void) => cb(null) },
      createVolume: jest.fn().mockResolvedValue({}),
      createContainer: jest.fn().mockResolvedValue({ start: jest.fn().mockResolvedValue(undefined) }),
    };
    const service = withDocker(docker);
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);

    await expect(service.createService('redis')).resolves.toBe(true);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith('redis:7-alpine', expect.any(Function));
  });
});

describe('DockerService.startService', () => {
  it('creates the mapped profile when no container exists yet', async () => {
    const service = new DockerService();
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);
    const createService = jest.spyOn(service, 'createService').mockResolvedValue(true);

    await expect(service.startService('database')).resolves.toBe(true);
    expect(createService).toHaveBeenCalledWith('postgres');
  });

  it('passes an unmapped service name through as its own profile', async () => {
    const service = new DockerService();
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);
    const createService = jest.spyOn(service, 'createService').mockResolvedValue(false);

    await expect(service.startService('custom-service')).resolves.toBe(false);
    expect(createService).toHaveBeenCalledWith('custom-service');
  });

  it('returns true when the container is already running', async () => {
    const service = new DockerService();
    const container = { inspect: jest.fn().mockResolvedValue({ State: { Running: true } }), start: jest.fn() };
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);

    await expect(service.startService('cache')).resolves.toBe(true);
    expect(container.start).not.toHaveBeenCalled();
  });

  it('starts a stopped container', async () => {
    const service = new DockerService();
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      start: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);

    await expect(service.startService('cache')).resolves.toBe(true);
    expect(container.start).toHaveBeenCalledTimes(1);
  });

  it('returns false when the daemon rejects the start', async () => {
    const service = new DockerService();
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      start: jest.fn().mockRejectedValue(new Error('daemon gone')),
    };
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);

    await expect(service.startService('cache')).resolves.toBe(false);
  });
});

describe('DockerService image drift warning', () => {
  const OLD_IMAGE = 'minio/minio:RELEASE.2024-01-01T00-00-00Z';
  const pinOf = (service: DockerService, profile: string): string =>
    (service as unknown as { getContainerSpec(p: string): { image: string } }).getContainerSpec(profile).image;
  const retained = (running: boolean, image?: string) => ({
    inspect: jest.fn().mockResolvedValue({
      Name: '/openwa-minio',
      State: { Running: running },
      ...(image ? { Config: { Image: image } } : {}),
    }),
    start: jest.fn().mockResolvedValue(undefined),
  });
  const setup = (container: unknown) => {
    const service = new DockerService();
    Object.assign(service as unknown as Record<string, unknown>, { docker: {}, isAvailable: true });
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);
    const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn');
    warn.mockImplementation(() => undefined);
    return { service, warn };
  };

  it('warns when a stopped retained container runs an older image, and still starts it', async () => {
    const container = retained(false, OLD_IMAGE);
    const { service, warn } = setup(container);

    await expect(service.startService('storage')).resolves.toBe(true);

    expect(container.start).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String((warn.mock.calls[0] as unknown[])[0]);
    expect(message).toContain('openwa-minio');
    expect(message).toContain(OLD_IMAGE);
    expect(message).toContain(pinOf(service, 'minio'));
    expect(message).toContain('docker rm -f openwa-minio');
    expect(message).not.toContain('data migration');
  });

  it('adds the data-migration caveat for a drifted PostgreSQL container', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({
        Name: '/openwa-postgres',
        State: { Running: false },
        Config: { Image: 'postgres:15-alpine' },
      }),
      start: jest.fn().mockResolvedValue(undefined),
    };
    const { service, warn } = setup(container);

    await expect(service.startService('database')).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String((warn.mock.calls[0] as unknown[])[0]);
    expect(message).toContain('docker rm -f openwa-postgres');
    expect(message).toContain('major version change needs a data migration');
  });

  it('warns for a running drifted container without starting it', async () => {
    const container = retained(true, OLD_IMAGE);
    const { service, warn } = setup(container);

    await expect(service.startService('storage')).resolves.toBe(true);
    expect(container.start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the container runs the pinned image or reports no image', async () => {
    const pinned = setup(null);
    const onPin = retained(false, pinOf(pinned.service, 'minio'));
    jest.spyOn(pinned.service, 'getContainerByService').mockResolvedValue(onPin as never);
    await expect(pinned.service.startService('storage')).resolves.toBe(true);
    expect(pinned.warn).not.toHaveBeenCalled();

    const bare = setup(retained(false));
    await expect(bare.service.startService('storage')).resolves.toBe(true);
    expect(bare.warn).not.toHaveBeenCalled();
  });

  it('warns on the createService name-fallback branch too', async () => {
    const { service, warn } = setup(retained(false, OLD_IMAGE));

    await expect(service.createService('minio')).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(OLD_IMAGE));
  });

  it('does not turn a drifted retained container into an orchestration failure', async () => {
    const { service } = setup(retained(false, OLD_IMAGE));

    const result = await service.orchestrateProfiles(['minio']);
    expect(result.success).toBe(true);
    expect(result.containersStarted).toEqual(['minio']);
  });
});

describe('DockerService.stopService', () => {
  const makeService = (container: unknown) => {
    const service = new DockerService();
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);
    return service;
  };

  it('stops a running container and retains it', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: true } }),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    await expect(makeService(container).stopService('database')).resolves.toBe(true);
    expect(container.stop).toHaveBeenCalledTimes(1);
  });

  it('returns true when the container is already stopped', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: false } }),
      stop: jest.fn(),
    };
    await expect(makeService(container).stopService('database')).resolves.toBe(true);
    expect(container.stop).not.toHaveBeenCalled();
  });

  it('returns true when the container does not exist', async () => {
    await expect(makeService(null).stopService('database')).resolves.toBe(true);
  });

  it('returns false when the daemon rejects the stop', async () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({ State: { Running: true } }),
      stop: jest.fn().mockRejectedValue(new Error('daemon gone')),
    };
    await expect(makeService(container).stopService('database')).resolves.toBe(false);
  });
});

describe('DockerService.orchestrateProfiles', () => {
  const availableService = () => {
    const service = new DockerService();
    Object.assign(service as unknown as Record<string, unknown>, { docker: {}, isAvailable: true });
    return service;
  };

  it('fails fast when Docker is unavailable, keeping the estimated restart time', async () => {
    const result = await new DockerService().orchestrateProfiles(['postgres', 'redis', 'minio']);
    expect(result).toEqual({
      success: false,
      message: 'Docker is not available',
      containersStarted: [],
      containersStopped: [],
      errors: [],
      estimatedTime: 15 + 20 + 13 + 15,
    });
  });

  it('starts each mapped profile in order and reports the success message', async () => {
    const service = availableService();
    const startService = jest.spyOn(service, 'startService').mockResolvedValue(true);

    const result = await service.orchestrateProfiles(['postgres', 'redis']);

    expect(startService).toHaveBeenNthCalledWith(1, 'database');
    expect(startService).toHaveBeenNthCalledWith(2, 'cache');
    expect(result).toEqual({
      success: true,
      message: 'Successfully orchestrated 2 service(s)',
      containersStarted: ['postgres', 'redis'],
      containersStopped: [],
      errors: [],
      estimatedTime: 15 + 20 + 13,
    });
  });

  it('collects per-profile failures and still succeeds when at least one started', async () => {
    const service = availableService();
    jest.spyOn(service, 'startService').mockImplementation((svc: string) => Promise.resolve(svc === 'database'));

    const result = await service.orchestrateProfiles(['postgres', 'redis']);

    expect(result.success).toBe(true);
    expect(result.containersStarted).toEqual(['postgres']);
    expect(result.errors).toEqual([
      "Failed to create or start the 'redis' container; see the server log for the Docker error.",
    ]);
    expect(result.message).toBe(result.errors.join('; '));
  });

  it('captures a thrown start error instead of rejecting, and fails when nothing started', async () => {
    const service = availableService();
    jest.spyOn(service, 'startService').mockRejectedValue(new Error('boom'));

    const result = await service.orchestrateProfiles(['postgres']);

    expect(result.success).toBe(false);
    expect(result.containersStarted).toEqual([]);
    expect(result.errors).toEqual(['Failed to start postgres: boom']);
    expect(result.message).toBe('Failed to start postgres: boom');
  });
});

describe('DockerService availability recovery', () => {
  const keys = [
    'DOCKER_HOST',
    'DATABASE_TYPE',
    'STORAGE_TYPE',
    'REDIS_ENABLED',
    'QUEUE_ENABLED',
    'CACHE_ENABLED',
    'POSTGRES_BUILTIN',
    'REDIS_BUILTIN',
    'MINIO_BUILTIN',
    'REDIS_HOST',
    'DATABASE_PASSWORD',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      DOCKER_HOST: 'tcp://proxy.invalid:2375',
      DATABASE_TYPE: 'sqlite',
      STORAGE_TYPE: 'local',
      POSTGRES_BUILTIN: 'true',
      REDIS_BUILTIN: 'true',
      MINIO_BUILTIN: 'true',
      REDIS_HOST: 'redis',
      DATABASE_PASSWORD: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
      S3_ACCESS_KEY: '',
      S3_SECRET_KEY: '',
    });
    recordPinnedEnvKeys({});
    recordOsEnvKeys(process.env);
    jest.useFakeTimers();
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    recordPinnedEnvKeys({});
    recordOsEnvKeys(process.env);
    DockerMock.mockReset();
    jest.useRealTimers();
  });

  it.each([
    [{ REDIS_ENABLED: 'true' }, false, ['openwa-redis']],
    [{ QUEUE_ENABLED: 'true' }, false, ['openwa-redis']],
    [{ CACHE_ENABLED: 'true' }, false, ['openwa-redis']],
    [{ REDIS_ENABLED: 'true' }, true, []],
    [{}, false, []],
  ] as const)(
    'reconciles selected services once for %j with an external pin %s',
    async (selection, external, expected) => {
      Object.assign(process.env, selection);
      if (external) {
        process.env.REDIS_HOST = 'cache.external.invalid';
        recordPinnedEnvKeys({ REDIS_HOST: 'cache.external.invalid' });
      }
      let reconnect: (() => void) | undefined;
      let releaseStart: (() => void) | undefined;
      const reconnecting = new Promise<void>(resolve => (reconnect = resolve));
      const starting = new Promise<void>(resolve => (releaseStart = resolve));
      const created: string[] = [];
      const daemon = {
        ping: jest
          .fn()
          .mockRejectedValueOnce(new Error('proxy not ready'))
          .mockImplementation(() => reconnecting),
        listContainers: jest.fn().mockResolvedValue([]),
        getImage: () => ({ inspect: () => Promise.resolve({}) }),
        modem: {},
        createVolume: jest.fn().mockResolvedValue({}),
        createContainer: jest.fn((config: { name: string }) => {
          created.push(config.name);
          return Promise.resolve({ start: () => starting });
        }),
      };
      DockerMock.mockImplementation(() => daemon);
      const service = new DockerService();
      await service.onModuleInit();
      for (let i = 0; i < 10; i++) service.isDockerAvailable();
      expect(DockerMock).toHaveBeenCalledTimes(2);
      reconnect!();
      await jest.advanceTimersByTimeAsync(1);
      expect(created).toEqual(expected);
      for (let i = 0; i < 10; i++) service.isDockerAvailable();
      expect(created).toEqual(expected);
      expect(DockerMock).toHaveBeenCalledTimes(2);
      releaseStart!();
      await jest.advanceTimersByTimeAsync(1);
      expect(created).toEqual(expected);
    },
  );

  it('recovers a previously reachable local socket after its inventory fails', async () => {
    delete process.env.DOCKER_HOST;
    process.env.POSTGRES_BUILTIN = 'false';
    process.env.REDIS_BUILTIN = 'false';
    process.env.MINIO_BUILTIN = 'false';
    const daemon = {
      ping: jest.fn().mockResolvedValue(undefined),
      listContainers: jest.fn().mockRejectedValueOnce(new Error('daemon restarted')).mockResolvedValue([]),
    };
    DockerMock.mockImplementation(() => daemon);
    const service = new DockerService();
    await service.onModuleInit();
    await expect(service.listContainers()).resolves.toBeNull();
    expect(service.isDockerAvailable()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(service.isDockerAvailable()).toBe(true);
    await expect(service.listContainers()).resolves.toEqual([]);
  });
});

describe('DockerService image inspection failures', () => {
  function serviceFor(docker: unknown): DockerService {
    const service = new DockerService();
    service.callTimeoutMs = 40;
    Object.assign(service as unknown as Record<string, unknown>, { docker, isAvailable: true });
    jest.spyOn(service, 'getContainerByService').mockResolvedValue(null);
    return service;
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts the real Dockerode image request without starting a pull after its deadline', async () => {
    const RealDocker = jest.requireActual<typeof import('dockerode')>('dockerode');
    let signal: AbortSignal | undefined;
    const dial = jest.fn(
      (options: { abortSignal?: AbortSignal }, callback: (error: Error | null, value?: unknown) => void) => {
        signal = options.abortSignal;
        signal?.addEventListener('abort', () => callback(new Error('inspection aborted')), { once: true });
      },
    );
    const modem = { Promise, dial };
    const pull = jest.fn();
    const service = serviceFor({ modem, getImage: () => new RealDocker.Image(modem, 'redis:7-alpine'), pull });
    jest.useFakeTimers();
    const result = service.createService('redis');
    await jest.advanceTimersByTimeAsync(80);

    await expect(result).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(modem.dial).toBe(dial);
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([401, 500, undefined])('does not pull after an inspection error with status %s', async statusCode => {
    const pull = jest.fn();
    const error = Object.assign(new Error('inspection failed'), { statusCode });
    const service = serviceFor({
      modem: {},
      getImage: () => ({ inspect: () => Promise.reject(error) }),
      pull,
    });

    await expect(service.createService('redis')).resolves.toBe(false);
    expect(pull).not.toHaveBeenCalled();
  });

  it('lets a missing image finish pulling after the short inspection deadline', async () => {
    let finishPull: ((error: Error | null) => void) | undefined;
    const start = jest.fn().mockResolvedValue(undefined);
    const service = serviceFor({
      modem: { followProgress: (_stream: unknown, callback: (error: Error | null) => void) => (finishPull = callback) },
      getImage: imageNotCached,
      pull: (_image: string, callback: (error: Error | null, stream: unknown) => void) => callback(null, {}),
      createVolume: jest.fn().mockResolvedValue({}),
      createContainer: jest.fn().mockResolvedValue({ start }),
    });
    jest.useFakeTimers();
    let finished = false;
    const result = service.createService('redis').then(value => {
      finished = true;
      return value;
    });
    await jest.advanceTimersByTimeAsync(160);
    expect(finished).toBe(false);
    expect(finishPull).toBeDefined();
    finishPull!(null);
    await expect(result).resolves.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('DockerService existing container inspection deadlines', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['create', 'start', 'stop'] as const)(
    'aborts a stalled inspection before %s mutates a container',
    async operation => {
      const service = new DockerService();
      service.callTimeoutMs = 40;
      Object.assign(service as unknown as Record<string, unknown>, { docker: {}, isAvailable: true });
      let signal: AbortSignal | undefined;
      const container = {
        inspect: jest.fn(
          (options?: Docker.ContainerInspectOptions) =>
            new Promise<never>((_resolve, reject) => {
              signal = options?.abortSignal;
              signal?.addEventListener('abort', () => reject(new Error('inspection aborted')), { once: true });
            }),
        ),
        start: jest.fn(),
        stop: jest.fn(),
      };
      jest.spyOn(service, 'getContainerByService').mockResolvedValue(container as never);
      jest.useFakeTimers();
      let settled: boolean | undefined;
      const action =
        operation === 'create'
          ? service.createService('redis')
          : operation === 'start'
            ? service.startService('cache')
            : service.stopService('cache');
      const work = action.then(value => {
        settled = value;
        return value;
      });
      await jest.advanceTimersByTimeAsync(80);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(true);
      expect(container.inspect).toHaveBeenCalledTimes(1);
      expect(container.start).not.toHaveBeenCalled();
      expect(container.stop).not.toHaveBeenCalled();
      await expect(work).resolves.toBe(false);
    },
  );
});
