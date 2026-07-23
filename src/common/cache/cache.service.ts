import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createLogger } from '../services/logger.service';

export interface SessionInfo {
  id: string;
  name: string;
  status: string;
  phone?: string;
  pushName?: string;
  connectedAt?: string;
}

export interface SessionStats {
  active: number;
  total: number;
  byStatus: Record<string, number>;
}

// TTL constants in seconds
const TTL = {
  SESSION_STATUS: 300, // 5 min
  SESSION_INFO: 600, // 10 min
  SESSION_QR: 60, // 1 min
  SESSIONS_LIST: 30, // 30 sec
  SESSIONS_STATS: 15, // 15 sec
};

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

    const host = process.env.REDIS_HOST || this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = parseInt(process.env.REDIS_PORT || '', 10) || this.configService.get<number>('REDIS_PORT', 6379);

    this.logger.log(`Connecting to Redis at ${host}:${port}`);

    const redis = new Redis({
      host,
      port,
      username: this.configService.get<string>('REDIS_USERNAME'),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      db: this.configService.get<number>('REDIS_CACHE_DB', 1),
      lazyConnect: true,
      // Cache is best-effort: a command issued while disconnected fails fast (the caller falls back to
      // the source of truth) instead of being queued and stalling the request until reconnect.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      connectTimeout: this.configService.get<number>('redis.connectTimeoutMs', 5000),
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
    // Force-disconnect after a short deadline so shutdown always completes.
    let timer: NodeJS.Timeout | undefined;
    const forceDisconnect = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        redis.disconnect();
        resolve();
      }, CACHE_QUIT_TIMEOUT_MS);
      timer.unref();
    });

    try {
      await Promise.race([redis.quit().catch(() => undefined), forceDisconnect]);
    } finally {
      if (timer) clearTimeout(timer);
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

  // ========== Session Status ==========

  async getSessionStatus(id: string): Promise<string | null> {
    if (!(await this.isAvailable())) return null;
    try {
      return await this.redis!.get(`session:${id}:status`);
    } catch (error) {
      this.logger.warn(`Cache read failed (session:status): ${String(error)}`);
      return null;
    }
  }

  async setSessionStatus(id: string, status: string): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      await this.redis!.setex(`session:${id}:status`, TTL.SESSION_STATUS, status);
    } catch (error) {
      this.logger.warn(`Cache write failed (session:status): ${String(error)}`);
    }
  }

  // ========== Session Info ==========

  async getSessionInfo(id: string): Promise<SessionInfo | null> {
    if (!(await this.isAvailable())) return null;
    try {
      const data = await this.redis!.get(`session:${id}:info`);
      return data ? (JSON.parse(data) as SessionInfo) : null;
    } catch (error) {
      this.logger.warn(`Cache read failed (session:info): ${String(error)}`);
      return null;
    }
  }

  async setSessionInfo(id: string, info: SessionInfo): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      await this.redis!.setex(`session:${id}:info`, TTL.SESSION_INFO, JSON.stringify(info));
    } catch (error) {
      this.logger.warn(`Cache write failed (session:info): ${String(error)}`);
    }
  }

  // ========== Session QR ==========

  async getSessionQR(id: string): Promise<string | null> {
    if (!(await this.isAvailable())) return null;
    try {
      return await this.redis!.get(`session:${id}:qr`);
    } catch (error) {
      this.logger.warn(`Cache read failed (session:qr): ${String(error)}`);
      return null;
    }
  }

  async setSessionQR(id: string, qr: string): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      await this.redis!.setex(`session:${id}:qr`, TTL.SESSION_QR, qr);
    } catch (error) {
      this.logger.warn(`Cache write failed (session:qr): ${String(error)}`);
    }
  }

  // ========== Sessions List ==========

  async getSessionsList(): Promise<string[] | null> {
    if (!(await this.isAvailable())) return null;
    try {
      const data = await this.redis!.get('sessions:list');
      return data ? (JSON.parse(data) as string[]) : null;
    } catch (error) {
      this.logger.warn(`Cache read failed (sessions:list): ${String(error)}`);
      return null;
    }
  }

  async setSessionsList(ids: string[]): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      await this.redis!.setex('sessions:list', TTL.SESSIONS_LIST, JSON.stringify(ids));
    } catch (error) {
      this.logger.warn(`Cache write failed (sessions:list): ${String(error)}`);
    }
  }

  // ========== Sessions Stats ==========

  async getSessionsStats(): Promise<SessionStats | null> {
    if (!(await this.isAvailable())) return null;
    try {
      const data = await this.redis!.get('sessions:stats');
      return data ? (JSON.parse(data) as SessionStats) : null;
    } catch (error) {
      this.logger.warn(`Cache read failed (sessions:stats): ${String(error)}`);
      return null;
    }
  }

  async setSessionsStats(stats: SessionStats): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      await this.redis!.setex('sessions:stats', TTL.SESSIONS_STATS, JSON.stringify(stats));
    } catch (error) {
      this.logger.warn(`Cache write failed (sessions:stats): ${String(error)}`);
    }
  }
}
