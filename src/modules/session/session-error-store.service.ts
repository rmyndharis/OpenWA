import { Injectable } from '@nestjs/common';
import { Session, SessionStatus } from './entities/session.entity';

/**
 * The transient reason a session last failed, or what the operator must do about it.
 *
 * It is deliberately in memory and not a column: it describes the CURRENT process's attempt, and a
 * restart that clears it is correct — a session whose reason was "Chromium failed to launch" should
 * not still say so after a successful restart.
 *
 * It lives here rather than in SessionService because it was the one piece of state that crossed a
 * boundary there: eight lifecycle paths write it, and exactly one reader — the session read model —
 * consumes it. Two concerns, one map.
 *
 * Every method is SYNCHRONOUS by contract. Two writers sit in synchronous void engine callbacks, and
 * one runs three statements before an `engines.delete(id)` whose ordering the surrounding comment
 * explicitly forbids reordering. An async setter here would silently reorder that.
 */
@Injectable()
export class SessionErrorStore {
  private readonly errors = new Map<string, string>();

  /** Record why a session failed, or what it is waiting on. */
  set(sessionId: string, reason: string): void {
    this.errors.set(sessionId, reason);
  }

  /** The recorded reason, if any. `attachTo` is the projection; this is the raw read. */
  get(sessionId: string): string | undefined {
    return this.errors.get(sessionId);
  }

  /** Drop the reason — the session recovered, re-initialised, or was deleted. */
  clear(sessionId: string): void {
    this.errors.delete(sessionId);
  }

  /**
   * Populate the transient `lastError` field. A FAILED session always carries its failure reason, and
   * an ACTION_REQUIRED session carries what the operator must do (e.g. the whatsapp-web.js
   * onboarding-modal fallback, #982); any other status clears it, so a recovered session never shows
   * a stale reason even while the entry is still held.
   */
  attachTo(session: Session): Session {
    session.lastError =
      session.status === SessionStatus.FAILED || session.status === SessionStatus.ACTION_REQUIRED
        ? this.errors.get(session.id)
        : undefined;
    return session;
  }
}
