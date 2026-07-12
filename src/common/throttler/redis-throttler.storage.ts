import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';
import { createLogger } from '../services/logger.service';

/** The 4-field record @nestjs/throttler's guard reads (not re-exported from the package root). */
interface ThrottlerRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed ThrottlerStorage for @nestjs/throttler v6 — persists hit counts to Redis so rate
 * limits aggregate across replicas (behind a load balancer) instead of being per-process.
 *
 * The guard sets `Retry-After: timeToBlockExpire` and `RateLimit-Reset: timeToExpire` — both HTTP
 * conventions are SECONDS — so the values here are ceil(ms / 1000), matching the default in-memory
 * storage. Fail-OPEN on Redis error: rate limiting is a secondary control, and fail-closed would
 * self-DoS the gateway (every request 500s on the storage call).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = createLogger('RedisThrottlerStorage');

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    const redisKey = `openwa:throttle:${throttlerName}:${key}`;
    try {
      const hits = await this.redis.incr(redisKey);
      if (hits === 1) {
        // First hit in the window sets the TTL; subsequent hits inherit it (fixed window from first hit).
        await this.redis.pexpire(redisKey, ttl);
      }
      const ttlMs = await this.redis.pttl(redisKey);
      const isBlocked = hits > limit;
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(ttlMs / 1000),
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
