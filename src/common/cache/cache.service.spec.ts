import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CacheService, CACHE_QUIT_TIMEOUT_MS } from './cache.service';

// Auto-mock ioredis so no real socket is opened. The onModuleDestroy suite below injects its own fake
// `redis` and never constructs one, so the mock is inert there; the resilience suite drives it.
jest.mock('ioredis');

describe('CacheService.onModuleDestroy (bounded shutdown)', () => {
  const makeService = (): CacheService => {
    const configService = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService;
    return new CacheService(configService);
  };
  const withRedis = (service: CacheService, redis: unknown): void => {
    (service as unknown as { redis: unknown }).redis = redis;
  };

  it('returns immediately when there is no redis client', async () => {
    await expect(makeService().onModuleDestroy()).resolves.toBeUndefined();
  });

  it('completes via a clean quit() without force-disconnecting', async () => {
    const service = makeService();
    const redis = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    withRedis(service, redis);

    await service.onModuleDestroy();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('force-disconnects when quit() hangs past the deadline (shutdown still completes)', async () => {
    jest.useFakeTimers();
    try {
      const service = makeService();
      const redis = { quit: jest.fn(() => new Promise<string>(() => {})), disconnect: jest.fn() }; // never resolves
      withRedis(service, redis);

      const done = service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(CACHE_QUIT_TIMEOUT_MS);
      await done;

      expect(redis.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Regression coverage for the Redis-outage recovery bug: the cache used to give up reconnecting after a
// fixed number of failures and never cleared a dead client, so a Redis restart (or a Redis that was down
// at boot and came back) left the cache permanently dead until the whole app was restarted.
describe('CacheService Redis-outage resilience', () => {
  const RedisMock = Redis as unknown as jest.Mock;

  interface FakeClient {
    connect: jest.Mock;
    ping: jest.Mock;
    on: jest.Mock;
    quit: jest.Mock;
    disconnect: jest.Mock;
  }
  const fakeClient = (ping: jest.Mock): FakeClient => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping,
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  });
  const useClient = (ping: jest.Mock): void => {
    RedisMock.mockImplementation(() => fakeClient(ping));
  };
  // enabled=true purely from config, so the suite is independent of the ambient REDIS_ENABLED env.
  const enabledConfig = (): ConfigService =>
    ({ get: (key: string, def?: unknown) => (key === 'cache.enabled' ? true : def) }) as unknown as ConfigService;

  let savedEnabled: string | undefined;
  beforeEach(() => {
    savedEnabled = process.env.REDIS_ENABLED;
    delete process.env.REDIS_ENABLED;
    RedisMock.mockReset();
  });
  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = savedEnabled;
  });

  it('self-heals across a Redis restart without recreating the client', async () => {
    const ping = jest
      .fn()
      .mockResolvedValueOnce('PONG') // connected
      .mockRejectedValueOnce(new Error('connection lost')) // Redis down
      .mockResolvedValueOnce('PONG'); // ioredis reconnected
    useClient(ping);
    const service = new CacheService(enabledConfig());

    expect(await service.isAvailable()).toBe(true);
    expect(await service.isAvailable()).toBe(false); // during the outage
    expect(await service.isAvailable()).toBe(true); // healed

    // One client for the whole lifetime — it is never torn down and recreated on the outage.
    expect(RedisMock).toHaveBeenCalledTimes(1);
  });

  it('never permanently gives up: recovers even after many boot-time failures', async () => {
    const ping = jest.fn();
    for (let i = 0; i < 8; i++) ping.mockRejectedValueOnce(new Error('down')); // 8 > the old hard cap of 5
    ping.mockResolvedValue('PONG'); // Redis finally reachable
    useClient(ping);
    const service = new CacheService(enabledConfig());

    for (let i = 0; i < 8; i++) expect(await service.isAvailable()).toBe(false);
    expect(await service.isAvailable()).toBe(true);

    expect(RedisMock).toHaveBeenCalledTimes(1);
  });

  it('configures ioredis to reconnect forever and fail fast while disconnected', async () => {
    useClient(jest.fn().mockResolvedValue('PONG'));
    const service = new CacheService(enabledConfig());
    await service.isAvailable();

    const opts = (
      RedisMock.mock.calls as Array<[{ retryStrategy: (t: number) => number | null; enableOfflineQueue: boolean }]>
    )[0][0];
    // Never returns null → ioredis keeps reconnecting for any attempt count, small or large.
    expect(opts.retryStrategy(1)).not.toBeNull();
    expect(typeof opts.retryStrategy(1000)).toBe('number');
    // Commands fail fast instead of queueing until reconnect.
    expect(opts.enableOfflineQueue).toBe(false);
  });

  it('does not construct a client when the cache is disabled', async () => {
    const disabled = { get: (_key: string, def?: unknown) => def } as unknown as ConfigService;
    const service = new CacheService(disabled);

    expect(await service.isAvailable()).toBe(false);
    expect(RedisMock).not.toHaveBeenCalled();
  });
});
