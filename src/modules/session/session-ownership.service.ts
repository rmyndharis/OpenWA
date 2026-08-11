import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { Session } from './entities/session.entity';
import { createLogger } from '../../common/services/logger.service';
import { DateTransformer } from '../../common/transformers/date.transformer';

/**
 * Bind a lease timestamp the way the column stores it.
 *
 * Raw SQL bypasses the column's transformer, and the stored form is not a Date on every dialect —
 * SQLite keeps an ISO string — so an untransformed parameter compares against the wrong
 * representation and the clause silently never matches.
 */
function leaseParam(at: Date): string | Date {
  // `to` is declared to accept a nullable Date and so returns a nullable union; a real Date always
  // comes back as one of the two stored forms.
  return (DateTransformer.to(at) as string | Date | null) ?? at;
}

/**
 * Who currently hosts each session's engine.
 *
 * A session's engine runs in exactly one process. Nothing recorded which, so a booting process had
 * to assume every active-looking session was its own leftover and reset it — correct while there is
 * only one process, and destructive the moment a second one boots beside a live peer.
 *
 * The claim is a lease rather than a lock. A process that dies without releasing would otherwise
 * strand its sessions forever, so a claim simply stops being honoured once it goes unrenewed; a
 * running owner keeps extending it. That makes recovery automatic and bounded by the TTL instead of
 * conditional on a clean shutdown.
 *
 * NOTE: this establishes ownership. It does not yet route a request to the owning node, nor fence
 * every lifecycle path — see the horizontal-scaling documentation for what remains.
 */
@Injectable()
export class SessionOwnershipService {
  private readonly logger = createLogger('SessionOwnershipService');
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Sessions this process believes it owns, so the heartbeat knows what to renew. */
  private readonly owned = new Set<string>();
  /** Notified when a renewal proves this process no longer holds sessions it thought it did. */
  private onLeaseLost?: (sessionIds: string[]) => Promise<void> | void;

  /**
   * How many callers are currently telling renew() that an empty/blank result is NOT evidence of
   * loss. A counter rather than a flag so overlapping spans cannot resume each other early.
   */
  private lossDetectionSuspended = 0;
  /** Answers "does anything still run for this id here?" — consulted by renew(). See setEngineLiveness. */
  private engineLiveness?: (sessionId: string) => boolean;

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /**
   * This process's identity, stable across restarts.
   *
   * Deliberately not tied to the pid: a restarted process must recognise its own previous rows in
   * order to reset them, and a pid never matches after a restart. The hostname is stable for the
   * lifetime of a container or a host; where that is not the right boundary, `NODE_ID` overrides it.
   */
  get nodeId(): string {
    return this.configService?.get<string>('session.nodeId') || process.env.NODE_ID || hostname();
  }

  /** Where this node answers HTTP for peers; empty when the operator has not configured routing. */
  get nodeUrl(): string {
    return this.configService?.get<string>('session.nodeUrl') || process.env.NODE_URL || '';
  }

  private get leaseTtlMs(): number {
    return this.configService?.get<number>('session.leaseTtlMs') ?? 60_000;
  }

  private get heartbeatMs(): number {
    return this.configService?.get<number>('session.leaseHeartbeatMs') ?? 20_000;
  }

  /**
   * A session is takeable when nobody holds it, when this process already holds it, or when the
   * holder's lease has lapsed. Expressed as a `where` fragment so the same rule drives the boot
   * reset, the auto-start scan and the claim itself — three places that must not disagree.
   */
  claimableWhere(now = new Date()): Array<Record<string, unknown>> {
    return [{ nodeId: IsNull() }, { nodeId: this.nodeId }, { leaseExpiresAt: LessThan(now) }];
  }

  /** Session ids this process may take over, out of the ones given. */
  async claimable(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.sessions.find({
      where: this.claimableWhere().map(clause => ({ ...clause, id: In(ids) })),
      select: { id: true },
    });
    return rows.map(row => row.id);
  }

