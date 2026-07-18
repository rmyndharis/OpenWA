import { RedisThrottlerStorage } from './redis-throttler.storage';
import type { Redis } from 'ioredis';

type MockRedis = { eval: jest.Mock };

const makeRedis = (opts: { hits: number; ttlMs: number }): MockRedis => ({
  eval: jest.fn().mockResolvedValue([opts.hits, opts.ttlMs]),
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
});
