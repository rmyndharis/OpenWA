import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';
import { createLogger } from '../services/logger.service';

/** Max time to await a graceful `redis.quit()` on shutdown before force-disconnecting (see onModuleDestroy). */
export const THROTTLER_REDIS_QUIT_TIMEOUT_MS = 2000;

/** The 4-field record @nestjs/throttler's guard reads (not re-exported from the package root). */
interface ThrottlerRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

// Increment, arm (or repair) the fixed-window TTL, and read it in one Redis operation. Re-arming
// PTTL<0 also heals counters stranded by older non-atomic implementations.
const INCREMENT_WITH_TTL_LUA = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = redis.call('PTTL', KEYS[1])
elseif ttl < 0 then
  -- A TTL-less key can only be legacy/corrupt state. Treat its accumulated count as void so an old
  -- stranded over-limit value cannot impose a fresh full-window block when it is repaired.
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
  hits = 1
  ttl = redis.call('PTTL', KEYS[1])
end
return {hits, ttl}
`;

/**
 * Redis-backed ThrottlerStorage for @nestjs/throttler v6 — persists hit counts to Redis so rate
 * limits aggregate across replicas (behind a load balancer) instead of being per-process.
 *
 * The guard sets `Retry-After: timeToBlockExpire` and `RateLimit-Reset: timeToExpire` — both HTTP
 * conventions are SECONDS — so the values here are ceil(ms / 1000), matching the default in-memory
 * storage. Fail-OPEN on Redis error: rate limiting is a secondary control, and fail-closed would
 * self-DoS the gateway (every request 500s on the storage call).
 *
 * This class owns the client lifecycle: it is registered as the `ThrottlerStorage` provider by
 * @nestjs/throttler (its ThrottlerStorageProvider returns the configured instance), so Nest invokes
 * onModuleDestroy on it at shutdown.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = createLogger('RedisThrottlerStorage');

  constructor(private readonly redis: Redis) {
    // An ioredis client with no 'error' listener reports every connection failure via an unstructured
    // console dump; log it through the structured logger instead. Never rethrow — the client keeps
    // reconnecting in the background and increment() already fails open per request.
    this.redis.on('error', (error: Error) => {
      this.logger.warn('Throttler Redis client error', { error: error.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    const redis = this.redis;

    // Bound the teardown: redis.quit() waits for the QUIT reply, which never arrives on a half-open /
    // partitioned socket — leaving app.close() blocked until the orchestrator SIGKILLs the process.
    // Race a graceful QUIT (drain, not a hard cut) against a short deadline so shutdown proceeds.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, THROTTLER_REDIS_QUIT_TIMEOUT_MS);
      timer.unref();
    });

    try {
      await Promise.race([redis.quit().catch(() => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      // Always release the socket. With enableOfflineQueue:false and the client mid-reconnect, quit()
      // rejects instantly WITHOUT closing it — so ioredis's reconnect timer would outlive teardown.
      // disconnect() is idempotent, so calling it after a clean quit is harmless; this guarantees no
      // live handle survives onModuleDestroy regardless of connection state.
      redis.disconnect();
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    const redisKey = `openwa:throttle:${throttlerName}:${key}`;
    try {
      const [hits, ttlMs] = (await this.redis.eval(INCREMENT_WITH_TTL_LUA, 1, redisKey, String(ttl))) as [
        number,
        number,
      ];
      const isBlocked = hits > limit;
      return {
        totalHits: hits,
        timeToExpire: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0,
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
      };
    } catch (error) {
      this.logger.warn('Redis throttler storage failed; failing OPEN (allowing)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
