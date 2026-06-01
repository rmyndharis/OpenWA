import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createLogger } from '../../common/services/logger.service';

/**
 * Redis-backed session-ownership registry (Tier 4).
 *
 * A WhatsApp engine is a live Puppeteer/browser session bound to the process
 * that started it — it cannot migrate to another node. So horizontal scale here
 * means *ownership routing*: each node records which sessions it owns in Redis,
 * refreshed by a heartbeat. A request that lands on a node not holding the
 * engine can look up the real owner and respond meaningfully instead of a
 * misleading "session not started".
 *
 * When CLUSTER_ENABLED is off every method is a no-op and getOwner returns
 * null, so single-instance behavior is unchanged.
 */
@Injectable()
export class SessionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('SessionRegistry');
  private redis?: Redis;
  private heartbeatTimer?: NodeJS.Timeout;

  /** Sessions this node currently owns; refreshed by the heartbeat. */
  private readonly owned = new Set<string>();

  private readonly enabled: boolean;
  private readonly instance: string;
  private readonly ttl: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get<boolean>('cluster.enabled', false);
    this.instance = config.get<string>('cluster.instanceId', 'default');
    this.ttl = config.get<number>('cluster.ownershipTtl', 30);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    this.redis = new Redis({
      host: this.config.get<string>('redis.host', 'localhost'),
      port: this.config.get<number>('redis.port', 6379),
      password: this.config.get<string>('redis.password'),
    });
    this.redis.on('error', err => this.logger.error('Redis error', err instanceof Error ? err.message : String(err)));

    // Refresh owned claims at half the TTL so a brief Redis hiccup never lets a
    // live session's ownership lapse.
    const intervalMs = Math.max(1000, (this.ttl * 1000) / 2);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), intervalMs);
    // Don't let the heartbeat keep the process alive on shutdown.
    this.heartbeatTimer.unref();
    this.logger.log(`Cluster ownership registry active as '${this.instance}' (ttl ${this.ttl}s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (!this.redis) {
      return;
    }
    // Best-effort: drop our claims so failover can happen without waiting for TTL.
    await Promise.all([...this.owned].map(id => this.release(id)));
    await this.redis.quit();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get instanceId(): string {
    return this.instance;
  }

  /** Claim ownership of a session for this node. */
  async claim(sessionId: string): Promise<void> {
    this.owned.add(sessionId);
    if (!this.redis) {
      return;
    }
    await this.redis.set(this.key(sessionId), this.instance, 'EX', this.ttl);
  }

  /** Release ownership — only deletes the claim if this node still holds it. */
  async release(sessionId: string): Promise<void> {
    this.owned.delete(sessionId);
    if (!this.redis) {
      return;
    }
    const current = await this.redis.get(this.key(sessionId));
    if (current === this.instance) {
      await this.redis.del(this.key(sessionId));
    }
  }

  /** The instance id that currently owns a session, or null if unowned/disabled. */
  async getOwner(sessionId: string): Promise<string | null> {
    if (!this.redis) {
      return null;
    }
    return this.redis.get(this.key(sessionId));
  }

  private async heartbeat(): Promise<void> {
    if (!this.redis || this.owned.size === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const id of this.owned) {
      pipeline.set(this.key(id), this.instance, 'EX', this.ttl);
    }
    await pipeline.exec();
  }

  private key(sessionId: string): string {
    return `session:owner:${sessionId}`;
  }
}
