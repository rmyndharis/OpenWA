// Auth-lifecycle helpers: logout cleanup and startup re-validation decisions.

import type { UserRole } from '../types/role';

const USER_ROLES: readonly UserRole[] = ['admin', 'operator', 'viewer'];

function isUserRole(value: unknown): value is UserRole {
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
 */
export function clearActorState(...caches: ClearableCache[]): void {
  for (const cache of caches) cache.clear();
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
