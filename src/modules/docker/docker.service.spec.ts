import { DockerService } from './docker.service';

// Prevent actual Docker connections on module init during tests
jest.mock('dockerode');

describe('DockerService.getRunningBuiltinServices', () => {
  const container = (name: string, service: string, state: string) => ({
    id: name,
    name,
    state,
    status: state,
    labels: { 'com.openwa.service': service, 'com.openwa.builtin': 'true' },
  });

  it('reports a service built-in only when its labeled container is actually running', async () => {
    const service = new DockerService();
    jest
      .spyOn(service, 'listContainers')
      .mockResolvedValue([
        container('openwa-postgres', 'database', 'running'),
        container('openwa-redis', 'cache', 'exited'),
      ]);

    expect(await service.getRunningBuiltinServices()).toEqual({ database: true, cache: false, storage: false });
  });

  it('reports all false when no bundled containers are present (e.g. Docker unavailable)', async () => {
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
  // Teardown is deliberately stop-only: the pinned docker-socket-proxy v0.4.2 never reads its
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
