import { DockerService } from './docker.service';

// Prevent actual Docker connections.
jest.mock('dockerode');

/**
 * A stop is reported as done only when the container is known to be stopped or absent. A container list that
 * fails, never answers, or cannot be asked at all says nothing about the container, so the stop must not read
 * it as "already gone": the restart would list a still-running datastore as stopped.
 */
describe('DockerService.stopManagedService when the container lookup is not answered', () => {
  const container = {
    inspect: jest.fn().mockResolvedValue({ State: { Running: true } }),
    stop: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn(),
  };

  function serviceWith(docker: unknown, isAvailable = true): DockerService {
    const service = new DockerService();
    Object.assign(service as unknown as Record<string, unknown>, { docker, isAvailable });
    return service;
  }

  afterEach(() => jest.clearAllMocks());

  it('does not report a stop when Docker failed to list the containers', async () => {
    const listContainers = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const service = serviceWith({ listContainers, getContainer: jest.fn(() => container) });

    await expect(service.stopManagedService('minio')).resolves.toBe(false);

    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(container.inspect).not.toHaveBeenCalled();
    expect(container.stop).not.toHaveBeenCalled();
  });

  it('does not report a stop when only the exact-name list failed', async () => {
    const listContainers = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('socket hang up'));
    const service = serviceWith({ listContainers, getContainer: jest.fn(() => container) });

    await expect(service.stopManagedService('redis')).resolves.toBe(false);

    expect(listContainers).toHaveBeenCalledTimes(2);
    expect(container.stop).not.toHaveBeenCalled();
  });

  it('does not report a stop when the container list does not answer in time', async () => {
    const listContainers = jest.fn(() => new Promise<never>(() => undefined));
    const service = serviceWith({ listContainers, getContainer: jest.fn(() => container) });
    service.callTimeoutMs = 20;

    await expect(service.stopManagedService('postgres')).resolves.toBe(false);

    expect(container.stop).not.toHaveBeenCalled();
  });

  it('does not report a stop when Docker cannot be asked', async () => {
    await expect(new DockerService().stopManagedService('postgres')).resolves.toBe(false);
    await expect(serviceWith({}, false).stopManagedService('postgres')).resolves.toBe(false);
  });

  it('still reports a stop for a container Docker says does not exist', async () => {
    const listContainers = jest.fn().mockResolvedValue([]);
    const getContainer = jest.fn();
    const service = serviceWith({ listContainers, getContainer });

    await expect(service.stopManagedService('minio')).resolves.toBe(true);

    expect(listContainers).toHaveBeenCalledTimes(2);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('stops the running container Docker lists for the service, and never removes it', async () => {
    const listContainers = jest.fn().mockResolvedValue([{ Id: 'abc' }]);
    const getContainer = jest.fn(() => container);
    const service = serviceWith({ listContainers, getContainer });

    await expect(service.stopManagedService('postgres')).resolves.toBe(true);

    expect(getContainer).toHaveBeenCalledWith('abc');
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).not.toHaveBeenCalled();
  });
});