  /**
   * Take ownership, returning false when another live process holds it.
   *
   * The update is conditional on the same predicate the read used, so two processes racing on the
   * same free session cannot both succeed: the second one's UPDATE matches no row, because the
   * first has already written its own `nodeId` and a future expiry. Deciding on the read alone
   * would let both pass.
   */
  async claim(sessionId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.sessions
      .createQueryBuilder()
      .update(Session)
      .set({
        nodeId: this.nodeId,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs),
        nodeUrl: this.nodeUrl || null,
      })
      .where('id = :id', { id: sessionId })
      // Without leaseParam this clause would silently never match, so an expired claim would never
      // be taken over — stranding every session a crashed process was holding.
      .andWhere('("nodeId" IS NULL OR "nodeId" = :me OR "leaseExpiresAt" < :now)', {
        me: this.nodeId,
        now: leaseParam(now),
      })
      .execute();

    const claimed = (result.affected ?? 0) > 0;
    if (claimed) this.owned.add(sessionId);
    else this.logger.warn('Session is held by another node', { sessionId, nodeId: this.nodeId });
    return claimed;
  }

  /**
   * Give a session up, so a peer can take it without waiting for the lease to lapse.
   *
   * Clears a LAPSED foreign claim too, on the same predicate `claim()` uses. A deliberate teardown
   * (stop/logout/delete) of a session whose crashed owner's lease has expired must actually leave
   * it down: a row still naming the dead node reads as an abandoned orphan to the takeover sweep,
   * which would adopt and restart the session the operator just stopped. A LIVE foreign claim is
   * left alone — releasing that would strand a peer's running engine.
   */
  async release(sessionId: string): Promise<void> {
    const now = new Date();
    this.owned.delete(sessionId);
    await this.sessions
      .createQueryBuilder()
      .update(Session)
      .set({ nodeId: null, claimedAt: null, leaseExpiresAt: null, nodeUrl: null })
      .where('id = :id', { id: sessionId })
      .andWhere('("nodeId" = :me OR "leaseExpiresAt" < :now)', { me: this.nodeId, now: leaseParam(now) })
      .execute();
  }

  /** Release everything this process holds, on the way down. */
  async releaseAll(): Promise<void> {
    const ids = [...this.owned];
    this.owned.clear();
    if (ids.length === 0) return;
    await this.sessions
      .createQueryBuilder()
      .update(Session)
      .set({ nodeId: null, claimedAt: null, leaseExpiresAt: null, nodeUrl: null })
      .where({ id: In(ids), nodeId: this.nodeId })
      .execute();
    this.logger.log(`Released ${ids.length} session claim(s) on shutdown`, { nodeId: this.nodeId });
  }

  /** Begin renewing this process's leases. Idempotent. */
  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.renew();
    }, this.heartbeatMs);
    // Never hold the process open: a lease that stops being renewed is exactly what shutdown means.
    this.heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * Register what to do about a session this process has lost.
   *
   * Losing a lease is not an abstract bookkeeping event: a peer is now free to claim the session,
   * and if this process keeps its engine running there are two engines on one WhatsApp account —
   * the exact outcome the claim exists to prevent. The handler is how the engine gets torn down.
   */
  onLeaseLoss(handler: (sessionIds: string[]) => Promise<void> | void): void {
    this.onLeaseLost = handler;
  }

  /**
   * Tell renew() that "this node no longer holds the row" is currently uninformative, and get back
   * the release. Held by a replace-all data import across its whole transaction.
   *
   * Why it is needed: on SQLite every TypeORM query runner shares ONE connection, so a heartbeat
   * tick can execute INSIDE the import's open transaction, after its DELETE and before its
   * re-inserts commit, and see no rows at all. Concluding loss there tears down engines that never
   * stopped — and does so even when the import later rolls back and every row comes straight back.
   *
   * Returns a release rather than exposing a resume(), so the count cannot be unbalanced by a caller
   * that forgets which spans it opened; releasing the same token twice is a no-op.
   */
  suspendLossDetection(): () => void {
    this.lossDetectionSuspended++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.lossDetectionSuspended--;
    };
  }

  /**
   * Register the probe renew() consults before extending a lease. Wired by SessionService to the
   * engine lifecycle (engine registered, start in flight, or reconnect pending). Optional like the
   * lease-loss handler: without it every held claim renews unconditionally.
   */
  setEngineLiveness(probe: (sessionId: string) => boolean): void {
    this.engineLiveness = probe;
  }

  /**
   * Push every held lease out by another TTL, and find out whether any were lost.
   *
   * A lease can lapse while this process is perfectly healthy — a slow query or a long pause is
   * enough — after which a peer may legitimately take the session. Renewal is therefore also the
   * moment to notice, because it is the only regular contact with the row.
   */
  async renew(): Promise<void> {
    const held = [...this.owned];
    if (held.length === 0) return;

    // Only claims that still cover something alive on this process are pushed out. A claim whose
    // engine is gone (a failed start, an exhausted reconnect) must be allowed to lapse — renewing
    // it unconditionally pinned such sessions to this node forever: unstartable on any peer and
    // invisible to the takeover sweep, which only sees lapsed leases. The id stays in `owned` so
    // the loss is still noticed below once a peer actually takes the row.
    const live = this.engineLiveness ? held.filter(id => this.engineLiveness!(id)) : held;

    let kept: Set<string>;
    try {
      if (live.length > 0) {
        await this.sessions
          .createQueryBuilder()
          .update(Session)
          .set({ leaseExpiresAt: new Date(Date.now() + this.leaseTtlMs) })
          .where({ id: In(live), nodeId: this.nodeId })
          .execute();
      }
      const rows = await this.sessions.find({ where: { id: In(held), nodeId: this.nodeId }, select: { id: true } });
      kept = new Set(rows.map(row => row.id));
    } catch (error) {
      // A failed renewal is survivable — the next tick tries again, and the TTL is long enough to
      // absorb a transient database blip. Crucially it must NOT be read as having lost anything:
      // concluding loss from a failed query would tear down every healthy engine on this node the
      // first time the database hiccuped, which is far worse than a late renewal.
      this.logger.warn('Failed to renew session leases', {
        nodeId: this.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Re-checked HERE, after the queries above rather than only at entry: the tick this protects
    // against is precisely one that was already in flight when the import took the token, so an
    // entry-only check would let it through. Renewing was harmless; concluding loss is not.
    if (this.lossDetectionSuspended > 0) return;

    const lost = held.filter(id => !kept.has(id));
    if (lost.length === 0) return;
    for (const id of lost) this.owned.delete(id);
    this.logger.warn(`Lost the claim on ${lost.length} session(s); another node now holds them`, {
      nodeId: this.nodeId,
      sessionIds: lost,
    });
    try {
      await this.onLeaseLost?.(lost);
    } catch (error) {
      // Renewal is driven by an interval, so a throwing handler would surface as an unhandled
      // rejection and could stop the loop entirely. The sessions are already out of `owned`, so the
      // bookkeeping is consistent either way — what a failure here means is that an engine may
      // still be running for a session this node no longer owns, which is worth an error rather
      // than a crash.
      this.logger.error('Failed to release engines for lost sessions', error instanceof Error ? error.stack : '', {
        nodeId: this.nodeId,
        sessionIds: lost,
      });
    }
  }

  /** For the boot reset, which must run before anything is claimed. */
  ownedByOtherLiveNode(session: Pick<Session, 'nodeId' | 'leaseExpiresAt'>, now = new Date()): boolean {
    if (!session.nodeId || session.nodeId === this.nodeId) return false;
    return session.leaseExpiresAt != null && session.leaseExpiresAt > now;
  }

  /**
   * Sessions another node held whose lease has lapsed — a crashed peer, or this node's own
   * previous identity after a container recreate (the default nodeId is the hostname, which a
   * recreate changes). These are the adoptable orphans the takeover sweep starts here; a
   * deliberately released session (stop, graceful shutdown) has `nodeId` NULL and is not one.
   */
  async lapsedHeldByOthers(now = new Date()): Promise<Session[]> {
    return this.sessions
      .createQueryBuilder('session')
      .where('"nodeId" IS NOT NULL AND "nodeId" <> :me', { me: this.nodeId })
      .andWhere('"leaseExpiresAt" < :now', { now: leaseParam(now) })
      .getMany();
  }

  /**
   * Session ids another node currently holds on a live lease.
   *
   * For operations that can only act on this process's own engines and would otherwise report
   * success over work they never touched.
   */
  /**
   * Whether ONE session is held by another node on a live lease.
   *
   * The scoped counterpart of {@link heldByOtherNodes}, for the lifecycle verbs that act on a single
   * id: they only need this answer, and scanning every claim to get it would grow with the whole
   * deployment. A LAPSED foreign claim reads false — the holder may be gone, and taking over is
   * exactly what the claim rule allows.
   */
  async isHeldByOtherNode(sessionId: string, now = new Date()): Promise<boolean> {
    const count = await this.sessions
      .createQueryBuilder('session')
      .where('id = :id', { id: sessionId })
      .andWhere('"nodeId" IS NOT NULL AND "nodeId" <> :me', { me: this.nodeId })
      .andWhere('"leaseExpiresAt" > :now', { now: leaseParam(now) })
      .getCount();
    return count > 0;
  }

  async heldByOtherNodes(now = new Date()): Promise<string[]> {
    const rows = await this.sessions
      .createQueryBuilder('session')
      .select('session.id', 'id')
      .where('"nodeId" IS NOT NULL AND "nodeId" <> :me', { me: this.nodeId })
      .andWhere('"leaseExpiresAt" > :now', { now: leaseParam(now) })
      .getRawMany<{ id: string }>();
    return rows.map(row => row.id);
  }

  /** Test seam: what this process currently believes it holds. */
  ownedIds(): string[] {
    return [...this.owned];
  }

  /**
   * Does THIS process still hold `sessionId`? Synchronous and in-memory on purpose.
   *
   * Callers are engine callbacks on the hot path that must not introduce an await: an extra
   * suspension point there would re-open the very retirement race the surrounding `isLiveEngine`
   * fence closes. The in-memory set is also the right authority here — it is what `renew()` clears
   * the moment it observes the claim is gone, which is exactly the transition this answers.
   *
   * The two fences are orthogonal and both are needed. `isLiveEngine` asks "is this engine object
   * still the registered one" (generation safety, local); this asks "may this node still speak for
   * the session at all" (ownership, cluster-wide). Between losing a lease and finishing the teardown
   * the heartbeat schedules, the first is still true while the second is already false.
   */
  owns(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }
}

/**
 * "May this node write for `sessionId`?" with the no-ownership case decided in one place.
 *
 * Exported as a function rather than inlined at the call sites because the DEFAULT is the part that
 * carries the risk. Note what it does NOT mean: SessionOwnershipService is an unconditional provider
 * in SessionModule, so a running gateway ALWAYS has one and this fence is live in single-node
 * deployments too — every started session is claimed there, so `owns()` answers truthfully. The TRUE
 * default therefore serves direct-construction specs, not production. Inverting it would silence
 * every engine-driven status write everywhere instead of fencing a few — a far worse failure than
 * the one the fence exists to prevent, and invisible without a test that pins the default.
 */
export const nodeOwnsSession = (
  ownership: Pick<SessionOwnershipService, 'owns'> | undefined,
  sessionId: string,
): boolean => !ownership || ownership.owns(sessionId);
