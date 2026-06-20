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
  private connecting = false;
  private connectionAttempts = 0;
  private readonly maxConnectionAttempts = 5;

  constructor(private readonly configService: ConfigService) {
    // Check REDIS_ENABLED env var directly (from saved .env.generated)
    // Fallback to config 'cache.enabled' for backward compatibility
    this.enabled = process.env.REDIS_ENABLED === 'true' || configService.get<boolean>('cache.enabled', false);

    this.logger.log(`CacheService: enabled=${this.enabled}, REDIS_ENABLED=${process.env.REDIS_ENABLED}`);

    // Don't connect immediately - wait for Redis container to be ready
    // Connection will be established on first use via isAvailable()
  }

  /**
   * Try to (re)connect to Redis
   * Returns true if connection succeeded
   */
  async tryConnect(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.connecting) return false;
    if (this.redis && (await this.ping())) return true;

    this.connecting = true;
    this.connectionAttempts++;

    try {
      const host = process.env.REDIS_HOST || this.configService.get<string>('REDIS_HOST', 'localhost');
      const port = parseInt(process.env.REDIS_PORT || '', 10) || this.configService.get<number>('REDIS_PORT', 6379);

      this.logger.log(`Connecting to Redis at ${host}:${port} (attempt ${this.connectionAttempts})`);

      this.redis = new Redis({
        host,
        port,
        password: this.configService.get<string>('REDIS_PASSWORD'),
        db: this.configService.get<number>('REDIS_CACHE_DB', 1),
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        retryStrategy: times => {
          if (times > 3) return null;
          return Math.min(times * 500, 3000);
        },
      });

      this.redis.on('error', err => {
        this.logger.warn(`Redis error: ${err.message}`);
      });

      this.redis.on('connect', () => {
        this.logger.log('Redis cache connected');
        this.connectionAttempts = 0; // Reset on success
      });

      await this.redis.connect();
      this.connecting = false;
      return true;
    } catch (error) {
      this.logger.warn(`Redis connection failed (attempt ${this.connectionAttempts}): ${String(error)}`);
      this.redis = null;
      this.connecting = false;
      return false;
    }
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

    // If not connected, try to connect (with rate limiting)
    if (!this.redis && this.connectionAttempts < this.maxConnectionAttempts) {
      await this.tryConnect();
    }

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
