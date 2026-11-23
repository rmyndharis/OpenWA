import { RedisThrottlerStorage, THROTTLER_REDIS_QUIT_TIMEOUT_MS } from './redis-throttler.storage';
import type { Redis } from 'ioredis';
import { LoggerService } from '../services/logger.service';

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

  // The block is the counter itself, so it lifts when the window key expires, not after blockDuration:
  // advertising blockDuration made a client that honours Retry-After wait up to an hour for nothing.
  it('over the limit (incr>limit) is blocked until the window expires, in seconds', async () => {
    const redis = makeRedis({ hits: 1001, ttlMs: 4200 });
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment(
      'k',
      3600000,
      1000,
      3600000,
      'long',
    );
    expect(rec.isBlocked).toBe(true);
    expect(rec.totalHits).toBe(1001);
    expect(rec.timeToBlockExpire).toBe(5); // ceil(4200ms / 1000), not the 3600 s blockDuration
  });

  it('never advertises a zero Retry-After on a blocked request', async () => {
    const redis = makeRedis({ hits: 11, ttlMs: 0 });
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment('k', 1000, 10, 60000, 'short');
    expect(rec.isBlocked).toBe(true);
    expect(rec.timeToBlockExpire).toBe(1);
  });

  it('falls back to bounded per-process rate limiting when Redis errors', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);

    const first = await storage.increment('k', 5000, 2, 60000, 'short');
    const second = await storage.increment('k', 5000, 2, 60000, 'short');
    const third = await storage.increment('k', 5000, 2, 60000, 'short');

    expect(first).toEqual({ totalHits: 1, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });
    expect(second).toEqual({ totalHits: 2, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });
    expect(third.totalHits).toBe(3);
    expect(third.isBlocked).toBe(true);
    expect(third.timeToBlockExpire).toBeGreaterThanOrEqual(1);
    await storage.onModuleDestroy();
  });

  it('falls back FAST when the client rejects while disconnected (no queue/timeout stall)', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1000 });
    // The exact rejection ioredis produces with enableOfflineQueue:false: issued commands must not
    // wait for reconnect; the request is decided on the local fallback path immediately.
    redis.eval.mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);
    const result = await Promise.race([
      storage.increment('k', 1000, 10, 60000, 'short'),
      new Promise<'slow'>(resolve => setTimeout(() => resolve('slow'), 100)),
    ]);
    expect(result).toEqual({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 });
    await storage.onModuleDestroy();
  });

  it('resets local fallback window after ttl expires and bounds distinct keys with LRU eviction', async () => {
    jest.useFakeTimers();
    try {
      const redis = makeRedis({ hits: 1, ttlMs: 1000 });
      redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
      const storage = new RedisThrottlerStorage(redis as unknown as Redis);

      expect((await storage.increment('abuser', 2000, 1, 60000, 'short')).isBlocked).toBe(false);
      expect((await storage.increment('abuser', 2000, 1, 60000, 'short')).isBlocked).toBe(true);

      // Flood with more distinct keys than the cap; touching 'abuser' keeps it blocked while old keys evict.
      for (let i = 0; i < 50_005; i++) {
        if (i === 25_000) {
          expect((await storage.increment('abuser', 2000, 1, 60000, 'short')).isBlocked).toBe(true);
        }
        await storage.increment(`flood-${i}`, 2000, 10, 60000, 'short');
      }
      expect((await storage.increment('abuser', 2000, 1, 60000, 'short')).isBlocked).toBe(true);
      const mapSize = (storage as unknown as { localFallback: Map<string, unknown> }).localFallback.size;
      expect(mapSize).toBeLessThanOrEqual(50_000);

      jest.advanceTimersByTime(2001);
      const afterWindow = await storage.increment('abuser', 2000, 1, 60000, 'short');
      expect(afterWindow).toEqual({ totalHits: 1, timeToExpire: 2, isBlocked: false, timeToBlockExpire: 0 });

      await storage.onModuleDestroy();
      expect((storage as unknown as { localFallback: Map<string, unknown> }).localFallback.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('warns once while Redis stays down, says when it answers again, and warns again on the next outage', async () => {
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    try {
      const redis = makeRedis({ hits: 1, ttlMs: 1000 });
      redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
      const storage = new RedisThrottlerStorage(redis as unknown as Redis);
      // Each guarded request checks three throttlers.
      for (let i = 0; i < 100; i++) {
        for (const name of ['short', 'medium', 'long']) {
          const rec = await storage.increment('k', 1000, 10, 60000, name);
          expect(rec.totalHits).toBe(i + 1);
          expect(rec.isBlocked).toBe(i + 1 > 10);
        }
      }
      expect(warn).toHaveBeenCalledTimes(1);

      redis.eval.mockResolvedValue([1, 1000]);
      await storage.increment('k', 1000, 10, 60000, 'short');
      await storage.increment('k', 1000, 10, 60000, 'medium');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('300');
      expect((storage as unknown as { localFallback: Map<string, unknown> }).localFallback.size).toBe(0);

      redis.eval.mockRejectedValue('socket-reset');
      await storage.increment('k', 1000, 10, 60000, 'short');
      expect(warn).toHaveBeenCalledTimes(2);
      await storage.onModuleDestroy();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
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
