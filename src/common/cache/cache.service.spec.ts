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

  it('prefers a graceful quit() but always releases the socket afterward', async () => {
    const service = makeService();
    const redis = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    withRedis(service, redis);

    await service.onModuleDestroy();

    // A clean quit() is used, and disconnect() still runs as the guaranteed final release — a
    // never-ready client (down Redis + never-give-up retryStrategy) would otherwise leak a live
    // reconnect timer past teardown. disconnect() is idempotent, so this is safe after a clean quit.
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
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

  it('releases a never-ready client whose quit() rejects fast (no leaked reconnect timer)', async () => {
    const service = makeService();
    // A down/reconnecting client with enableOfflineQueue:false rejects quit() immediately WITHOUT
    // closing the socket; onModuleDestroy must still disconnect() it so ioredis's forever-retry timer
    // does not outlive teardown.
    const redis = { quit: jest.fn().mockRejectedValue(new Error("Stream isn't writeable")), disconnect: jest.fn() };
    withRedis(service, redis);

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});

// Redis-outage recovery. The old cache gave up reconnecting after a fixed number of failures and never
// cleared a dead client, so a restart (or a Redis down at boot) left the cache dead until the app
// restarted. The client mock here always resolves connect(), so these first tests pin the NEW contract
// — one client for the process lifetime, isAvailable() tracking live ping state and never latching off —
// rather than the old-vs-new difference itself. That difference lives entirely in the ioredis options
// (retryStrategy never null + enableOfflineQueue:false), which the 'configures ioredis…' test below
// asserts directly; it is the one test that fails against the pre-fix code.
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

  it('never latches off: keeps reflecting live state and recovers after a long run of failures', async () => {
    const ping = jest.fn();
    // Many consecutive unavailable polls (more than the old code's 5-attempt give-up cap) must not make
    // isAvailable() stick at false — the single client keeps being re-pinged, never abandoned.
    for (let i = 0; i < 8; i++) ping.mockRejectedValueOnce(new Error('down'));
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
