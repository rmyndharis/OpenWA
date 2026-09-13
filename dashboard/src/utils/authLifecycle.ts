// Auth-lifecycle helpers: logout cleanup and startup re-validation decisions.

import { queuesBoardSessionApi } from '../services/api';
import type { UserRole } from '../types/role';

const USER_ROLES: readonly UserRole[] = ['admin', 'operator', 'companion_operator', 'viewer'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** Structural cache surface (a TanStack QueryClient satisfies this) so tests can use a stub. */
export interface ClearableCache {
  clear(): void;
}

/**
 * Drop every piece of actor-scoped cached state on logout. The React Query cache is keyed by
 * resource, not by actor — without a full clear, logout → login in the same tab with a
 * different key/scope renders the previous actor's sessions/messages/apiKeys/audit rows.
 *
 * Callers that also drop `openwa_api_key` must use {@link clearLocalSession} so the board
 * DELETE still sees the key via `request()`.
 */
export function clearActorState(...caches: ClearableCache[]): void {
  for (const cache of caches) cache.clear();
  // Best-effort: drop the Bull Board embed cookie so the next actor cannot inherit it.
  void queuesBoardSessionApi.clear().catch(() => {});
}

/**
 * Full local logout cleanup: clear actor caches + Bull Board cookie while the API key is still
 * in sessionStorage (so `request()` can send `X-API-Key`), then remove the stored key.
 * Local logout always completes even if the board DELETE fails.
 */
export function clearLocalSession(...caches: ClearableCache[]): void {
  clearActorState(...caches);
  sessionStorage.removeItem('openwa_api_key');
}

export type StartupValidation = { action: 'role'; role: UserRole } | { action: 'logout' } | { action: 'keep' };

/**
 * Fold the startup /auth/validate answer into an auth decision:
 * - 401/403 (a revoked/deleted/expired key, or one whose restrictions reject this client) → full
 *   logout; the cached role is a lie.
 * - any other non-ok status (429 rate limit, 5xx, a proxy error page) → keep the cached role:
 *   a transient failure proves nothing about the key, so it must not eject the user.
 * - ok + role → refresh the cached role from the server (a demoted key must lose its old powers).
 * - anything else (unexpected body shape) → keep the cached role.
 * A network throw never reaches this function; the caller keeps the cached role for that case
 * so a transient outage at page load doesn't eject the user.
 */
export function resolveStartupValidation(
  status: number,
  body: { valid?: boolean; role?: string } | null,
): StartupValidation {
  if (status === 401 || status === 403) return { action: 'logout' };
  if (status < 200 || status >= 300) return { action: 'keep' };
  if (body?.valid && isUserRole(body.role)) return { action: 'role', role: body.role };
  return { action: 'keep' };
}
