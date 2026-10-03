import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { SessionService } from '../session/session.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { createLogger } from '../../common/services/logger.service';
import { XenwaUser } from './entities/xenwa-user.entity';
import { XenwaSessionAccess } from './entities/xenwa-session-access.entity';
import { XenwaSsoNonce } from './entities/xenwa-sso-nonce.entity';
import { XenwaAccessService, type XenwaActorContext } from './xenwa-access.service';
import { decryptApiKey, encryptApiKey, readXenwaConfig, ssoEnabled, type XenwaConfig } from './xenwa-config';
import { verifyXenwaSsoToken, XenwaSsoTokenError, type XenwaSsoClaims } from './xenwa-sso-token';
import { normalizePermissions, XENWA_PERMISSIONS, type XenwaPermission } from './xenwa-permissions';
import { XenwaBillingService } from './xenwa-billing.service';

/**
 * Stand-in session id for a managed key with no WhatsApp account yet. `allowedSessions` treats an
 * EMPTY list as "every session", so a user with nothing must still carry a non-empty list — one that
 * matches no real session (ids are UUIDs) and therefore fails closed everywhere.
 */
export const NO_ACCOUNT_SENTINEL = 'xenwa:no-account';

/** One-time code handed to the browser after a successful SSO post, exchanged for the API key. */
interface HandoffEntry {
  rawKey: string;
  role: ApiKeyRole;
  expiresAt: number;
}
const HANDOFF_TTL_MS = 60_000;

export interface XenwaAccountView {
  sessionId: string;
  name: string | null;
  phone: string | null;
  pushName: string | null;
  status: string | null;
  role: 'owner' | 'member' | 'admin';
  permissions: XenwaPermission[];
  ownerEmail: string | null;
  billing: {
    status: 'active' | 'paused' | 'unbilled';
    paidUntil: Date | null;
    creditsPerMonth: number;
    freeReason: string | null;
    lastError: string | null;
  } | null;
}

export interface XenwaTeamMemberView {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'owner' | 'member';
  permissions: XenwaPermission[];
  status: 'active' | 'pending';
  createdAt: Date;
}

/** The caller of a XenWA management route: an SSO user, and/or an unscoped admin key. */
export interface XenwaActor {
  apiKey: ApiKey;
  ctx: XenwaActorContext | null;
  isAdmin: boolean;
}

@Injectable()
export class XenwaService {
  private readonly logger = createLogger('XenwaService');
  private readonly handoffs = new Map<string, HandoffEntry>();
  private config: XenwaConfig = readXenwaConfig();

  constructor(
    @InjectRepository(XenwaUser, 'main') private readonly users: Repository<XenwaUser>,
    @InjectRepository(XenwaSessionAccess, 'main') private readonly access: Repository<XenwaSessionAccess>,
    @InjectRepository(XenwaSsoNonce, 'main') private readonly nonces: Repository<XenwaSsoNonce>,
    @InjectRepository(ApiKey, 'main') private readonly apiKeys: Repository<ApiKey>,
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
    private readonly accessPolicy: XenwaAccessService,
    private readonly billing: XenwaBillingService,
  ) {}

  /** Re-read the environment (tests). */
  reloadConfig(): void {
    this.config = readXenwaConfig();
  }

  publicConfig(): { ssoEnabled: boolean; platformUrl: string; ssoStartUrl: string; permissions: readonly string[] } {
    return {
      ssoEnabled: ssoEnabled(this.config),
      platformUrl: this.config.platformUrl,
      ssoStartUrl: `${this.config.platformUrl}/api/xenwa/sso`,
      permissions: XENWA_PERMISSIONS,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // SSO
  // ---------------------------------------------------------------------------------------------

  /**
   * Verify an SSO token, burn its nonce, sign the user in (creating them on first visit), and return
   * a one-time hand-off code for the dashboard. The raw API key never appears in a URL.
   */
  async consumeSsoToken(token: string): Promise<string> {
    if (!ssoEnabled(this.config)) throw new ServiceUnavailableException('XenAI Tech sign-in is not configured');

    let claims: XenwaSsoClaims;
    try {
      claims = verifyXenwaSsoToken(token, this.config.ssoSecret, this.config.audience);
    } catch (err) {
      const message = err instanceof XenwaSsoTokenError ? err.message : 'Invalid token';
      void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
        path: '/api/xenwa/sso',
        errorMessage: message,
      });
      throw new UnauthorizedException(message);
    }

    await this.burnNonce(claims);
    const { rawKey, role } = await this.signIn(claims);

    this.sweepHandoffs();
    const code = randomBytes(24).toString('base64url');
    this.handoffs.set(code, { rawKey, role, expiresAt: Date.now() + HANDOFF_TTL_MS });
    return code;
  }

