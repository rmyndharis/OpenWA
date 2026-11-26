import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { BrowserSession } from './entities/browser-session.entity';
import { ApiKey } from './entities/api-key.entity';
import { AuthService, UnresolvedApiKeyException } from './auth.service';
import { ActiveKeyIndex } from './active-key-index';
import {
  MAX_BROWSER_SESSION_TTL_MS,
  MIN_BROWSER_SESSION_TTL_MS,
  hashBrowserSessionToken,
  resolveBrowserSessionTtlMs,
} from './browser-session.util';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';

const PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const REVOKED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_BROWSER_SESSIONS_PER_KEY = 25;
export const MAX_BROWSER_SESSIONS_GLOBAL = 10_000;

export interface ValidatedBrowserSession {
  session: BrowserSession;
  apiKey: ApiKey;
}

@Injectable()
export class BrowserSessionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('BrowserSessionService');
  private pruneTimer?: ReturnType<typeof setInterval>;
  private readonly maxSessionsPerKey = MAX_BROWSER_SESSIONS_PER_KEY;
  private readonly maxSessionsGlobal = MAX_BROWSER_SESSIONS_GLOBAL;
  private lastIssuedAtMs = 0;

  constructor(
    @InjectRepository(BrowserSession, 'main')
    private readonly sessionRepository: Repository<BrowserSession>,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly keyIndex?: ActiveKeyIndex,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.pruneExpired().catch(error =>
      this.logger.warn('Failed to prune expired browser sessions on boot', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    this.pruneTimer = setInterval(() => {
      void this.pruneExpired().catch(error =>
        this.logger.warn('Failed to prune expired browser sessions', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  async createSession(apiKey: ApiKey): Promise<{ token: string; session: BrowserSession; ttlMs: number }> {
    const nowMs = Math.max(Date.now(), this.lastIssuedAtMs + 1);
    this.lastIssuedAtMs = nowMs;
    const now = new Date(nowMs);
    await this.enforceSessionCaps(apiKey.id, now);

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashBrowserSessionToken(token, process.env.API_KEY_PEPPER);
    const configuredTtl = this.configService?.get<number>('auth.dashboardSessionTtlMs');
    const ttlMs =
      typeof configuredTtl === 'number' && Number.isSafeInteger(configuredTtl) && configuredTtl > 0
        ? Math.min(MAX_BROWSER_SESSION_TTL_MS, Math.max(MIN_BROWSER_SESSION_TTL_MS, configuredTtl))
        : resolveBrowserSessionTtlMs(process.env.DASHBOARD_SESSION_TTL_MS);
    const expiresAt = new Date(nowMs + ttlMs);

    const entity = this.sessionRepository.create({
      tokenHash,
      apiKeyId: apiKey.id,
      createdAt: now,
      expiresAt,
      revokedAt: null,
    });
    const session = await this.sessionRepository.save(entity);
    this.keyIndex?.refreshSoon();
    return { token, session, ttlMs };
  }

  private async enforceSessionCaps(apiKeyId: string, now: Date): Promise<void> {
    const activeForKey = await this.sessionRepository.find({
      select: { id: true },
      where: { apiKeyId, revokedAt: IsNull(), expiresAt: MoreThan(now) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    if (activeForKey.length >= this.maxSessionsPerKey) {
      const toEvict = activeForKey.slice(0, activeForKey.length - this.maxSessionsPerKey + 1).map(row => row.id);
      await this.sessionRepository.update({ id: In(toEvict), revokedAt: IsNull() }, { revokedAt: now });
      for (const id of toEvict) this.evictSessionSockets(id, 'revoked');
    }

    let activeGlobal = await this.sessionRepository.count({
      where: { revokedAt: IsNull(), expiresAt: MoreThan(now) },
    });
    if (activeGlobal >= this.maxSessionsGlobal) {
      await this.pruneExpired(now);
      activeGlobal = await this.sessionRepository.count({
        where: { revokedAt: IsNull(), expiresAt: MoreThan(now) },
      });
      if (activeGlobal >= this.maxSessionsGlobal) {
        const excess = activeGlobal - this.maxSessionsGlobal + 1;
        const oldest = await this.sessionRepository.find({
          select: { id: true },
          where: { revokedAt: IsNull(), expiresAt: MoreThan(now) },
          order: { createdAt: 'ASC', id: 'ASC' },
          take: excess,
        });
        if (oldest.length > 0) {
          const ids = oldest.map(row => row.id);
          await this.sessionRepository.update({ id: In(ids), revokedAt: IsNull() }, { revokedAt: now });
          for (const id of ids) this.evictSessionSockets(id, 'revoked');
        }
      }
    }
  }

  async validateSessionToken(
    rawToken: string,
    clientIp?: string,
    sessionId?: string,
    opts?: { recordUsage?: boolean },
  ): Promise<ValidatedBrowserSession> {
    const trimmed = rawToken?.trim();
    if (!trimmed) {
      throw new UnresolvedApiKeyException('Invalid session');
    }
    const tokenHash = hashBrowserSessionToken(trimmed, process.env.API_KEY_PEPPER);
    const session = await this.sessionRepository.findOne({ where: { tokenHash } });
    return this.verifySessionAndApiKey(session, clientIp, sessionId, opts);
  }

  async validateSessionById(
    browserSessionId: string,
    clientIp?: string,
    sessionId?: string,
    opts?: { recordUsage?: boolean },
  ): Promise<ValidatedBrowserSession> {
    const session = await this.sessionRepository.findOne({ where: { id: browserSessionId } });
    return this.verifySessionAndApiKey(session, clientIp, sessionId, opts);
  }

  /** Revoke the session behind a cookie token. Returns the session only when this call revoked it. */
  async revokeByToken(rawToken: string): Promise<BrowserSession | null> {
    const trimmed = rawToken?.trim();
    if (!trimmed) return null;
    const tokenHash = hashBrowserSessionToken(trimmed, process.env.API_KEY_PEPPER);
    const session = await this.sessionRepository.findOne({ where: { tokenHash } });
    if (!session) return null;
    let revoked = false;
    if (!session.revokedAt) {
      const result = await this.sessionRepository.update(
        { id: session.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      revoked = Boolean(result.affected);
      this.keyIndex?.refreshSoon();
    }
    this.evictSessionSockets(session.id, 'logged_out');
    return revoked ? session : null;
  }

  async revokeByApiKeyId(apiKeyId: string): Promise<void> {
    await this.sessionRepository.update({ apiKeyId, revokedAt: IsNull() }, { revokedAt: new Date() });
    this.keyIndex?.refreshSoon();
  }

  async pruneExpired(now = new Date()): Promise<number> {
    const revokedCutoff = new Date(now.getTime() - REVOKED_RETENTION_MS);
    const expiredResult = await this.sessionRepository.delete({ expiresAt: LessThanOrEqual(now) });
    const revokedResult = await this.sessionRepository.delete({ revokedAt: LessThanOrEqual(revokedCutoff) });
    return (expiredResult.affected ?? 0) + (revokedResult.affected ?? 0);
  }

  private async verifySessionAndApiKey(
    session: BrowserSession | null,
    clientIp?: string,
    sessionId?: string,
    opts?: { recordUsage?: boolean },
  ): Promise<ValidatedBrowserSession> {
    if (!session) {
      throw new UnresolvedApiKeyException('Invalid session');
    }
    if (session.revokedAt !== null) {
      throw new UnresolvedApiKeyException('Session has been revoked');
    }
    if (!(session.expiresAt >= new Date())) {
      throw new UnresolvedApiKeyException('Session has expired');
    }
    const apiKey = await this.authService.validateApiKeyById(session.apiKeyId, clientIp, sessionId, opts);
    return { session, apiKey };
  }

  private evictSessionSockets(browserSessionId: string, reason: 'logged_out' | 'revoked' | 'expired'): void {
    if (!this.moduleRef) return;
    try {
      const gateway = this.moduleRef.get(EventsGateway, { strict: false });
      gateway?.evictBrowserSession(browserSessionId, reason);
    } catch (error) {
      this.logger.warn(`Failed to evict WebSocket sockets for browser session ${browserSessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
