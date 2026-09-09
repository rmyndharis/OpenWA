import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, UpdateQueryBuilder, DeleteQueryBuilder, type QueryDeepPartialEntity } from 'typeorm';
import { randomBytes } from 'crypto';
import { ipMatches } from '../../common/utils/ip';
import { hashApiKey } from './api-key-hash';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { CreateApiKeyDto, UpdateApiKeyDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { readBootstrapKey, removeBootstrapKey, writeBootstrapKey } from './bootstrap-key-file';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { EventsGateway, type ApiKeyEvictionReason } from '../events/events.gateway';

/**
 * Resolves the API key to seed on first boot (when no keys exist yet).
 * Precedence: an explicit `API_MASTER_KEY` always wins; otherwise a
 * cryptographically random `owa_k1_` key is generated — the secure default,
 * including in non-production. The legacy fixed `dev-admin-key` is used only when
 * a developer explicitly opts in with `ALLOW_DEV_API_KEY=true`, never by default.
 */
export function resolveSeedApiKey(): string {
  if (process.env.API_MASTER_KEY) {
    return process.env.API_MASTER_KEY;
  }
  if (process.env.ALLOW_DEV_API_KEY === 'true') {
    return 'dev-admin-key';
  }
  return `owa_k1_${randomBytes(32).toString('hex')}`;
}

/**
 * The line to print for the API key in the startup banner. The full raw key is shown ONLY when it was
 * just created (first run, when the operator needs to capture it once). On every subsequent boot the
 * key is masked to a short non-secret fingerprint, so the live admin key is not re-written to the log
 * pipeline (Docker/Loki/CloudWatch) on each restart — it stays in `data/.api-key` (0600) and the
 * dashboard. A placeholder (e.g. "(check dashboard for keys)") is passed through unchanged.
 */
export function bannerKeyLine(displayKey: string, isNewKey: boolean): string {
  if (isNewKey) return displayKey;
  if (displayKey.startsWith('(')) return displayKey;
  return `${displayKey.slice(0, 8)}… (full key in data/.api-key or the dashboard)`;
}

/**
 * Collapse an `allowedSessions` list to the two shapes the enforcement sites actually distinguish.
 *
 * The column is `simple-array`: TypeORM joins on write and splits on read, so `['']` is stored as
 * `''` and read back as `[]`. Every site treats a zero-length list as "every session", so a write
 * that looked like a scoping landed as a widening. The DTO validator now refuses such an entry at
 * the boundary, and this is the second half: whatever reaches storage is either a non-empty list of
 * real ids, or NULL.
 *
 * NULL rather than `[]` on purpose. Both already exist in the table for the same intent, and the
 * published contract says an unscoped key omits the field, which only NULL produces.
 */
function normalizeScopeList(list: string[] | null | undefined): string[] | null {
  if (list == null) return null;
  const cleaned = list.map(entry => entry.trim()).filter(entry => entry.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

interface CachedApiKey {
  apiKey: ApiKey;
  expiresAt: number;
}

function cloneApiKey(key: ApiKey): ApiKey {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(key)), key);
  if (key.allowedIps) clone.allowedIps = [...key.allowedIps];
  if (key.allowedSessions) clone.allowedSessions = [...key.allowedSessions];
  if (key.expiresAt) clone.expiresAt = new Date(key.expiresAt);
  if (key.lastUsedAt) clone.lastUsedAt = new Date(key.lastUsedAt);
  return clone;
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('AuthService');
  private readonly apiKeyCache = new Map<string, CachedApiKey>();
  private readonly apiKeyCacheTtlMs = 60_000;
  private readonly apiKeyCacheMaxEntries = 1_000;

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly usageTracker: ApiKeyUsageTracker,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Clear all cached API keys (useful in tests or administrative resets). */
  clearCache(): void {
    this.apiKeyCache.clear();
  }

  private invalidateCacheForKey(id: string): void {
    for (const [hash, entry] of this.apiKeyCache.entries()) {
      if (entry.apiKey.id === id) {
        this.apiKeyCache.delete(hash);
      }
    }
  }

  async onModuleInit(): Promise<void> {
    // Seed a default API key if none exist
    const count = await this.apiKeyRepository.count();
    let displayKey: string;
    let isNewKey = false;

    if (count === 0) {
      displayKey = resolveSeedApiKey();

      await this.seedApiKey(displayKey, 'Default Admin Key', ApiKeyRole.ADMIN);
      isNewKey = true;

      // Save raw key to file for startup script to read (owner-only — it's the raw admin key).
      try {
        writeBootstrapKey(displayKey);
      } catch (err) {
        this.logger.warn('Could not save API key file', { error: String(err) });
      }
    } else {
      // Read the saved bootstrap key from the file — but only while it still resolves to a LIVE
      // key; a revoked/rotated/deleted key must not be advertised in the banner.
      displayKey = (await this.readLiveBootstrapKey()) ?? '(check dashboard for keys)';
    }

    // Always show the welcome banner on startup
    const apiBaseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 2785}`;
    // The dashboard is served by NestJS at the same origin as the API now, so default to it.
    const dashboardUrl = process.env.DASHBOARD_URL || apiBaseUrl;

    this.logger.log('');
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log('');
    this.logger.log('  🟢 Welcome to OpenWA - WhatsApp API Gateway');
    this.logger.log('');
    this.logger.log(`  📊 Dashboard: ${dashboardUrl}`);
    this.logger.log(`  📚 API Docs:  ${apiBaseUrl}/api/docs`);
    this.logger.log('');
    if (isNewKey) {
      this.logger.log('  🔑 API Key (newly created):');
    } else {
      this.logger.log('  🔑 API Key:');
    }
    this.logger.log(`     ${bannerKeyLine(displayKey, isNewKey)}`);
    this.logger.log('');
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log('');
  }

  /** Flush the coalesced usage counters before the DB connection closes. See ApiKeyUsageTracker. */
  async onModuleDestroy(): Promise<void> {
    this.apiKeyCache.clear();
    await this.usageTracker.flushOnShutdown();
  }

  /**
   * Read the bootstrap key file for the startup banner — only while it still points at a LIVE key.
   * The file is written once at first boot; when that key is later revoked, rotated, or deleted, the
   * file (and the banner quoting it) would otherwise keep advertising a dead credential. A stale file
   * is removed here too, so a backup restore that lost the key self-heals on the next boot.
   * Returns null when the file is absent, unreadable, empty, or stale.
   */
  private async readLiveBootstrapKey(): Promise<string | null> {
    const rawKey = readBootstrapKey(this.logger);
    if (!rawKey) return null;
    const stored = await this.apiKeyRepository.findOne({ where: { keyHash: this.hashKey(rawKey) } });
    const live = Boolean(stored && stored.isActive && (!stored.expiresAt || stored.expiresAt > new Date()));
    if (live) return rawKey;
    if (!stored) {
      // A hash miss alone does not prove the key is gone: the same raw key hashes differently under
      // a changed API_KEY_PEPPER. The prefix is seeded unhashed alongside the key, so it still finds
      // the row — when it resolves, the file holds the only copy of a still-live key and must
      // survive. Delete only when nothing carries the prefix either (e.g. a backup restore that
      // lost the key row), preserving the documented self-heal.
      const byPrefix = await this.apiKeyRepository.findOne({ where: { keyPrefix: rawKey.substring(0, 12) } });
      if (byPrefix) {
        this.logger.warn(
          'Bootstrap API key file does not match any stored key hash — API_KEY_PEPPER changed since the key was seeded? The key itself is still live, so the file is kept; restore the original pepper or rotate the key to repair.',
          { keyPrefix: byPrefix.keyPrefix, action: 'bootstrap_key_pepper_mismatch' },
        );
        return null;
      }
    }
    removeBootstrapKey('it no longer resolves to an active key', this.logger);
    return null;
  }

  /**
   * Remove the bootstrap key file when it still holds the key being revoked or deleted, so the next
   * boot's banner cannot point the operator at a dead credential. The file is an operator
   * convenience (banner + backup scripts); it is never read for seeding or authentication, so
   * removing it cannot break first-boot seeding — seeding writes it only when no keys exist.
   */
  private removeBootstrapKeyFileIfMatching(apiKey: ApiKey): void {
    const fileKey = readBootstrapKey(this.logger);
    if (!fileKey || this.hashKey(fileKey) !== apiKey.keyHash) return;
    removeBootstrapKey('its key was revoked or deleted', this.logger);
  }

  private async seedApiKey(rawKey: string, name: string, role: ApiKeyRole): Promise<ApiKey> {
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);

    const apiKey = this.apiKeyRepository.create({
      name,
      keyHash,
      keyPrefix,
      role,
    });

    return this.apiKeyRepository.save(apiKey);
  }

  async createApiKey(dto: CreateApiKeyDto): Promise<{ apiKey: ApiKey; rawKey: string }> {
    // Generate secure random key: owa_k1_<32 bytes hex>
    const rawKey = `owa_k1_${randomBytes(32).toString('hex')}`;
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);

    const apiKey = this.apiKeyRepository.create({
      name: dto.name,
      keyHash,
      keyPrefix,
      role: dto.role || ApiKeyRole.OPERATOR,
      allowedIps: dto.allowedIps || null,
      allowedSessions: normalizeScopeList(dto.allowedSessions),
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const saved = await this.apiKeyRepository.save(apiKey);
    this.logger.log(`API key created: ${saved.name}`, {
      keyId: saved.id,
      role: saved.role,
      action: 'api_key_created',
    });

    return { apiKey: saved, rawKey };
  }

  async findAll(): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<ApiKey> {
    const apiKey = await this.apiKeyRepository.findOne({ where: { id } });
    if (!apiKey) {
      throw new NotFoundException(`API key with id '${id}' not found`);
    }
    return apiKey;
  }

  async update(id: string, dto: UpdateApiKeyDto): Promise<ApiKey> {
    const apiKey = await this.findOne(id);

    // Scoping the last unscoped admin (non-empty allowedSessions) strips key-management just as
    // surely as demoting or expiring it: @RequireUnscopedKey would then 403 every lifecycle route.
    const removesOrSchedulesLastAdmin =
      (dto.role !== undefined && dto.role !== ApiKeyRole.ADMIN) ||
      (dto.expiresAt !== undefined && dto.expiresAt !== null) ||
      (normalizeScopeList(dto.allowedSessions)?.length ?? 0) > 0;

    // Capture the authorization-relevant fields BEFORE applying the change. Only a change to role,
    // allowedIps, allowedSessions, or expiry can widen or restrict what an already-connected WebSocket
    // socket may see, so only those trigger eviction of live /events sockets — a benign rename must
    // NOT disconnect clients. REST enforces the new state immediately; without eviction a live socket
    // keeps streaming events for sessions/IPs the key just lost until it resubscribes or drops.
    const before = {
      role: apiKey.role,
      allowedIps: apiKey.allowedIps,
      allowedSessions: apiKey.allowedSessions,
      expiresAt: apiKey.expiresAt,
    };

    const patch: QueryDeepPartialEntity<ApiKey> = {};
    if (dto.name) patch.name = dto.name;
    if (dto.role) patch.role = dto.role;
    if (dto.allowedIps !== undefined) patch.allowedIps = dto.allowedIps;
    if (dto.allowedSessions !== undefined) patch.allowedSessions = normalizeScopeList(dto.allowedSessions);
    if (dto.expiresAt !== undefined) patch.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    let saved: ApiKey;
    if (removesOrSchedulesLastAdmin && apiKey.role === ApiKeyRole.ADMIN) {
      // The guard's predicate is the target's ROLE, not its usability snapshot: usability also
      // depends on isActive/expiry/scope, which the guarded statement itself evaluates against live
      // row state. A non-admin target genuinely cannot strand the system, so it stays lock-free.
      const result = await this.withLastAdminGuard(
        this.apiKeyRepository.createQueryBuilder().update(ApiKey).set(patch),
        id,
      ).execute();
      await this.assertMutationApplied(id, result.affected);
      // The row's post-write state, for the eviction comparison below.
      saved = await this.findOne(id);
    } else {
      await this.applyUnguardedUpdate(patch, id);
      // The row's post-write state, for the eviction comparison below.
      saved = await this.findOne(id);
    }

    // Compare membership, not order: a pure reorder of allowedIps/allowedSessions is a no-op for the
    // .includes()-based enforcement, so sort before stringify to avoid a spurious eviction on a reorder.
    // Normalize before comparing: a legacy row stored as '' reads back as [], which means the same
    // as NULL at every enforcement site, so treating them as different would evict live sockets for a
    // write that changed nothing.
    const ordered = (v: string[] | null) => {
      const normalized = normalizeScopeList(v);
      return normalized ? [...normalized].sort() : null;
    };
    const authzChanged =
      saved.role !== before.role ||
      saved.expiresAt?.getTime() !== before.expiresAt?.getTime() ||
      JSON.stringify(ordered(saved.allowedIps)) !== JSON.stringify(ordered(before.allowedIps)) ||
      JSON.stringify(ordered(saved.allowedSessions)) !== JSON.stringify(ordered(before.allowedSessions));
    if (authzChanged) {
      this.evictActiveSockets(id, 'authorization_changed');
    }
    this.invalidateCacheForKey(id);
    return saved;
  }

  async delete(id: string): Promise<void> {
    const apiKey = await this.findOne(id);
    if (apiKey.role === ApiKeyRole.ADMIN) {
      const result = await this.withLastAdminGuard(
        this.apiKeyRepository.createQueryBuilder().delete().from(ApiKey),
        id,
      ).execute();
      await this.assertMutationApplied(id, result.affected);
    } else {
      // A non-admin target cannot strand the system — no guard needed.
      await this.apiKeyRepository.remove(apiKey);
    }
    this.invalidateCacheForKey(id);
    // Drop any un-flushed usage accumulator so a deleted key leaves nothing behind in the Map.
    this.usageTracker.forget(id);
    this.removeBootstrapKeyFileIfMatching(apiKey);
    this.evictActiveSockets(id, 'deleted');
    this.logger.log(`API key deleted: ${apiKey.name}`, {
      keyId: id,
      action: 'api_key_deleted',
    });
  }

  async revoke(id: string): Promise<ApiKey> {
    const apiKey = await this.findOne(id);
    let saved: ApiKey;
    if (apiKey.role === ApiKeyRole.ADMIN) {
      const result = await this.withLastAdminGuard(
        this.apiKeyRepository.createQueryBuilder().update(ApiKey).set({ isActive: false }),
        id,
      ).execute();
      await this.assertMutationApplied(id, result.affected);
      saved = await this.findOne(id);
    } else {
      // A non-admin target cannot strand the system — no guard needed.
      await this.applyUnguardedUpdate({ isActive: false }, id);
      saved = await this.findOne(id);
    }
    this.invalidateCacheForKey(id);
    // A revoked key fails validation before its next flush, so its accumulator would orphan —
    // drop it here.
    this.usageTracker.forget(id);
    this.removeBootstrapKeyFileIfMatching(apiKey);
    // Kick any WebSocket connections already authenticated with this key: without this, a revoked
    // key keeps receiving events on already-subscribed sockets until they happen to disconnect.
    this.evictActiveSockets(id, 'revoked');
    return saved;
  }

  /**
   * "Usable admin" — the SQL-level subject of the last-admin invariant: an active, unexpired ADMIN
   * key with NO session scope. The key-lifecycle routes are fenced behind @RequireUnscopedKey
   * (AuthController), so a session-scoped admin can authenticate but can never manage keys —
   * counting it as a surviving admin would bless the removal of the last key that actually can, a
   * permanent management lockout with no in-band recovery (the boot seed only fires on an EMPTY
   * table, not on zero unscoped admins). The simple-array column stores an empty array as '' (rows
   * updated with allowedSessions: [] hold exactly that), so "no session scope" is NULL or ''.
   * Dates are stored as UTC "YYYY-MM-DD HH:mm:ss.SSS" strings, so :guardNow is bound in that exact
   * format (see guardNowParam) and the string comparison is chronological. Parameterized by column
   * prefix so one definition serves both the row being mutated (bare) and the EXISTS subquery's
   * `other` row.
   */
  private static usableAdminCondition(prefix: string): string {
    const col = (name: string) => (prefix ? `"${prefix}"."${name}"` : `"${name}"`);
    return (
      `${col('role')} = :adminRole AND ${col('isActive')} = 1 AND ` +
      `(${col('expiresAt')} IS NULL OR ${col('expiresAt')} > :guardNow) AND ` +
      `(${col('allowedSessions')} = '' OR ${col('allowedSessions')} IS NULL)`
    );
  }

  /**
   * The instant bound as :guardNow, formatted exactly as the SQLite driver persists datetime
   * columns (UTC "YYYY-MM-DD HH:mm:ss.SSS" — what AbstractSqliteDriver writes for a Date), so the
   * guard's comparison against stored expiresAt values is chronological.
   */
  private static guardNowParam(): string {
    return new Date().toISOString().slice(0, 23).replace('T', ' ');
  }

  /**
   * Bind the last-admin guard onto a single-row UPDATE/DELETE: the statement touches its target row
   * ONLY when that row is not a usable admin, or another usable admin survives it. The guard runs
   * inside the same statement as the write, so the database serializes concurrent last-admin
   * mutations — including across processes sharing this database. The disjunct is parenthesized
   * explicitly: without the outer parens, `id = :id AND NOT (…) OR EXISTS (…)` would parse as
   * `(id = :id AND NOT …) OR EXISTS (…)` and the EXISTS branch would escape the row scope.
   */
  private withLastAdminGuard<T extends UpdateQueryBuilder<ApiKey> | DeleteQueryBuilder<ApiKey>>(qb: T, id: string): T {
    // Cast: the chained this-types collapse to the union across a generic receiver.
    return qb
      .where('"id" = :id', { id })
      .andWhere(
        `(NOT (${AuthService.usableAdminCondition('')}) OR EXISTS (` +
          `SELECT 1 FROM "api_keys" "other" WHERE "other"."id" <> :id AND ${AuthService.usableAdminCondition('other')}))`,
      )
      .setParameters({ adminRole: ApiKeyRole.ADMIN, guardNow: AuthService.guardNowParam() }) as T;
  }

  /**
   * A guarded statement that affected zero rows either hit the guard (the target was the last
   * usable admin) or lost a race with a concurrent delete (the row is gone). Distinguish by
   * re-reading: findOne raises the same NotFoundException it does anywhere else, and a row that
   * still exists was refused by the guard.
   */
  private async assertMutationApplied(id: string, affected: number | null | undefined): Promise<void> {
    if (affected) return;
    await this.findOne(id);
    throw new ConflictException('Cannot remove the last active admin key');
  }

  /**
   * Apply a single-row UPDATE with no last-admin guard — the caller has established the target
   * cannot strand the system (non-admin target, or a non-stripping patch). The SET list is only
   * the patch itself: saving the pre-read ENTITY instead would write every column from that
   * snapshot, resurrecting a revoke or demote that committed between the read and the write (a
   * rename writing isActive: true back over a concurrent false, for instance). There is no guard
   * clause that can refuse, so zero affected rows can only mean a concurrent delete won the race;
   * the re-read then raises the same NotFoundException the pre-read would have.
   */
  private async applyUnguardedUpdate(patch: QueryDeepPartialEntity<ApiKey>, id: string): Promise<void> {
    const result = await this.apiKeyRepository
      .createQueryBuilder()
      .update(ApiKey)
      .set(patch)
      .where('"id" = :id', { id })
      .execute();
    if (!result.affected) {
      await this.findOne(id);
    }
  }

  /**
   * Disconnect every WebSocket socket authenticated with the given key id. Resolved lazily via
   * ModuleRef (not constructor injection) to avoid a static DI cycle between AuthModule and
   * EventsModule. Best-effort: if the WS gateway isn't loaded (or has no sockets for the key),
   * this is a silent no-op.
   */
  private evictActiveSockets(keyId: string, reason: ApiKeyEvictionReason = 'revoked'): void {
    try {
      const gateway = this.moduleRef.get(EventsGateway, { strict: false });
      if (gateway) {
        gateway.evictApiKey(keyId, reason);
      }
    } catch (error) {
      // Eviction is best-effort: the key's DB state is already authoritative (validateApiKey
      // rejects it), so a failure here must never roll back the revoke/delete.
      this.logger.warn(`Failed to evict WebSocket sockets for key ${keyId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async validateApiKey(rawKey: string, clientIp?: string, sessionId?: string): Promise<ApiKey> {
    // Trim before hashing so every surface agrees on what the credential is. HTTP already strips
    // surrounding whitespace from header values, so a pasted key with a stray space/newline
    // authenticates over REST but fails on the WebSocket handshake (the CONNECT payload carries the
    // literal string) — the dashboard then runs commands fine while never receiving events, and the
    // session looks permanently disconnected. Whitespace is never part of a key.
    const keyHash = this.hashKey(rawKey?.trim());

    let apiKey: ApiKey | null = null;
    const now = Date.now();
    const cached = this.apiKeyCache.get(keyHash);

    if (cached && cached.expiresAt > now) {
      apiKey = cloneApiKey(cached.apiKey);
      // Refresh LRU order
      this.apiKeyCache.delete(keyHash);
      this.apiKeyCache.set(keyHash, cached);
    } else {
      apiKey = await this.apiKeyRepository.findOne({ where: { keyHash } });
      if (apiKey && apiKey.isActive) {
        if (this.apiKeyCache.size >= this.apiKeyCacheMaxEntries) {
          const firstKey = this.apiKeyCache.keys().next().value;
          if (firstKey) this.apiKeyCache.delete(firstKey);
        }
        this.apiKeyCache.set(keyHash, {
          apiKey: cloneApiKey(apiKey),
          expiresAt: now + this.apiKeyCacheTtlMs,
        });
      }
    }

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (!apiKey.isActive) {
      throw new UnauthorizedException('API key is revoked');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Check IP whitelist (fail closed: if a whitelist is configured but the client
    // IP could not be determined, reject rather than silently skipping the check)
    if (apiKey.allowedIps && apiKey.allowedIps.length > 0) {
      if (!clientIp) {
        throw new UnauthorizedException('Client IP could not be determined');
      }
      if (!this.isIpAllowed(clientIp, apiKey.allowedIps)) {
        this.logger.warn(`IP not allowed: ${clientIp}`, {
          keyId: apiKey.id,
          action: 'ip_rejected',
        });
        throw new UnauthorizedException('IP address not allowed');
      }
    }

    // Check session restriction
    if (apiKey.allowedSessions && apiKey.allowedSessions.length > 0 && sessionId) {
      if (!apiKey.allowedSessions.includes(sessionId)) {
        throw new UnauthorizedException('API key not authorized for this session');
      }
    }

    // Advisory stats only; the tracker coalesces the write and never throws.
    await this.usageTracker.record(apiKey);

    return apiKey;
  }

  private hashKey(rawKey: string): string {
    return hashApiKey(rawKey, process.env.API_KEY_PEPPER);
  }

  private isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    // Delegate to the shared, hardened matcher (also used by the throttler and the API-key guard's IP
    // resolution): it handles both an exact IP entry and CIDR notation, and — unlike the previous local
    // parser — rejects a malformed octet instead of coercing it into range.
    return allowedIps.some(entry => ipMatches(clientIp, entry));
  }

  hasPermission(apiKey: ApiKey, requiredRole: ApiKeyRole): boolean {
    const roleHierarchy: Record<ApiKeyRole, number> = {
      [ApiKeyRole.VIEWER]: 1,
      [ApiKeyRole.OPERATOR]: 2,
      [ApiKeyRole.ADMIN]: 3,
    };

    return roleHierarchy[apiKey.role] >= roleHierarchy[requiredRole];
  }
}