  /** Exchange a one-time hand-off code for the API key (single use, 60 s). */
  exchangeHandoff(code: string): { apiKey: string; role: ApiKeyRole } {
    this.sweepHandoffs();
    const entry = typeof code === 'string' ? this.handoffs.get(code) : undefined;
    if (!entry) throw new UnauthorizedException('Sign-in link expired. Please open XenWA from XenAI Tech again.');
    this.handoffs.delete(code);
    return { apiKey: entry.rawKey, role: entry.role };
  }

  private sweepHandoffs(): void {
    const now = Date.now();
    for (const [code, entry] of this.handoffs) if (entry.expiresAt < now) this.handoffs.delete(code);
  }

  private async burnNonce(claims: XenwaSsoClaims): Promise<void> {
    // Old nonces only need to outlive the token they protected.
    await this.nonces.delete({ expiresAt: LessThan(new Date(Date.now() - 10 * 60_000)) }).catch(() => undefined);
    try {
      await this.nonces.insert({ nonce: claims.nonce, expiresAt: new Date((claims.exp + 600) * 1000) });
    } catch {
      throw new UnauthorizedException('This sign-in link was already used');
    }
  }

  private isPlatformAdminRole(role: string | undefined): boolean {
    return !!role && this.config.adminRoles.includes(role);
  }

  /** Create or update the XenWA user for these claims, claim pending invites, and hand back their key. */
  async signIn(claims: XenwaSsoClaims): Promise<{ user: XenwaUser; rawKey: string; role: ApiKeyRole }> {
    let user = await this.users.findOne({ where: { externalId: claims.sub } });
    if (!user) {
      // Same verified email, new platform id (account re-created on XenAI Tech): re-link it.
      user = await this.users.findOne({ where: { email: claims.email } });
      if (user) {
        this.logger.warn('Re-linking XenWA user to a new XenAI Tech id by verified email', { userId: user.id });
        user.externalId = claims.sub;
      }
    } else if (user.email !== claims.email) {
      // Email changed on XenAI Tech. Refuse if another XenWA user already holds the new address.
      const clash = await this.users.findOne({ where: { email: claims.email } });
      if (clash && clash.id !== user.id) throw new ConflictException('This email is linked to another XenWA account');
      user.email = claims.email;
    }
    if (!user) {
      user = this.users.create({ externalId: claims.sub, email: claims.email, platformRole: 'client' });
    }
    user.name = claims.name ?? user.name ?? null;
    user.image = claims.image ?? user.image ?? null;
    user.platformRole = claims.role ?? user.platformRole ?? 'client';
    user.lastLoginAt = new Date();
    user = await this.users.save(user);

    // Pending invites for this email become active grants.
    await this.access.update({ email: user.email, userId: IsNull() }, { userId: user.id });

    const rawKey = await this.ensureApiKey(user);
    const role = await this.syncUserKey(user);
    this.accessPolicy.invalidate();

    void this.auditService.logInfo(AuditAction.API_KEY_USED, {
      path: '/api/xenwa/sso',
      metadata: { event: 'xenwa_sso_sign_in', xenwaUserId: user.id, apiKeyId: user.apiKeyId, email: user.email },
    });
    return { user, rawKey, role };
  }

