// Which lifecycle actions a session card offers, extracted for direct unit testing (dashboard tests
// cover pure utils only).

// Statuses in which the API has an engine loaded for the session. This is the single source of truth
// for the engine-backed actions — Stop and Unlink — because they share one precondition: something
// live to act on. Keeping them on one set is what stops a card from offering an action the API
// rejects, and, just as importantly, from offering Start to a session that is already started (the
// API answers 400 and the page then opens a QR modal that can never resolve).
//
// `authenticating` and `action_required` belong here: both hold a live engine — the whatsapp-web.js
// adapter can sit in `authenticating` for 90 seconds, and `action_required` means the engine is
// running but something needs a human. Without them a card in either state offered only Start.
const STARTED_STATUSES = new Set([
  'initializing',
  'connecting',
  'qr_ready',
  'authenticating',
  'ready',
  'action_required',
]);

export function isSessionStarted(status: string): boolean {
  return STARTED_STATUSES.has(status);
}

// Unlink calls POST /sessions/:id/logout, which needs a live engine to send the unlink through — the
// same precondition as Stop, and what the API's own 400 tells the operator.
export function canUnlinkSession(status: string, canWrite: boolean): boolean {
  return canWrite && isSessionStarted(status);
}

// A 502 from the gateway is not a plain failure: the session DID stop locally, only WhatsApp's
// confirmation is missing — the device may still be listed under Linked Devices, and the operator
// should start the session and retry. Everything else (400/404/other 5xx) is a generic failure.
export function classifyUnlinkError(err: unknown): 'unconfirmed' | 'generic' {
  const e = err as { status?: number; message?: string } | null | undefined;
  if (e?.status !== 502) return 'generic';
  // A reverse proxy in front of the API answers 502 as well, and then the request never reached the
  // gateway at all — nothing was stopped, so the "we stopped it, now retry the unlink" guidance would
  // be actively wrong. The API client falls back to a literal `HTTP <status>` message when the body is
  // not JSON, which is precisely the proxy case; the gateway's own 502 carries a real message.
  return e.message && !/^HTTP \d+$/.test(e.message) ? 'unconfirmed' : 'generic';
}
