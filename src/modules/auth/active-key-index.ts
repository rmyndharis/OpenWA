import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IncomingHttpHeaders } from 'http';
import { ApiKey } from './entities/api-key.entity';
import { hashApiKey } from './api-key-hash';
import { bearerToken } from '../../common/security/bearer-token';
import { ipMatches } from '../../common/utils/ip';
import { createLogger } from '../../common/services/logger.service';

const REFRESH_INTERVAL_MS = 30_000;

interface IndexedKey {
  allowedIps: string[] | null;
  expiresAt: Date | null;
}

/**
 * In-memory view of the active API keys, used BEFORE a request body is read to decide which tier
 * of the in-flight body budget the request draws on. It is advisory only: it never authorises
 * anything, the API-key guard still validates every request against the database. A key this
 * node creates, changes or revokes is picked up at once; a direct write to this node's main
 * database within REFRESH_INTERVAL_MS. Keys are per node, so a change made on another node never
 * reaches this index.
 */
@Injectable()
export class ActiveKeyIndex implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('ActiveKeyIndex');
  private keys = new Map<string, IndexedKey>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading: Promise<void> | undefined;
  private reloadAgain = false;
  private destroyed = false;

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.refreshSoon();
    await this.loading;
    this.timer = setInterval(() => this.refreshSoon(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Reload without blocking the caller. A call that lands while a load is running queues exactly
   * one more load, so a write that committed after the running SELECT started is never missed.
   */
  refreshSoon(): void {
    if (this.destroyed) return;
    if (this.loading) {
      this.reloadAgain = true;
      return;
    }
    this.loading = (async () => {
      do {
        this.reloadAgain = false;
        await this.load();
      } while (this.reloadAgain && !this.destroyed);
    })().finally(() => {
      this.loading = undefined;
    });
  }

  /**
   * The stored hash of the request's key when it names an active, unexpired key that may be used
   * from clientIp; undefined otherwise. Reads the key the way the guard does: X-API-Key first, then
   * a Bearer token, trimmed.
   */
  recognise(headers: IncomingHttpHeaders, clientIp: string): string | undefined {
    const header = headers['x-api-key'];
    const raw = (typeof header === 'string' && header ? header : bearerToken(headers.authorization))?.trim();
    if (!raw) return undefined;
    const keyHash = hashApiKey(raw, process.env.API_KEY_PEPPER);
    const key = this.keys.get(keyHash);
    if (!key) return undefined;
    // Expiry is checked here rather than in the query: SQLite stores dates as strings, and a key
    // that expires between two refreshes must stop counting at once.
    if (key.expiresAt && key.expiresAt < new Date()) return undefined;
    if (key.allowedIps?.length && !key.allowedIps.some(entry => ipMatches(clientIp, entry))) return undefined;
    return keyHash;
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.apiKeyRepository.find({
        select: { keyHash: true, allowedIps: true, expiresAt: true },
        where: { isActive: true },
      });
      this.keys = new Map(rows.map(row => [row.keyHash, { allowedIps: row.allowedIps, expiresAt: row.expiresAt }]));
    } catch (error) {
      // Keep the last good view: a transient database error must not move every keyed request into
      // the anonymous tier.
      this.logger.warn('Could not refresh the active API key index; keeping the previous one', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