  /** Return the user's raw managed key, minting (and replacing) it when it cannot be recovered. */
  private async ensureApiKey(user: XenwaUser): Promise<string> {
    if (user.apiKeyId) {
      const existing = await this.apiKeys.findOne({ where: { id: user.apiKeyId } });
      const raw = decryptApiKey(user.apiKeyCipher, this.config.ssoSecret);
      const usable = existing && existing.isActive && (!existing.expiresAt || existing.expiresAt > new Date());
      if (usable && raw) return raw;
      // Unrecoverable or revoked by an operator: replace it. A key an admin revoked on purpose is
      // only replaced because the user proved their identity again through XenAI Tech.
      if (existing) await this.authService.delete(existing.id).catch(() => undefined);
    }
    const { apiKey, rawKey } = await this.authService.createApiKey({
      name: `XenWA SSO: ${user.email}`.slice(0, 100),
      role: ApiKeyRole.OPERATOR,
      allowedSessions: [NO_ACCOUNT_SENTINEL],
    });
    user.apiKeyId = apiKey.id;
    user.apiKeyCipher = encryptApiKey(rawKey, this.config.ssoSecret);
    await this.users.save(user);
    return rawKey;
  }

  /**
   * Bring the user's managed key in line with their grants: platform admins get an unscoped ADMIN
   * key, everyone else an OPERATOR key confined to the sessions they own or were granted. Changing
   * `allowedSessions` also disconnects their live WebSocket clients (AuthService.update), so a revoke
   * stops event delivery immediately, not only REST access.
   */
  async syncUserKey(user: XenwaUser): Promise<ApiKeyRole> {
    if (!user.apiKeyId) return ApiKeyRole.OPERATOR;
    const admin = this.isPlatformAdminRole(user.platformRole);
    const rows = admin ? [] : await this.access.find({ where: { userId: user.id } });
    const sessions = [...new Set(rows.map(r => r.sessionId))];
    const role = admin ? ApiKeyRole.ADMIN : ApiKeyRole.OPERATOR;
    try {
      await this.authService.update(user.apiKeyId, {
        role,
        allowedSessions: admin ? [] : sessions.length ? sessions : [NO_ACCOUNT_SENTINEL],
      });
    } catch (err) {
      // e.g. demoting what has become the last unscoped admin key: keep the old scope, say why.
      this.logger.warn('Could not sync XenWA user key scope', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.accessPolicy.invalidate();
    return role;
  }

  private async syncByUserId(userId: string | null): Promise<void> {
    if (!userId) return;
    const user = await this.users.findOne({ where: { id: userId } });
    if (user) await this.syncUserKey(user);
  }

  // ---------------------------------------------------------------------------------------------
  // Actor helpers
  // ---------------------------------------------------------------------------------------------

  async actorFor(apiKey: ApiKey | undefined): Promise<XenwaActor> {
    if (!apiKey) throw new UnauthorizedException('API key is required');
    const ctx = await this.accessPolicy.contextForKey(apiKey);
    const unscoped = !apiKey.allowedSessions || apiKey.allowedSessions.length === 0;
    return { apiKey, ctx, isAdmin: apiKey.role === ApiKeyRole.ADMIN && unscoped };
  }

  private requireUser(actor: XenwaActor): XenwaUser {
    if (!actor.ctx) throw new ForbiddenException('Sign in through XenAI Tech to use this feature');
    return actor.ctx.user;
  }

  private assertCanManageTeam(actor: XenwaActor, sessionId: string): void {
    if (actor.isAdmin) return;
    const grant = actor.ctx?.sessions.get(sessionId);
    if (!grant || grant.role !== 'owner') {
      throw new ForbiddenException('Only the owner of this WhatsApp account can manage its team');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Me / accounts
  // ---------------------------------------------------------------------------------------------

  async me(actor: XenwaActor) {
    const accounts = await this.accounts(actor);
    const user = actor.ctx?.user;
    const quote = await this.billing.quote(user?.externalId ?? null);
    const owned = accounts.filter(a => a.role === 'owner');
    const billed = owned.filter(a => a.billing && a.billing.creditsPerMonth > 0);
    return {
      billing: {
        enabled: quote.enabled,
        creditsPerNumber: quote.creditsPerNumber,
        graceDays: quote.graceDays,
        balance: quote.balance,
        ownedNumbers: owned.length,
        monthlyTotal: billed.reduce((sum, a) => sum + (a.billing?.creditsPerMonth ?? 0), 0),
        buyCreditsUrl: `${this.config.platformUrl}/dashboard/credits`,
      },
      managed: !!actor.ctx,
      isAdmin: actor.isAdmin,
      user: user
        ? { id: user.id, email: user.email, name: user.name, image: user.image, platformRole: user.platformRole }
        : null,
      accounts,
      limits: { maxOwnedAccounts: this.config.maxSessionsPerUser },
      ...this.publicConfig(),
    };
  }

  /** The WhatsApp accounts the caller can see, with their role and permissions on each. */
  async accounts(actor: XenwaActor): Promise<XenwaAccountView[]> {
    const views = await this.accountsWithoutBilling(actor);
    if (!this.billing.enabled || views.length === 0) return views;
    const rows = await this.billing.rowsFor(views.map(v => v.sessionId));
    const { creditsPerNumber } = await this.billing.quote();
    return views.map(v => {
      const row = rows.get(v.sessionId);
      const free = !row || row.freeReason === 'exempt';
      return {
        ...v,
        billing: row
          ? {
              status: row.status,
              paidUntil: row.paidUntil,
              creditsPerMonth: free ? 0 : creditsPerNumber,
              freeReason: row.freeReason,
              lastError: v.role === 'member' ? null : row.lastError,
            }
          : { status: 'unbilled' as const, paidUntil: null, creditsPerMonth: 0, freeReason: null, lastError: null },
      };
    });
  }

  private async accountsWithoutBilling(actor: XenwaActor): Promise<XenwaAccountView[]> {
    if (actor.isAdmin) {
      const sessions = await this.sessionService.findAll(null);
      const owners = await this.access.find({ where: { role: 'owner' } });
      const ownerBySession = new Map(owners.map(o => [o.sessionId, o.email]));
      return sessions.map(s => ({
        sessionId: s.id,
        name: s.name,
        phone: s.phone,
        pushName: s.pushName,
        status: s.status,
        role: 'admin' as const,
        permissions: [...XENWA_PERMISSIONS],
        ownerEmail: ownerBySession.get(s.id) ?? null,
        billing: null,
      }));
    }
    const user = this.requireUser(actor);
    const rows = await this.access.find({ where: { userId: user.id } });
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.sessionId);
    const sessions = await this.sessionService.findAll(ids);
    const byId = new Map(sessions.map(s => [s.id, s]));

    // Grants for accounts that no longer exist are dropped here (the gateway has no delete hook).
    const orphaned = rows.filter(r => !byId.has(r.sessionId));
    if (orphaned.length) {
      await this.access.delete({ sessionId: In(orphaned.map(r => r.sessionId)) });
      await this.syncUserKey(user);
    }
    const owners = await this.access.find({ where: { sessionId: In(ids), role: 'owner' } });
    const ownerBySession = new Map(owners.map(o => [o.sessionId, o.email]));

    return rows
      .filter(r => byId.has(r.sessionId))
      .map(r => {
        const s = byId.get(r.sessionId)!;
        return {
          sessionId: s.id,
          name: s.name,
          phone: s.phone,
          pushName: s.pushName,
          status: s.status,
          role: r.role === 'owner' ? ('owner' as const) : ('member' as const),
          permissions: r.role === 'owner' ? [...XENWA_PERMISSIONS] : normalizePermissions(r.permissions),
          ownerEmail: ownerBySession.get(s.id) ?? null,
          billing: null,
        };
      });
  }

  /** Create a WhatsApp account owned by the calling SSO user. */
  async createAccount(actor: XenwaActor, rawName: string) {
    const user = this.requireUser(actor);
    if (!actor.isAdmin) {
      const owned = await this.access.count({ where: { userId: user.id, role: 'owner' } });
      if (owned >= this.config.maxSessionsPerUser) {
        throw new ForbiddenException(`You can own up to ${this.config.maxSessionsPerUser} WhatsApp accounts`);
      }
    }
    const base = String(rawName ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (base.length < 3) throw new BadRequestException('Account name needs at least 3 letters or numbers');

    // Session names are unique across the whole gateway. Suffix instead of answering 409, which would
    // reveal that another customer already uses the name.
    let session;
    for (let attempt = 0; attempt < 5 && !session; attempt++) {
      const name = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      try {
        session = await this.sessionService.create({ name });
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;
      }
    }
    if (!session) throw new ConflictException('Could not pick a unique account name, try another');

    const ownerRow = await this.access.save(
      this.access.create({
        sessionId: session.id,
        email: user.email,
        userId: user.id,
        role: 'owner',
        permissions: null,
        grantedBy: user.id,
      }),
    );

    // First month is paid up front from the owner's XenAI Tech credits. If that fails (402, or the
    // billing API is unreachable) the half-created number is removed so nothing runs unpaid.
    try {
      await this.billing.chargeNewNumber(user, session.id, session.name);
    } catch (err) {
      await this.access.delete({ id: ownerRow.id }).catch(() => undefined);
      await this.sessionService.delete(session.id).catch(() => undefined);
      if (err instanceof HttpException) throw err;
      this.logger.warn('XenWA billing charge failed', { error: String(err) });
      throw new BadGatewayException('Could not reach XenAI Tech billing. Please try again in a minute.');
    }
    await this.syncUserKey(user);
    void this.auditService.logInfo(AuditAction.SESSION_CREATED, {
      sessionId: session.id,
      sessionName: session.name,
      metadata: { via: 'xenwa', ownerEmail: user.email },
    });
    return session;
  }

  // ---------------------------------------------------------------------------------------------
  // Team access
  // ---------------------------------------------------------------------------------------------

  private normalizeEmail(email: unknown): string {
    const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
      throw new BadRequestException('Enter a valid email address');
    }
    return value;
  }

  private async assertSessionExists(sessionId: string): Promise<void> {
    await this.sessionService.findOne(sessionId); // 404 when missing
  }

  async listTeam(actor: XenwaActor, sessionId: string): Promise<XenwaTeamMemberView[]> {
    this.assertCanManageTeam(actor, sessionId);
    await this.assertSessionExists(sessionId);
    const rows = await this.access.find({ where: { sessionId }, order: { createdAt: 'ASC' } });
    const userIds = rows.map(r => r.userId).filter((v): v is string => !!v);
    const users = userIds.length ? await this.users.find({ where: { id: In(userIds) } }) : [];
    const byId = new Map(users.map(u => [u.id, u]));
    return rows
      .map(r => {
        const u = r.userId ? byId.get(r.userId) : undefined;
        return {
          id: r.id,
          email: r.email,
          name: u?.name ?? null,
          image: u?.image ?? null,
          role: r.role === 'owner' ? ('owner' as const) : ('member' as const),
          permissions: r.role === 'owner' ? [...XENWA_PERMISSIONS] : normalizePermissions(r.permissions),
          status: r.userId ? ('active' as const) : ('pending' as const),
          createdAt: r.createdAt,
        };
      })
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
  }

  async grant(actor: XenwaActor, sessionId: string, rawEmail: unknown, rawPermissions: unknown) {
    this.assertCanManageTeam(actor, sessionId);
    await this.assertSessionExists(sessionId);
    const email = this.normalizeEmail(rawEmail);
    const permissions = normalizePermissions(rawPermissions);

    const existing = await this.access.findOne({ where: { sessionId, email } });
    if (existing?.role === 'owner') throw new BadRequestException('That person already owns this account');

    const invitee = await this.users.findOne({ where: { email } });
    const row = existing ?? this.access.create({ sessionId, email, role: 'member', grantedBy: this.actorTag(actor) });
    row.userId = invitee?.id ?? null;
    row.permissions = permissions;
    const saved = await this.access.save(row);
    await this.syncByUserId(saved.userId);
    this.accessPolicy.invalidate();
    void this.auditService.logInfo(AuditAction.API_KEY_UPDATED, {
      sessionId,
      metadata: { event: 'xenwa_team_grant', email, permissions, pending: !saved.userId },
    });
    return (await this.listTeam(actor, sessionId)).find(m => m.id === saved.id);
  }

  async updateGrant(actor: XenwaActor, sessionId: string, accessId: string, rawPermissions: unknown) {
    this.assertCanManageTeam(actor, sessionId);
    const row = await this.access.findOne({ where: { id: accessId, sessionId } });
    if (!row) throw new NotFoundException('Team member not found');
    if (row.role === 'owner') throw new BadRequestException("The owner's access cannot be changed");
    row.permissions = normalizePermissions(rawPermissions);
    await this.access.save(row);
    this.accessPolicy.invalidate();
    void this.auditService.logInfo(AuditAction.API_KEY_UPDATED, {
      sessionId,
      metadata: { event: 'xenwa_team_update', email: row.email, permissions: row.permissions },
    });
    return (await this.listTeam(actor, sessionId)).find(m => m.id === row.id);
  }

  async revoke(actor: XenwaActor, sessionId: string, accessId: string): Promise<void> {
    this.assertCanManageTeam(actor, sessionId);
    const row = await this.access.findOne({ where: { id: accessId, sessionId } });
    if (!row) throw new NotFoundException('Team member not found');
    if (row.role === 'owner') throw new BadRequestException('The owner cannot be removed; transfer ownership first');
    await this.access.delete({ id: row.id });
    // Narrow the member's key right away: REST is refused from the next request and their live
    // WebSocket clients are disconnected by AuthService.update.
    await this.syncByUserId(row.userId);
    this.accessPolicy.invalidate();
    void this.auditService.logInfo(AuditAction.API_KEY_UPDATED, {
      sessionId,
      metadata: { event: 'xenwa_team_revoke', email: row.email },
    });
  }

  /**
   * Assign (or transfer) the owner of an account by email. Admins use this to hand pre-existing
   * WhatsApp accounts to XenAI Tech users; an owner can transfer their own account. The previous
   * owner stays on the team as a member with every permission, so nobody is locked out by surprise.
   */
  async setOwner(actor: XenwaActor, sessionId: string, rawEmail: unknown) {
    this.assertCanManageTeam(actor, sessionId);
    await this.assertSessionExists(sessionId);
    const email = this.normalizeEmail(rawEmail);
    const affected = new Set<string | null>();

    const current = await this.access.findOne({ where: { sessionId, role: 'owner' } });
    if (current && current.email === email) return this.listTeam(actor, sessionId);
    if (current) {
      current.role = 'member';
      current.permissions = [...XENWA_PERMISSIONS];
      await this.access.save(current);
      affected.add(current.userId);
    }

    const invitee = await this.users.findOne({ where: { email } });
    const row =
      (await this.access.findOne({ where: { sessionId, email } })) ??
      this.access.create({ sessionId, email, grantedBy: this.actorTag(actor) });
    row.role = 'owner';
    row.permissions = null;
    row.userId = invitee?.id ?? null;
    await this.access.save(row);
    affected.add(row.userId);

    for (const userId of affected) await this.syncByUserId(userId);
    // A number handed to a (new) owner starts with a free period; it is billed from the next renewal.
    if (this.billing.enabled) await this.billing.seedMissing();
    this.accessPolicy.invalidate();
    void this.auditService.logInfo(AuditAction.API_KEY_UPDATED, {
      sessionId,
      metadata: { event: 'xenwa_owner_set', email, pending: !row.userId },
    });
    return this.listTeam(actor, sessionId);
  }

  /** Owner (or admin) pays an overdue / paused number now; resumes it when it was paused. */
  async payNow(actor: XenwaActor, sessionId: string) {
    this.assertCanManageTeam(actor, sessionId);
    const session = await this.sessionService.findOne(sessionId);
    const row = await this.billing.payNow(sessionId, session.pushName || session.phone || session.name);
    this.accessPolicy.invalidate();
    return row;
  }

  private actorTag(actor: XenwaActor): string {
    return actor.ctx?.user.id ?? `api-key:${actor.apiKey.id}`;
  }
}
