import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createLogger } from '../services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { redisConnectionOptions } from '../../config/redis-options';

/** Max time to await a cache command or release a socket that stops responding. */
const CACHE_COMMAND_TIMEOUT_MS = 2000;

/** Max time to await a graceful `redis.quit()` on shutdown before force-disconnecting (see onModuleDestroy). */
export const CACHE_QUIT_TIMEOUT_MS = 2000;

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = createLogger('CacheService');
  private redis: Redis | null = null;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    // Check REDIS_ENABLED env var directly (from saved .env.generated)
    // Fallback to config 'cache.enabled' for backward compatibility
    this.enabled = process.env.REDIS_ENABLED === 'true' || configService.get<boolean>('cache.enabled', false);

    this.logger.log(`CacheService: enabled=${this.enabled}, REDIS_ENABLED=${process.env.REDIS_ENABLED}`);

    // Don't connect immediately - the client is created lazily on first use via isAvailable(), so a
    // Redis container that is not ready at boot doesn't fail startup.
  }

  /**
   * Lazily create the single shared Redis client. ioredis owns all (re)connection: the retry strategy
   * never gives up, so the client heals itself whether Redis is down at boot or restarts later — it is
   * created once here and only torn down on shutdown (onModuleDestroy). The previous manual
   * connect/attempt-count logic gave up permanently after a fixed number of failures and never cleared
   * a dead client, so a Redis restart left the cache dead until the whole app was restarted.
   */
  private ensureClient(): void {
    if (this.redis) return;

    const connection = redisConnectionOptions();
    this.logger.log(`Connecting to Redis at ${connection.host}:${connection.port}`);

    const redis = new Redis({
      ...connection,
      db: resolveNonNegativeIntEnv(process.env.REDIS_CACHE_DB, 1),
      lazyConnect: true,
      // Cache is best-effort: a command issued while disconnected fails fast (the caller falls back to
      // the source of truth) instead of being queued and stalling the request until reconnect.
      enableOfflineQueue: false,
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
      // Release unanswered commands as well as their callers, then let the client reconnect.
      socketTimeout: CACHE_COMMAND_TIMEOUT_MS,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 3,
      // Reconnect forever with bounded backoff. Returning null (the previous behavior after 3 tries)
      // makes ioredis abandon reconnection permanently, which is exactly what left the cache dead
      // across a Redis restart.
      retryStrategy: times => Math.min(times * 500, 5000),
    });

    redis.on('error', err => {
      this.logger.warn(`Redis error: ${err.message}`);
    });

    redis.on('connect', () => {
      this.logger.log('Redis cache connected');
    });

    this.redis = redis;

    // Kick off the initial connection but don't await it — ioredis keeps retrying per retryStrategy on
    // failure, and isAvailable()'s ping reflects the live state, so a down-at-boot Redis never blocks a
    // caller. The first isAvailable() while still connecting reports false; the next one, once ready,
    // reports true.
    redis.connect().catch(() => undefined);
  }

  private async ping(): Promise<boolean> {
    if (!this.redis) return false;
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      this.logger.debug(`Redis ping failed: ${String(error)}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    const redis = this.redis;

    // Bound the teardown: redis.quit() waits for the QUIT reply, which never arrives on a half-open /
    // partitioned socket — leaving app.close() blocked until the orchestrator SIGKILLs the process.
    // Race a graceful QUIT against a short deadline so shutdown always proceeds.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, CACHE_QUIT_TIMEOUT_MS);
      timer.unref();
    });

    try {
      await Promise.race([redis.quit().catch(() => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      // Always release the socket. With the never-give-up retryStrategy, a Redis that is down at
      // shutdown leaves the client stuck 'reconnecting', and (enableOfflineQueue:false) quit() rejects
      // instantly WITHOUT closing it — so ioredis's reconnect timer would outlive teardown. disconnect()
      // is idempotent, so calling it after a clean quit is harmless; this guarantees no live handle
      // survives onModuleDestroy regardless of connection state, rather than relying on process.exit to
      // reap it.
      redis.disconnect();
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.enabled) return false;

    // Create the client on first use, then let ioredis manage (re)connection. A ping reflects whether
    // the connection is live right now — false during an outage (caller bypasses to the DB), true again
    // once ioredis has reconnected.
    this.ensureClient();
    return this.ping();
  }
}
