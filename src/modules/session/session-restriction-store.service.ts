import { Injectable } from '@nestjs/common';
import type { AccountRestriction } from '../../engine/interfaces/whatsapp-engine.interface';
import { setRestrictedSessionCount } from '../../common/metrics/session-restriction-metrics';
import { Session } from './entities/session.entity';

/**
 * Restrictions WhatsApp currently has in force on the accounts behind live sessions.
 *
 * In memory and not a column, for the same reason as {@link SessionErrorStore}: it describes what
 * the engine has observed in THIS process. The difference is that a restriction is a fact about the
 * account rather than about our attempt, so losing it on restart would matter — except that both
 * engines re-report it on the next connection (Baileys is asked directly on every connect, and
 * whatsapp-web.js re-blocks the very next link attempt), so the state re-seeds itself within one
 * session start. That self-healing is what makes the column unnecessary.
 *
 * Only ACTIVE restrictions are held: a lift removes the entry rather than storing a negative, so the
 * map's size is the count of restricted sessions and `get` returning nothing means "not restricted".
 */
@Injectable()
export class SessionRestrictionStore {
  private readonly restrictions = new Map<string, AccountRestriction>();

  /**
   * Record a restriction the engine reported.
   *
   * Returns whether this is NEW news — a change of kind or cause — which is what callers gate their
   * operator-facing signals on. Both engines repeat themselves: whatsapp-web.js re-reports the same
   * block on every reconnect attempt, and the Baileys probe re-reads the same timelock on every
   * connect, so an un-deduped webhook would fire on a loop for one unchanged fact.
   *
   * The stored entry is refreshed either way, so a re-report with a later `expiresAt` updates what
   * the API serves without being announced as a new restriction.
   */
  set(sessionId: string, restriction: AccountRestriction): boolean {
    const previous = this.restrictions.get(sessionId);
    this.restrictions.set(sessionId, restriction);
    this.publishCount();
    return previous?.kind !== restriction.kind || previous?.code !== restriction.code;
  }

  /**
   * Publish what the API would actually report: entries whose stated end has passed are no longer
   * served, so counting them would leave the gauge claiming a session is restricted while every
   * read says it is not.
   */
  private publishCount(): void {
    let inForce = 0;
    for (const sessionId of this.restrictions.keys()) {
      if (this.inForce(sessionId)) inForce++;
    }
    setRestrictedSessionCount(inForce);
  }

  /** The restriction in force, if any. `attachTo` is the projection; this is the raw read. */
  get(sessionId: string): AccountRestriction | undefined {
    return this.inForce(sessionId);
  }

  /**
   * The stored restriction, unless its stated end has passed — an expired timelock must not keep
   * badging the session until the next reconnect happens to clear it. Read-side only: the entry
   * stays stored (set/clear own the lift signal, and the engine re-report self-heals the map), it
   * just stops being reported.
   */
  private inForce(sessionId: string): AccountRestriction | undefined {
    const restriction = this.restrictions.get(sessionId);
    if (!restriction) return undefined;
    if (restriction.expiresAt != null && restriction.expiresAt <= Date.now()) return undefined;
    return restriction;
  }

  /**
   * Drop the restriction — it was lifted, or the session was restarted or deleted. Returns what was
   * dropped so the caller can report the lift with the cause that ended.
   */
  clear(sessionId: string): AccountRestriction | undefined {
    const previous = this.restrictions.get(sessionId);
    this.restrictions.delete(sessionId);
    this.publishCount();
    return previous;
  }

  /**
   * Drop the restriction only if reaching READY disproves it.
   *
   * `tos_block` and `proxy_block` are refusals of the connection itself, so a session that is now
   * linked and ready cannot still be under one. A `reachout_timelock` is not connection-scoped — the
   * account is fully connected while it applies — so READY says nothing about it and it survives
   * here, waiting for the engine's explicit lift.
   */
  clearIfDisprovedByReady(sessionId: string): AccountRestriction | undefined {
    const previous = this.restrictions.get(sessionId);
    if (!previous || previous.kind === 'reachout_timelock') return undefined;
    return this.clear(sessionId);
  }

  /** How many sessions are restricted right now — expired entries excluded, as reads are. */
  size(): number {
    let inForce = 0;
    for (const sessionId of this.restrictions.keys()) {
      if (this.inForce(sessionId)) inForce++;
    }
    return inForce;
  }

  /**
   * Populate the transient `restriction` field. Unlike `lastError` this is not conditioned on the
   * status: a reachout timelock applies to a perfectly READY session, and a connection-level block
   * is cleared by its own path rather than by whatever status the session happens to carry.
   */
  attachTo(session: Session): Session {
    session.restriction = this.inForce(session.id) ?? null;
    return session;
  }
}
