import { HttpException, HttpStatus, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { createLogger } from '../../common/services/logger.service';
import { XenwaNumberBilling } from './entities/xenwa-number-billing.entity';
import { XenwaSessionAccess } from './entities/xenwa-session-access.entity';
import { XenwaUser } from './entities/xenwa-user.entity';
import { billingEnabled, readXenwaConfig, type XenwaConfig } from './xenwa-config';

/** Thrown when the owner's XenAI Tech balance cannot cover a charge. */
export class XenwaInsufficientCreditsException extends HttpException {
  constructor(needed: number | null, balance: number | null) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        message: `Not enough credits${needed ? ` — ${needed} needed` : ''}${
          balance !== null ? `, you have ${balance}` : ''
        }. Buy credits at xenaitech.com/dashboard/credits`,
        needed,
        balance,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export interface XenwaBillingQuote {
  enabled: boolean;
  creditsPerNumber: number;
  graceDays: number;
  balance: number | null;
}

export interface XenwaChargeResult {
  ok: boolean;
  amount: number;
  balance: number | null;
  alreadyCharged?: boolean;
}

/** Add one calendar month, clamping 31 Jan → 28/29 Feb (same rule as XenAI Mail billing). */
export function addMonth(d: Date): Date {
  const n = new Date(d);
  const day = n.getUTCDate();
  n.setUTCMonth(n.getUTCMonth() + 1);
  if (n.getUTCDate() < day) n.setUTCDate(0);
  return n;
}

/** Idempotency key for the period that starts at `periodStart`: one charge per number per period. */
export function chargeKeyFor(sessionId: string, periodStart: Date): string {
  return `xenwa:${sessionId}:${periodStart.toISOString().slice(0, 7)}`;
}

const RENEW_INTERVAL_MS = 60 * 60_000;
const QUOTE_TTL_MS = 60_000;

/**
 * Per-number monthly billing against the owner's XenAI Tech credits. XenAI Tech owns the price, the
 * grace period and the ledger (its /api/xenwa/billing endpoints); XenWA only decides WHEN a number is
 * due and keys every charge idempotently, so a retry after a timeout never charges twice.
 *
 * Inert unless XENWA_BILLING_SECRET is set: numbers are then free and nothing is paused.
 */
@Injectable()
export class XenwaBillingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('XenwaBilling');
  private config: XenwaConfig = readXenwaConfig();
  private timer?: NodeJS.Timeout;
  private running = false;
  private settingsCache?: { at: number; creditsPerNumber: number; graceDays: number };

  constructor(
    @InjectRepository(XenwaNumberBilling, 'main') private readonly billing: Repository<XenwaNumberBilling>,
    @InjectRepository(XenwaSessionAccess, 'main') private readonly access: Repository<XenwaSessionAccess>,
    @InjectRepository(XenwaUser, 'main') private readonly users: Repository<XenwaUser>,
    private readonly sessionService: SessionService,
  ) {}

  get enabled(): boolean {
    return billingEnabled(this.config);
  }

  onModuleInit(): void {
    if (!this.enabled || process.env.NODE_ENV === 'test') return;
    // First pass shortly after boot (lets the engine settle), then hourly.
    this.timer = setTimeout(() => {
      void this.renewDue();
      this.timer = setInterval(() => void this.renewDue(), RENEW_INTERVAL_MS);
      this.timer.unref?.();
    }, 90_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  // ---------------------------------------------------------------------------------------------
  // XenAI Tech billing API
  // ---------------------------------------------------------------------------------------------

  private async call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.config.billingUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.config.billingSecret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  }

  /** Price, grace period and (when a platform user id is given) that user's live balance. */
  async quote(externalUserId?: string | null): Promise<XenwaBillingQuote> {
    if (!this.enabled) return { enabled: false, creditsPerNumber: 0, graceDays: 0, balance: null };
    const cached = this.settingsCache && Date.now() - this.settingsCache.at < QUOTE_TTL_MS ? this.settingsCache : null;
    if (cached && !externalUserId) {
      return { enabled: true, creditsPerNumber: cached.creditsPerNumber, graceDays: cached.graceDays, balance: null };
    }
    try {
      const qs = externalUserId ? `?userId=${encodeURIComponent(externalUserId)}` : '';
      const { status, data } = await this.call<{ balance?: number; creditsPerNumber?: number; graceDays?: number }>(
        `/balance${qs}`,
        { method: 'GET' },
      );
      if (status !== 200) throw new Error(`billing API answered ${status}`);
      const creditsPerNumber = Number(data.creditsPerNumber ?? 10);
      const graceDays = Number(data.graceDays ?? 3);
      this.settingsCache = { at: Date.now(), creditsPerNumber, graceDays };
      return {
        enabled: true,
        creditsPerNumber,
        graceDays,
        balance: typeof data.balance === 'number' ? data.balance : null,
      };
    } catch (err) {
      this.logger.warn('XenAI Tech billing API unreachable for quote', { error: String(err) });
      return {
        enabled: true,
        creditsPerNumber: cached?.creditsPerNumber ?? this.settingsCache?.creditsPerNumber ?? 10,
        graceDays: cached?.graceDays ?? this.settingsCache?.graceDays ?? 3,
        balance: null,
      };
    }
  }

  /**
   * Charge one period. Returns ok=false (with the balance) on 402; throws on transport errors so a
   * caller never mistakes "could not reach XenAI Tech" for "not enough credits".
   */
  async charge(
    externalUserId: string,
    sessionId: string,
    chargeKey: string,
    label: string,
  ): Promise<XenwaChargeResult> {
    const { status, data } = await this.call<{
      ok?: boolean;
      amount?: number;
      balance?: number;
      alreadyCharged?: boolean;
      error?: string;
    }>('/charge', {
      method: 'POST',
      body: {
        userId: externalUserId,
        numberId: sessionId,
        chargeKey,
        description: `XenWA: ${label} — monthly number fee`,
      },
    });
    if (status === 200) {
      return {
        ok: true,
        amount: Number(data.amount ?? 0),
        balance: data.balance ?? null,
        alreadyCharged: !!data.alreadyCharged,
      };
    }
    if (status === 402) return { ok: false, amount: Number(data.amount ?? 0), balance: data.balance ?? null };
    throw new Error(`XenAI Tech billing API answered ${status}${data?.error ? `: ${data.error}` : ''}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Number lifecycle
  // ---------------------------------------------------------------------------------------------

  private async ownerOf(sessionId: string): Promise<XenwaUser | null> {
    const row = await this.access.findOne({ where: { sessionId, role: 'owner' } });
    if (!row?.userId) return null;
    return this.users.findOne({ where: { id: row.userId } });
  }

  private exempt(owner: XenwaUser | null): boolean {
    // Platform operators' own numbers are not billed.
    return !owner || this.config.adminRoles.includes(owner.platformRole);
  }

  /**
   * Charge the first month for a number just added by `owner`. Throws XenwaInsufficientCreditsException
   * on 402 (the caller deletes the half-created number). No-op when billing is off or the owner is exempt.
   */
  async chargeNewNumber(owner: XenwaUser, sessionId: string, label: string): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();
    if (this.exempt(owner)) {
      await this.billing.save(
        this.billing.create({
          sessionId,
          status: 'active',
          paidUntil: addMonth(now),
          freeReason: 'exempt',
          lastChargeCredits: 0,
        }),
      );
      return;
    }
    const key = chargeKeyFor(sessionId, now);
    const result = await this.charge(owner.externalId, sessionId, key, label);
    if (!result.ok) throw new XenwaInsufficientCreditsException(result.amount || null, result.balance);
    await this.billing.save(
      this.billing.create({
        sessionId,
        status: 'active',
        paidUntil: addMonth(now),
        lastChargedAt: now,
        lastChargeCredits: result.amount,
        lastChargeKey: key,
        freeReason: null,
        lastError: null,
      }),
    );
  }

  /**
   * Give every owned number that has no billing row yet a free first period. This is how numbers
   * that existed before billing was switched on (and numbers an admin later assigns to an owner) are
   * brought in: they are never charged or paused on day one.
   */
  async seedMissing(): Promise<number> {
    const owners = await this.access.find({ where: { role: 'owner' } });
    if (owners.length === 0) return 0;
    const ids = owners.map(o => o.sessionId);
    const have = new Set(
      (await this.billing.find({ where: { sessionId: In(ids) }, select: { sessionId: true } })).map(b => b.sessionId),
    );
    const now = new Date();
    let seeded = 0;
    for (const id of ids) {
      if (have.has(id)) continue;
      await this.billing.save(
        this.billing.create({
          sessionId: id,
          status: 'active',
          paidUntil: addMonth(now),
          freeReason: 'rollout',
          lastChargeCredits: 0,
        }),
      );
      seeded++;
    }
    if (seeded) this.logger.log(`XenWA billing: ${seeded} existing number(s) given a free first month`);
    return seeded;
  }

  /** Renew one number now. Used by the job and by the owner's "Pay now" button. */
  async renewOne(
    row: XenwaNumberBilling,
    graceDays: number,
    label?: string,
  ): Promise<'renewed' | 'failed' | 'paused' | 'skipped'> {
    const owner = await this.ownerOf(row.sessionId);
    const now = new Date();
    if (this.exempt(owner)) {
      row.paidUntil = addMonth(row.paidUntil > now ? row.paidUntil : now);
      row.freeReason = 'exempt';
      await this.billing.save(row);
      return 'renewed';
    }
    // A paused number restarts a fresh period from today; an active one continues its cycle.
    const periodStart = row.status === 'active' && row.paidUntil <= now ? row.paidUntil : now;
    const key = chargeKeyFor(row.sessionId, periodStart);
    let result: XenwaChargeResult;
    try {
      result = await this.charge(owner!.externalId, row.sessionId, key, label ?? row.sessionId);
    } catch (err) {
      row.lastError = String(err instanceof Error ? err.message : err).slice(0, 300);
      await this.billing.save(row);
      return 'skipped';
    }
    if (result.ok) {
      const wasPaused = row.status === 'paused';
      row.paidUntil = addMonth(periodStart);
      row.lastChargedAt = now;
      row.lastChargeCredits = result.amount;
      row.lastChargeKey = key;
      row.freeReason = null;
      row.lastError = null;
      row.status = 'active';
      await this.billing.save(row);
      if (wasPaused) {
        await this.sessionService.start(row.sessionId, { explicit: true }).catch(err =>
          this.logger.warn('Could not restart a resumed XenWA number', {
            sessionId: row.sessionId,
            error: String(err),
          }),
        );
      }
      return 'renewed';
    }
    row.lastError = `Not enough credits (balance ${result.balance ?? '?'}, needed ${result.amount || '?'})`;
    const graceEnd = new Date(new Date(row.paidUntil).getTime() + graceDays * 86_400_000);
    if (row.status === 'active' && graceEnd <= now) {
      row.status = 'paused';
      await this.billing.save(row);
      await this.sessionService
        .stop(row.sessionId)
        .catch(err =>
          this.logger.warn('Could not stop an unpaid XenWA number', { sessionId: row.sessionId, error: String(err) }),
        );
      return 'paused';
    }
    await this.billing.save(row);
    return 'failed';
  }

  /** The renewal job: seed rollout rows, then charge every number whose period is over. */
  async renewDue(): Promise<{ renewed: number; failed: number; paused: number }> {
    const out = { renewed: 0, failed: 0, paused: 0 };
    if (!this.enabled || this.running) return out;
    this.running = true;
    try {
      await this.seedMissing();
      const { graceDays } = await this.quote();
      const due = await this.billing
        .createQueryBuilder('b')
        .where('b.paidUntil <= :now', { now: new Date().toISOString().slice(0, 23).replace('T', ' ') })
        .getMany();
      const sessions = due.length ? await this.sessionService.findAll(due.map(d => d.sessionId)) : [];
      const existing = new Map(sessions.map(s => [s.id, s]));
      for (const row of due) {
        const session = existing.get(row.sessionId);
        if (!session) {
          await this.billing.delete({ sessionId: row.sessionId }); // number was deleted
          continue;
        }
        const r = await this.renewOne(row, graceDays, session.pushName || session.phone || session.name);
        if (r === 'renewed') out.renewed++;
        else if (r === 'paused') out.paused++;
        else if (r === 'failed') out.failed++;
      }
      if (out.renewed || out.failed || out.paused) this.logger.log('XenWA billing renewal run', out);
    } catch (err) {
      this.logger.warn('XenWA billing renewal run failed', { error: String(err) });
    } finally {
      this.running = false;
    }
    return out;
  }

  async rowsFor(sessionIds: string[]): Promise<Map<string, XenwaNumberBilling>> {
    if (!sessionIds.length) return new Map();
    const rows = await this.billing.find({ where: { sessionId: In(sessionIds) } });
    return new Map(rows.map(r => [r.sessionId, r]));
  }

  async pausedSessionIds(sessionIds: string[]): Promise<Set<string>> {
    if (!this.enabled || !sessionIds.length) return new Set();
    const rows = await this.billing.find({
      where: { sessionId: In(sessionIds), status: 'paused' },
      select: { sessionId: true },
    });
    return new Set(rows.map(r => r.sessionId));
  }

  async payNow(sessionId: string, label: string): Promise<XenwaNumberBilling> {
    if (!this.enabled) throw new HttpException('Billing is not enabled', HttpStatus.BAD_REQUEST);
    await this.seedMissing();
    const row = await this.billing.findOne({ where: { sessionId } });
    if (!row) throw new HttpException('This number has no billing record', HttpStatus.NOT_FOUND);
    if (row.status === 'active' && row.paidUntil > new Date()) return row;
    const { graceDays } = await this.quote();
    const r = await this.renewOne(row, graceDays, label);
    if (r === 'skipped')
      throw new HttpException('XenAI Tech billing is unreachable, try again shortly', HttpStatus.BAD_GATEWAY);
    if (r !== 'renewed') {
      const quote = await this.quote((await this.ownerOf(sessionId))?.externalId);
      throw new XenwaInsufficientCreditsException(quote.creditsPerNumber, quote.balance);
    }
    return (await this.billing.findOne({ where: { sessionId } }))!;
  }

  async forget(sessionId: string): Promise<void> {
    await this.billing.delete({ sessionId });
  }
}
