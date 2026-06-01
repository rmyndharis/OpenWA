import { ConfigService } from '@nestjs/config';
import { RedisIoAdapter } from './redis-io.adapter';

const duplicate = jest.fn();
const onSpy = jest.fn();

jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    duplicate,
    on: onSpy,
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
  })),
}));

const createAdapterMock = jest.fn().mockReturnValue('adapter-factory');
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: (...args: unknown[]) => createAdapterMock(...args),
}));

// IoAdapter's constructor reaches into the Nest app; a bare object is enough
// for these unit tests since we never start a real HTTP server.
const fakeApp = {} as never;

describe('RedisIoAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    duplicate.mockReturnValue({
      on: onSpy,
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
    });
  });

  const config = {
    get: (key: string, def?: unknown) => {
      const values: Record<string, unknown> = {
        'redis.host': 'redis-host',
        'redis.port': 6380,
      };
      return values[key] ?? def;
    },
  } as unknown as ConfigService;

  it('builds the adapter factory from a pub/sub client pair', async () => {
    const adapter = new RedisIoAdapter(fakeApp);
    await adapter.connectToRedis(config);

    // pub client + its duplicate (sub) — two distinct connections.
    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(createAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('applies the Redis adapter to the server once connected', async () => {
    const adapter = new RedisIoAdapter(fakeApp);
    const server = { adapter: jest.fn() };
    jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(adapter)), 'createIOServer').mockReturnValue(server);

    await adapter.connectToRedis(config);
    adapter.createIOServer(3000);

    expect(server.adapter).toHaveBeenCalledWith('adapter-factory');
  });

  it('does not touch the adapter when Redis is not connected', () => {
    const adapter = new RedisIoAdapter(fakeApp);
    const server = { adapter: jest.fn() };
    jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(adapter)), 'createIOServer').mockReturnValue(server);

    adapter.createIOServer(3000);

    expect(server.adapter).not.toHaveBeenCalled();
  });
});
