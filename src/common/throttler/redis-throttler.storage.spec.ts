import { RedisThrottlerStorage, THROTTLER_REDIS_QUIT_TIMEOUT_MS } from './redis-throttler.storage';
import type { Redis } from 'ioredis';

type MockRedis = { eval: jest.Mock; on: jest.Mock; quit: jest.Mock; disconnect: jest.Mock };

const makeRedis = (opts: { hits: number; ttlMs: number }): MockRedis => ({
  eval: jest.fn().mockResolvedValue([opts.hits, opts.ttlMs]),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  disconnect: jest.fn(),
});

describe('RedisThrottlerStorage', () => {
  it('atomically increments, arms/repairs the TTL, and reports remaining seconds', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1500 });
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment(
      '1.2.3.4',
      1000,
      10,
      60000,
      'short',
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      'openwa:throttle:short:1.2.3.4',
      '1000',
    );
    expect(rec).toEqual({ totalHits: 1, timeToExpire: 2, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('treats a repaired legacy TTL-less counter as a fresh first hit', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment('k', 1000, 10, 60000, 'short');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[1], 1, 'PX'"),
      1,
      expect.any(String),
      '1000',
    );
    expect(rec).toEqual({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('over the limit (incr>limit) is blocked with blockDuration in seconds', async () => {
    const redis = makeRedis({ hits: 11, ttlMs: 500 });
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment('k', 1000, 10, 60000, 'short');
    expect(rec.isBlocked).toBe(true);
    expect(rec.totalHits).toBe(11);
    expect(rec.timeToBlockExpire).toBe(60); // 60000ms / 1000
  });

  it('fails OPEN on a Redis error (returns a non-blocking record so the limiter never self-DoSes)', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment('k', 1000, 10, 60000, 'short');
    expect(rec).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('fails open FAST when the client rejects while disconnected (no queue/timeout stall)', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    // The exact rejection ioredis produces with enableOfflineQueue:false — issued commands must not
    // wait for reconnect; the request is decided on the fail-open path immediately.
    redis.eval.mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);
    const result = await Promise.race([
      storage.increment('k', 1000, 10, 60000, 'short'),
      new Promise<'slow'>(resolve => setTimeout(() => resolve('slow'), 100)),
    ]);
    expect(result).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('attaches an error listener so connection failures surface as structured logs, never unhandled events', () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    new RedisThrottlerStorage(redis as unknown as Redis);
    expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
    const calls = redis.on.mock.calls as Array<[string, (error: Error) => void]>;
    const errorCall = calls.find(([event]) => event === 'error');
    expect(errorCall).toBeDefined();
    const listener = errorCall![1];
    expect(() => listener(new Error('ECONNREFUSED'))).not.toThrow();
  });

  it('onModuleDestroy drains the client with quit() and always disconnects the socket', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    await new RedisThrottlerStorage(redis as unknown as Redis).onModuleDestroy();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy still disconnects when quit() rejects (client already offline)', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    // With enableOfflineQueue:false a quit() issued mid-outage rejects instantly WITHOUT closing the
    // socket — teardown must not propagate that rejection nor skip the disconnect.
    redis.quit.mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);
    await expect(storage.onModuleDestroy()).resolves.toBeUndefined();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy does not hang when quit() never settles (deadline, then force disconnect)', async () => {
    jest.useFakeTimers();
    try {
      const redis = makeRedis({ hits: 1, ttlMs: 1000 });
      redis.quit.mockReturnValue(new Promise(() => undefined)); // half-open socket: QUIT never answered
      const storage = new RedisThrottlerStorage(redis as unknown as Redis);
      const destroy = storage.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(THROTTLER_REDIS_QUIT_TIMEOUT_MS);
      await destroy;
      expect(redis.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
