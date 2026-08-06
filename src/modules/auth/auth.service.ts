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
import { Equal, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { ipMatches } from '../../common/utils/ip';
import { hashApiKey } from './api-key-hash';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { CreateApiKeyDto, UpdateApiKeyDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { readBootstrapKey, removeBootstrapKey, writeBootstrapKey } from './bootstrap-key-file';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { EventsGateway, type ApiKeyEvictionReason } from '../events/events.gateway';
import { KeyedAsyncLock } from '../integration/ordering-lock';

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

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('AuthService');

  /**
   * Serializes every last-usable-admin check with the mutation it guards, in ONE critical section.
   * The check is check-then-act across awaits: without serialization, two concurrent requests that
   * demote/delete/revoke the last two admins both pass the check before either writes — leaving zero
   * usable admins, a total management lockout (the boot seed only fires on an EMPTY table, not on
   * zero admins). The guarded invariant is global ("count of OTHER usable admins"), so the lock key
   * must be a single global key too: keying per target key id would serialize nothing — the racing
   * requests target DIFFERENT keys. An in-process mutex is sufficient under the single-process
   * deployment contract.
   */
  private readonly adminCapabilityLock = new KeyedAsyncLock();
  private static readonly ADMIN_CAPABILITY_LOCK_KEY = 'admin-capability';

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly usageTracker: ApiKeyUsageTracker,
    private readonly moduleRef: ModuleRef,
  ) {}

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
      allowedSessions: dto.allowedSessions || null,
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
      (dto.allowedSessions !== undefined && dto.allowedSessions.length > 0);

    const applyAndSave = async (): Promise<ApiKey> => {
      // Re-read the target inside the critical section: the pre-lock snapshot can be stale — a
      // concurrent serialized mutation may already have changed this key's usability — so the
      // last-admin check and the write both run against fresh state.
      const target = await this.findOne(id);
      if (removesOrSchedulesLastAdmin) {
        await this.assertNotLastUsableAdmin(target);
      }

      // Capture the authorization-relevant fields BEFORE applying the change. Only a change to role,
      // allowedIps, allowedSessions, or expiry can widen or restrict what an already-connected WebSocket
      // socket may see, so only those trigger eviction of live /events sockets — a benign rename must
      // NOT disconnect clients. REST enforces the new state immediately; without eviction a live socket
      // keeps streaming events for sessions/IPs the key just lost until it resubscribes or drops.
      const before = {
        role: target.role,
        allowedIps: target.allowedIps,
        allowedSessions: target.allowedSessions,
        expiresAt: target.expiresAt,
      };

      if (dto.name) target.name = dto.name;
      if (dto.role) target.role = dto.role;
      if (dto.allowedIps !== undefined) target.allowedIps = dto.allowedIps;
      if (dto.allowedSessions !== undefined) target.allowedSessions = dto.allowedSessions;
      if (dto.expiresAt !== undefined) target.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

      const saved = await this.apiKeyRepository.save(target);

      // Compare membership, not order: a pure reorder of allowedIps/allowedSessions is a no-op for the
      // .includes()-based enforcement, so sort before stringify to avoid a spurious eviction on a reorder.
      const ordered = (v: string[] | null) => (v ? [...v].sort() : v);
      const authzChanged =
        saved.role !== before.role ||
        saved.expiresAt?.getTime() !== before.expiresAt?.getTime() ||
        JSON.stringify(ordered(saved.allowedIps)) !== JSON.stringify(ordered(before.allowedIps)) ||
        JSON.stringify(ordered(saved.allowedSessions)) !== JSON.stringify(ordered(before.allowedSessions));
      if (authzChanged) {
        this.evictActiveSockets(id, 'authorization_changed');
      }
      return saved;
    };

    // Run check+write inside the shared critical section ONLY when this update can strip the last
    // usable admin; every other update (rename, promotion, non-admin keys) stays lock-free.
    // The predicate is the target's ROLE, not its usability: usability also depends on isActive,
    // expiry and scope, any of which a concurrent serialized mutation may have just changed. Reading
    // that from the pre-lock snapshot would let a target that only LOOKS unusable skip the lock and
    // run its check unserialized — the very race the lock exists to close. Role is the stable,
    // conservative key: it over-locks a little (an already-revoked admin) and never under-locks.
    return removesOrSchedulesLastAdmin && apiKey.role === ApiKeyRole.ADMIN
      ? this.adminCapabilityLock.run(AuthService.ADMIN_CAPABILITY_LOCK_KEY, applyAndSave)
      : applyAndSave();
  }

  async delete(id: string): Promise<void> {
    const apiKey = await this.findOne(id);
    const removeKey = async (): Promise<void> => {
      // Re-read inside the critical section (same staleness hazard as update()): never run the
      // last-admin check against the pre-lock snapshot.
      const target = await this.findOne(id);
      await this.assertNotLastUsableAdmin(target);
      // Drop any un-flushed usage accumulator so a deleted key leaves nothing behind in the Map.
      this.usageTracker.forget(id);
      await this.apiKeyRepository.remove(target);
      this.removeBootstrapKeyFileIfMatching(target);
    };
    // Lock on the ROLE, not on the pre-lock usability snapshot: isActive/expiry/scope can change
    // under a concurrent serialized mutation, so a target that merely looks unusable here must not
    // skip the critical section. A non-admin target genuinely cannot strand the system.
    if (apiKey.role === ApiKeyRole.ADMIN) {
      await this.adminCapabilityLock.run(AuthService.ADMIN_CAPABILITY_LOCK_KEY, removeKey);
    } else {
      await removeKey();
    }
    this.evictActiveSockets(id, 'deleted');
    this.logger.log(`API key deleted: ${apiKey.name}`, {
      keyId: id,
      action: 'api_key_deleted',
    });
  }

  async revoke(id: string): Promise<ApiKey> {
    const apiKey = await this.findOne(id);
    const revokeKey = async (): Promise<ApiKey> => {
      // Re-read inside the critical section (same staleness hazard as update()).
      const target = await this.findOne(id);
      await this.assertNotLastUsableAdmin(target);
      // A revoked key fails validation before its next flush, so its accumulator would orphan —
      // drop it here.
      this.usageTracker.forget(id);
      target.isActive = false;
      const saved = await this.apiKeyRepository.save(target);
      this.removeBootstrapKeyFileIfMatching(target);
      return saved;
    };
    // Same reasoning as delete(): the lock predicate is the stable role, not a snapshot of usability.
    const saved =
      apiKey.role === ApiKeyRole.ADMIN
        ? await this.adminCapabilityLock.run(AuthService.ADMIN_CAPABILITY_LOCK_KEY, revokeKey)
        : await revokeKey();
    // Kick any WebSocket connections already authenticated with this key: without this, a revoked
    // key keeps receiving events on already-subscribed sockets until they happen to disconnect.
    this.evictActiveSockets(id, 'revoked');
    return saved;
  }

  /**
   * "Usable admin" for the last-admin invariant: an active, unexpired ADMIN key with NO session
   * scope. The key-lifecycle routes are fenced behind @RequireUnscopedKey (AuthController), so a
   * session-scoped admin can authenticate but can never manage keys — counting it as a surviving
   * admin would bless the removal of the last key that actually can, a permanent management
   * lockout with no in-band recovery (the boot seed only fires on an EMPTY table, not on zero
   * unscoped admins).
   */
  private static isUsableAdmin(key: ApiKey, now = new Date()): boolean {
    return (
      key.role === ApiKeyRole.ADMIN &&
      key.isActive &&
      (!key.expiresAt || key.expiresAt > now) &&
      (!key.allowedSessions || key.allowedSessions.length === 0)
    );
  }

  private async assertNotLastUsableAdmin(target: ApiKey): Promise<void> {
    const now = new Date();
    if (!AuthService.isUsableAdmin(target, now)) return;

    // Match isUsableAdmin at the SQL level: only UNSCOPED admins count. The simple-array column
    // stores an empty array as '' (rows updated with allowedSessions: [] hold exactly that), so
    // "no session scope" is NULL or '' — IsNull() alone would miss the '' rows.
    const otherUsableAdmins = await this.apiKeyRepository.count({
      where: [
        { id: Not(target.id), role: ApiKeyRole.ADMIN, isActive: true, expiresAt: IsNull(), allowedSessions: IsNull() },
        { id: Not(target.id), role: ApiKeyRole.ADMIN, isActive: true, expiresAt: IsNull(), allowedSessions: Equal('') },
        {
          id: Not(target.id),
          role: ApiKeyRole.ADMIN,
          isActive: true,
          expiresAt: MoreThan(now),
          allowedSessions: IsNull(),
        },
        {
          id: Not(target.id),
          role: ApiKeyRole.ADMIN,
          isActive: true,
          expiresAt: MoreThan(now),
          allowedSessions: Equal(''),
        },
      ],
    });
    if (otherUsableAdmins === 0) {
      throw new ConflictException('Cannot remove the last active admin key');
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
    const apiKey = await this.apiKeyRepository.findOne({ where: { keyHash } });

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
