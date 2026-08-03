// Which lifecycle actions a session card offers, extracted for direct unit testing (dashboard tests
// cover pure utils only).

import type { Session } from '../services/api.ts';

// Stop, Unlink and Force-Kill share one precondition: the gateway holds a live engine to act on.
// Start has the exact complement — it answers 400 while one exists. So all four derive from the
// gateway's own `engineLoaded`, which is read from the live engine map per request. Deriving them
// from `status` cannot be made correct: `disconnected` covers BOTH a session mid automatic-reconnect
// (engine registered, Start 400s) and one stopped through stop() (no engine, Start is the right
// action), and those are the same status.
//
// The fallback below is for a dashboard talking to a gateway that predates the field. It reproduces
// the old status set, whose known wrong answer is exactly that `disconnected` case — a stale
// dashboard keeps the old behaviour instead of guessing differently.
const STARTED_STATUSES_FALLBACK = new Set(['initializing', 'qr_ready', 'authenticating', 'ready', 'action_required']);

export function isSessionStarted(session: Pick<Session, 'status' | 'engineLoaded'>): boolean {
  return session.engineLoaded ?? STARTED_STATUSES_FALLBACK.has(session.status);
}

// Unlink calls POST /sessions/:id/logout, which needs a live engine to send the unlink through — the
// same precondition as Stop, and what the API's own 400 tells the operator.
export function canUnlinkSession(session: Pick<Session, 'status' | 'engineLoaded'>, canWrite: boolean): boolean {
  return canWrite && isSessionStarted(session);
}

// Force-kill is the emergency hatch for a WEDGED engine, so it is offered exactly when a live engine
// exists. That excludes FAILED: a terminal failure already evicted the engine, so there is nothing
// left to kill — the card offers reconnect/manual start instead. It now INCLUDES a `disconnected`
// session still holding an engine through its reconnect backoff, which is precisely the wedged case
// the button exists for and which the status-only rule used to hide.
export function canForceKillSession(session: Pick<Session, 'status' | 'engineLoaded'>, canWrite: boolean): boolean {
  return canWrite && isSessionStarted(session);
}

// Replace the row matching `updated.id` with the EXACT authoritative response object. The original
// defect was that the page discarded the API response and fabricated `{ status: 'disconnected' }`,
// losing server-owned fields (phone:null, timestamps). Returning the exact object — never a merge —
// is what keeps the local view byte-for-byte with the server's authoritative state.
export function replaceSession(sessions: Session[], updated: Session): Session[] {
  return sessions.map(s => (s.id === updated.id ? updated : s));
}

// The gateway's own stable code SESSION_LOGOUT_INCOMPLETE is the only signal that the session stopped
// locally while the unlink operation stayed incomplete. A reverse-proxy 502 — bare or a JSON body
// without that exact code — must stay generic: the request may never have reached the gateway, so
// nothing was stopped and the "start and retry the logout" guidance would be actively wrong. The code
// is carried on the thrown API error (see services/api.ts), not inferred from a message heuristic.
export function classifyUnlinkError(err: unknown): 'incomplete' | 'generic' {
  const e = err as { code?: string } | null | undefined;
  return e?.code === 'SESSION_LOGOUT_INCOMPLETE' ? 'incomplete' : 'generic';
}
