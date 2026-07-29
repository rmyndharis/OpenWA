// Decision logic for the Sessions page Unlink action, extracted for direct unit testing
// (dashboard tests cover pure utils only). The action calls POST /sessions/:id/logout, which:
//   - 400s when the session is not started — the unlink is a network round-trip that needs a
//     live engine, so a stopped session is rejected rather than reported as a success, and
//   - 502s when the session was stopped locally but WhatsApp did not confirm the unlink.

// Visibility mirrors Stop: only started states have a live engine to send the unlink through.
// A failed session is Kill Stuck's domain; a stopped session must be started before it can be
// unlinked (which is also what the API's 400 message tells the operator).
const UNLINKABLE_STATUSES = new Set(['ready', 'initializing', 'connecting', 'qr_ready']);

export function canUnlinkSession(status: string, canWrite: boolean): boolean {
  return canWrite && UNLINKABLE_STATUSES.has(status);
}

// The 502 case is not a plain failure: the session DID stop locally, only the confirmation from
// WhatsApp is missing — the device may still be listed under Linked Devices, and the operator
// should start the session and retry. Everything else (400/404/5xx) is a generic failure.
export function classifyUnlinkError(err: unknown): 'unconfirmed' | 'generic' {
  const status = (err as { status?: number } | null | undefined)?.status;
  return status === 502 ? 'unconfirmed' : 'generic';
}
