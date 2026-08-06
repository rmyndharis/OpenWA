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

/**
 * True when `sessionScope` — a resource's session binding, where null/undefined means "all
 * sessions" — falls inside the calling key's `allowedSessions`. An unrestricted key (no allowlist)
 * sees every scope; a scoped key only sees resources bound to one of its own sessions, so a null
 * scope (and the '*' wildcard) is never inside its fence. Use this on surfaces whose session
 * binding travels in the request body or in persisted rows, which the ApiKeyGuard's route-param
 * fence cannot reach (the same body/persisted-scope pattern the integration-instance controller
 * uses to confine a scoped key to instances bound inside its allowedSessions).
 */
export function sessionScopeVisible(
  allowedSessions: string[] | null | undefined,
  sessionScope: string | null | undefined,
): boolean {
  if (allowedSessions == null || allowedSessions.length === 0) return true;
  return sessionScope != null && sessionScope !== '*' && allowedSessions.includes(sessionScope);
}
