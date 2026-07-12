import { RedisThrottlerStorage } from './redis-throttler.storage';
import type { Redis } from 'ioredis';

type MockRedis = { incr: jest.Mock; pexpire: jest.Mock; pttl: jest.Mock };

const makeRedis = (opts: { hits: number; ttlMs: number }): MockRedis => ({
  incr: jest.fn().mockResolvedValue(opts.hits),
  pexpire: jest.fn().mockResolvedValue(1),
  pttl: jest.fn().mockResolvedValue(opts.ttlMs),
});

describe('RedisThrottlerStorage', () => {
  it('first hit (incr=1): sets the TTL once, reports totalHits + remaining time in seconds, not blocked', async () => {
    const redis = makeRedis({ hits: 1, ttlMs: 1500 });
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment(
      '1.2.3.4',
      1000,
      10,
      60000,
      'short',
    );
    expect(redis.incr).toHaveBeenCalledWith('openwa:throttle:short:1.2.3.4');
    expect(redis.pexpire).toHaveBeenCalledWith('openwa:throttle:short:1.2.3.4', 1000);
    expect(rec).toEqual({ totalHits: 1, timeToExpire: 2, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('subsequent hit (incr>1) does NOT re-set the TTL (inherits the window from the first hit)', async () => {
    const redis = makeRedis({ hits: 3, ttlMs: 800 });
    await new RedisThrottlerStorage(redis as unknown as Redis).increment('k', 1000, 10, 60000, 'short');
    expect(redis.pexpire).not.toHaveBeenCalled();
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
    redis.incr.mockRejectedValue(new Error('ECONNREFUSED'));
    const rec = await new RedisThrottlerStorage(redis as unknown as Redis).increment('k', 1000, 10, 60000, 'short');
    expect(rec).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
  });
});
