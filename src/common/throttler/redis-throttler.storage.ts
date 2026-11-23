import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';
import { createLogger } from '../services/logger.service';

/** Max time to await a graceful `redis.quit()` on shutdown before force-disconnecting (see onModuleDestroy). */
export const THROTTLER_REDIS_QUIT_TIMEOUT_MS = 2000;

/** Cap on distinct keys retained in the per-process fallback map during a Redis outage. */
const MAX_FALLBACK_KEYS = 50_000;

interface LocalFallbackEntry {
  hits: number;
  expiresAt: number;
}

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
 * storage. Unlike that storage there is no separate block key: the over-limit counter IS the block,
 * so it lifts when the window expires and Retry-After advertises that, not blockDuration.
 * Fail-safe fallback on Redis error: rate limiting is a secondary control, and fail-closed would
 * self-DoS the gateway (every request 500s on the storage call), while returning zero hits would
 * disable throttling on @Public routes during an outage. Delegate to a bounded per-process window
 * instead and clear it once Redis answers again or on shutdown.
 *
 * This class owns the client lifecycle: it is registered as the `ThrottlerStorage` provider by
 * @nestjs/throttler (its ThrottlerStorageProvider returns the configured instance), so Nest invokes
 * onModuleDestroy on it at shutdown.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = createLogger('RedisThrottlerStorage');

  /** Checks that fell back to local storage since Redis last answered: only the first one of an outage is logged. */
  private failedOpen = 0;

  /** Bounded per-process fixed-window counters used while Redis is unreachable. */
  private readonly localFallback = new Map<string, LocalFallbackEntry>();

  constructor(private readonly redis: Redis) {
    // An ioredis client with no 'error' listener reports every connection failure via an unstructured
    // console dump; log it through the structured logger instead. Never rethrow — the client keeps
    // reconnecting in the background and increment() falls back locally per request.
    this.redis.on('error', (error: Error) => {
      this.logger.warn('Throttler Redis client error', { error: error.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.localFallback.clear();
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

  private incrementLocalFallback(redisKey: string, ttl: number, limit: number): ThrottlerRecord {
    const now = Date.now();
    const existing = this.localFallback.get(redisKey);
    const entry: LocalFallbackEntry =
      !existing || existing.expiresAt <= now
        ? { hits: 1, expiresAt: now + ttl }
        : { hits: existing.hits + 1, expiresAt: existing.expiresAt };

    // Touch on every check so active subjects stay hot while stale entries evict first.
    this.localFallback.delete(redisKey);
    this.localFallback.set(redisKey, entry);
    while (this.localFallback.size > MAX_FALLBACK_KEYS) {
      const oldest = this.localFallback.keys().next().value;
      if (oldest !== undefined) this.localFallback.delete(oldest);
    }

    const remainingMs = Math.max(0, entry.expiresAt - now);
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const isBlocked = entry.hits > limit;
    return {
      totalHits: entry.hits,
      timeToExpire: remainingSeconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.max(1, remainingSeconds) : 0,
    };
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
      if (this.failedOpen > 0) {
        this.logger.log(`Redis throttler storage answered again after ${this.failedOpen} fallback checks`);
        this.failedOpen = 0;
        this.localFallback.clear();
      }
      const isBlocked = hits > limit;
      return {
        totalHits: hits,
        timeToExpire: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0,
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.max(1, Math.ceil(ttlMs / 1000)) : 0,
      };
    } catch (error) {
      // Every guarded request checks three throttlers, so a line per failure flooded the log for a whole outage.
      if (this.failedOpen++ === 0) {
        this.logger.warn(
          'Redis throttler storage failed; falling back to per-process rate limiting until it answers again',
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.incrementLocalFallback(redisKey, ttl, limit);
    }
  }
}
