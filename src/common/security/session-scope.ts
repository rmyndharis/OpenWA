/**
 * Resolve the effective session filter for a scoped read. The calling key's `allowedSessions` is
 * authoritative: a request-supplied `sessionId` may only narrow WITHIN that scope, never broaden it.
 * This is the shared fix for endpoints that accept `sessionId` as a query param, which the
 * ApiKeyGuard's route-param-only fence does not cover (see audit + webhook delivery-failures).
 *
 * Returns:
 *   - `null`     → no filter; the caller queries all sessions (unrestricted key, no narrowing)
 *   - `string[]` (non-empty) → filter `sessionId IN (...)` (the whole allowlist, or a single narrowed id)
 *   - `[]`       → the requested session is outside the key's scope; the caller must return nothing
 *
 * A null/empty `allowedSessions` means "unrestricted" (e.g. an ADMIN key), mirroring the guard model.
 */
export function resolveSessionScope(
  allowedSessions: string[] | null | undefined,
  requestedSessionId?: string,
): string[] | null {
  const scoped = allowedSessions != null && allowedSessions.length > 0;
  if (scoped) {
    return requestedSessionId ? allowedSessions.filter(s => s === requestedSessionId) : allowedSessions;
  }
  return requestedSessionId ? [requestedSessionId] : null;
}
