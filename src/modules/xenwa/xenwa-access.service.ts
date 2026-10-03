import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { Request } from 'express';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { XenwaUser } from './entities/xenwa-user.entity';
import { XenwaSessionAccess } from './entities/xenwa-session-access.entity';
import { XenwaNumberBilling } from './entities/xenwa-number-billing.entity';
import { decideRoute, normalizePermissions, type XenwaPermission, type XenwaRequirement } from './xenwa-permissions';

export interface XenwaSessionGrant {
  role: 'owner' | 'member';
  permissions: XenwaPermission[];
}

export interface XenwaActorContext {
  user: XenwaUser;
  /** Platform operator (unscoped ADMIN key): every check below is skipped. */
  isPlatformAdmin: boolean;
  sessions: Map<string, XenwaSessionGrant>;
  /** Numbers paused for non-payment: read-only until the owner tops up. */
  paused: Set<string>;
}

/** How long a resolved context may be served from memory. Every grant write also clears it. */
const CACHE_TTL_MS = 15_000;

/**
 * Enforces XenWA per-account permissions for API keys that belong to an SSO user ("managed" keys).
 * Called by ApiKeyGuard after the key itself has been validated and its session fence passed, so the
 * key is already known to be confined to the sessions it may see; this adds the WHAT-may-it-do check.
 *
 * A key that does not belong to an SSO user (every pre-existing OpenWA key, the bootstrap admin key)
 * is untouched: the method returns immediately and the gateway behaves exactly as before.
 */
@Injectable()
export class XenwaAccessService {
  private readonly cache = new Map<string, { at: number; ctx: XenwaActorContext | null }>();

  constructor(
    @InjectRepository(XenwaUser, 'main') private readonly users: Repository<XenwaUser>,
    @InjectRepository(XenwaSessionAccess, 'main') private readonly access: Repository<XenwaSessionAccess>,
    @InjectRepository(XenwaNumberBilling, 'main') private readonly billing: Repository<XenwaNumberBilling>,
  ) {}

  /** Drop every cached context — called on any grant, revoke or sign-in so changes apply at once. */
  invalidate(): void {
    this.cache.clear();
  }

  async contextForKey(apiKey: Pick<ApiKey, 'id' | 'role' | 'allowedSessions'>): Promise<XenwaActorContext | null> {
    const hit = this.cache.get(apiKey.id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ctx;

    const user = await this.users.findOne({ where: { apiKeyId: apiKey.id } });
    let ctx: XenwaActorContext | null = null;
    if (user) {
      const rows = await this.access.find({ where: { userId: user.id } });
      const sessions = new Map<string, XenwaSessionGrant>();
      for (const row of rows) {
        sessions.set(row.sessionId, {
          role: row.role === 'owner' ? 'owner' : 'member',
          permissions:
            row.role === 'owner'
              ? normalizePermissions(['send', 'campaigns', 'contacts', 'settings'])
              : normalizePermissions(row.permissions),
        });
      }
      const unscoped = !apiKey.allowedSessions || apiKey.allowedSessions.length === 0;
      const paused = new Set<string>();
      if (sessions.size) {
        const rows = await this.billing.find({
          where: { sessionId: In([...sessions.keys()]), status: 'paused' },
          select: { sessionId: true },
        });
        for (const row of rows) paused.add(row.sessionId);
      }
      ctx = { user, sessions, paused, isPlatformAdmin: apiKey.role === ApiKeyRole.ADMIN && unscoped };
    }
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(apiKey.id, { at: Date.now(), ctx });
    return ctx;
  }

  /** Whether the context satisfies a requirement on one session. */
  static allows(ctx: XenwaActorContext, sessionId: string, requirement: XenwaRequirement): boolean {
    if (ctx.isPlatformAdmin) return true;
    const grant = ctx.sessions.get(sessionId);
    if (!grant) return false;
    // Unpaid number: everyone (owner included) may look, nobody may act, until credits are added.
    if (ctx.paused.has(sessionId) && requirement !== 'read') return false;
    if (grant.role === 'owner') return true;
    if (requirement === 'owner') return false;
    return grant.permissions.includes(requirement);
  }

  /**
   * Refuse the request unless the managed key's owner may perform it. No-op for unmanaged keys.
   * Throws ForbiddenException, which ApiKeyGuard audits like every other refusal.
   */
  async authorize(request: Request, apiKey: ApiKey, sessionId?: string): Promise<void> {
    const ctx = await this.contextForKey(apiKey);
    if (!ctx || ctx.isPlatformAdmin) return;

    const decision = decideRoute(request.method, request.path || request.url || '', sessionId);
    if (decision.kind === 'global-allowed') return;
    if (decision.kind === 'global-denied') {
      throw new ForbiddenException('This XenWA area is not available to your account');
    }
    if (!XenwaAccessService.allows(ctx, decision.sessionId, decision.requirement)) {
      if (ctx.paused.has(decision.sessionId) && ctx.sessions.has(decision.sessionId)) {
        throw new ForbiddenException(
          'This WhatsApp number is paused for non-payment. Add credits at xenaitech.com/dashboard/credits, then use "Pay now" in XenWA.',
        );
      }
      const what = decision.requirement === 'owner' ? 'the account owner' : `the "${decision.requirement}" permission`;
      throw new ForbiddenException(`This action on this WhatsApp account needs ${what}`);
    }
  }
}
