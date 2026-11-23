import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import type { IncomingHttpHeaders } from 'http';
import { ApiKey } from './entities/api-key.entity';
import { BrowserSession } from './entities/browser-session.entity';
import { hashApiKey } from './api-key-hash';
import {
  extractBrowserSessionCookie,
  hashBrowserSessionToken,
  isCookieAuthDisallowedPath,
} from './browser-session.util';
import { presentedApiKey } from '../../common/security/bearer-token';
import { ipMatches } from '../../common/utils/ip';
import { createLogger } from '../../common/services/logger.service';

const REFRESH_INTERVAL_MS = 30_000;

interface IndexedKey {
  keyHash: string;
  allowedIps: string[] | null;
  expiresAt: Date | null;
}

interface IndexedSession {
  apiKeyId: string;
  expiresAt: Date;
}

/**
 * In-memory view of the active API keys and browser sessions, used BEFORE a request body is read
 * to decide which tier of the in-flight body budget the request draws on. It is advisory only: it
 * never authorises anything, the API-key guard still validates every request against the database.
 */
@Injectable()
export class ActiveKeyIndex implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('ActiveKeyIndex');
  private keys = new Map<string, IndexedKey>();
  private keysById = new Map<string, IndexedKey>();
  private sessions = new Map<string, IndexedSession>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading: Promise<void> | undefined;
  private reloadAgain = false;
  private destroyed = false;

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    @Optional()
    @InjectRepository(BrowserSession, 'main')
    private readonly browserSessionRepository?: Repository<BrowserSession>,
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
    // Cleared in the same continuation that leaves the loop: a `.finally` on the returned promise
    // would run a microtask later, and a call landing in that gap would set reloadAgain after the
    // loop had stopped reading it. load() always awaits, so the assignment lands first.
    this.loading = (async () => {
      try {
        do {
          this.reloadAgain = false;
          await this.load();
        } while (this.reloadAgain && !this.destroyed);
      } finally {
        this.loading = undefined;
      }
    })();
  }

  /**
   * The stored hash of the request's key (or the underlying key of an active browser session) when
   * it names an active, unexpired credential that may be used from clientIp; undefined otherwise.
   * Header credentials take exclusive precedence over session cookies.
   */
  recognise(headers: IncomingHttpHeaders, clientIp: string, path?: string): string | undefined {
    const presented = presentedApiKey(headers);
    if (presented !== undefined) {
      const trimmed = presented.trim();
      if (!trimmed) return undefined;
      const keyHash = hashApiKey(trimmed, process.env.API_KEY_PEPPER);
      const key = this.keys.get(keyHash);
      if (!key || !this.isKeyUsable(key, clientIp)) return undefined;
      return keyHash;
    }

    if (isCookieAuthDisallowedPath(path)) return undefined;
    const cookieToken = extractBrowserSessionCookie(headers.cookie);
    if (!cookieToken) return undefined;
    const tokenHash = hashBrowserSessionToken(cookieToken, process.env.API_KEY_PEPPER);
    const session = this.sessions.get(tokenHash);
    if (!session || !(session.expiresAt >= new Date())) return undefined;
    const key = this.keysById.get(session.apiKeyId);
    if (!key || !this.isKeyUsable(key, clientIp)) return undefined;
    return key.keyHash;
  }

  private isKeyUsable(key: IndexedKey, clientIp: string): boolean {
    // Expiry is checked here rather than in the query: SQLite stores dates as strings, and a key
    // that expires between two refreshes must stop counting at once. An expiry that reads back as an
    // invalid date counts as expired, as it does in validateApiKey.
    if (key.expiresAt && !(key.expiresAt >= new Date())) return false;
    if (key.allowedIps?.length && !key.allowedIps.some(entry => ipMatches(clientIp, entry))) return false;
    return true;
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.apiKeyRepository.find({
        select: { id: true, keyHash: true, allowedIps: true, expiresAt: true },
        where: { isActive: true },
      });
      const nextKeys = new Map<string, IndexedKey>();
      const nextKeysById = new Map<string, IndexedKey>();
      for (const row of rows) {
        const entry: IndexedKey = { keyHash: row.keyHash, allowedIps: row.allowedIps, expiresAt: row.expiresAt };
        nextKeys.set(row.keyHash, entry);
        if (row.id) nextKeysById.set(row.id, entry);
      }
      this.keys = nextKeys;
      this.keysById = nextKeysById;

      if (this.browserSessionRepository) {
        const now = new Date();
        const sessionRows = await this.browserSessionRepository.find({
          select: { tokenHash: true, apiKeyId: true, expiresAt: true },
          where: { revokedAt: IsNull(), expiresAt: MoreThan(now) },
        });
        this.sessions = new Map(
          sessionRows.map(row => [row.tokenHash, { apiKeyId: row.apiKeyId, expiresAt: row.expiresAt }]),
        );
      }
    } catch (error) {
      // Keep the last good view: a transient database error must not move every keyed request into
      // the anonymous tier.
      this.logger.warn('Could not refresh the active API key index; keeping the previous one', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
