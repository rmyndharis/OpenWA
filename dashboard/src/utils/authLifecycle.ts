// Auth-lifecycle helpers: logout cleanup and startup re-validation decisions.

import type { UserRole } from '../types/role';

const USER_ROLES: readonly UserRole[] = ['admin', 'operator', 'viewer'];

export const ACTIVE_API_KEY_ID_STORAGE_KEY = 'openwa_api_key_id';
export const LEGACY_API_KEY_STORAGE_KEY = 'openwa_api_key';
export const DASHBOARD_CSRF_HEADER = 'X-Requested-With';
export const DASHBOARD_CSRF_HEADER_VALUE = 'OpenWA-Dashboard';
export const AUTH_SYNC_CHANNEL_NAME = 'openwa_auth';
export const AUTH_SYNC_STORAGE_KEY = 'openwa_auth_sync';

export interface AuthSyncEvent {
  type: 'logout' | 'login';
  apiKeyId?: string;
  at: number;
  senderId?: string;
}

const AUTH_SYNC_TAB_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function parseAuthSyncEvent(raw: unknown): AuthSyncEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { type?: unknown; apiKeyId?: unknown; at?: unknown; senderId?: unknown };
  if (candidate.type !== 'logout' && candidate.type !== 'login') return null;
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null;
  const event: AuthSyncEvent = { type: candidate.type, at: candidate.at };
  if (candidate.type === 'login' && typeof candidate.apiKeyId === 'string' && candidate.apiKeyId.length > 0) {
    event.apiKeyId = candidate.apiKeyId;
  }
  if (typeof candidate.senderId === 'string' && candidate.senderId.length > 0) {
    event.senderId = candidate.senderId;
  }
  return event;
}

/**
 * Broadcast a secret-free session lifecycle event (logout or login with non-secret apiKeyId) to
 * sibling dashboard tabs via BroadcastChannel with a localStorage storage-event fallback.
 */
export function broadcastAuthEvent(event: { type: 'logout' | 'login'; apiKeyId?: string }): void {
  const payload: AuthSyncEvent = {
    type: event.type,
    ...(event.type === 'login' && event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    at: Date.now(),
    senderId: AUTH_SYNC_TAB_ID,
  };
  if (typeof BroadcastChannel === 'function') {
    try {
      const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL_NAME);
      channel.postMessage(payload);
      channel.close();
    } catch {
      // Ignore environments where BroadcastChannel is unavailable or restricted.
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(AUTH_SYNC_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage may be unavailable or full; BroadcastChannel already notified peers.
    }
  }
}

/**
 * Subscribe to secret-free cross-tab auth lifecycle events, ignoring self-originated echoes and
 * deduplicating messages delivered via both BroadcastChannel and the localStorage storage event.
 */
export function subscribeAuthEvents(onEvent: (event: AuthSyncEvent) => void): () => void {
  let lastKey = '';
  const deliver = (raw: unknown) => {
    const parsed = parseAuthSyncEvent(raw);
    if (!parsed || parsed.senderId === AUTH_SYNC_TAB_ID) return;
    const key = `${parsed.type}:${parsed.apiKeyId ?? ''}:${parsed.at}`;
    if (key === lastKey) return;
    lastKey = key;
    onEvent(parsed);
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(AUTH_SYNC_CHANNEL_NAME);
      channel.onmessage = (msg: MessageEvent) => deliver(msg.data);
    } catch {
      channel = null;
    }
  }

  const onStorage = (e: StorageEvent) => {
    if (e.key !== AUTH_SYNC_STORAGE_KEY || !e.newValue) return;
    try {
      deliver(JSON.parse(e.newValue));
    } catch {
      // Ignore malformed storage entries.
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  return () => {
    channel?.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** Remove any legacy plaintext API key left in sessionStorage by older dashboard builds. */
export function clearLegacyApiKeyStorage(): void {
  sessionStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
}

/** Read the non-secret UUID of the API key backing the current browser session, or null. */
export function getActiveApiKeyId(): string | null {
  return sessionStorage.getItem(ACTIVE_API_KEY_ID_STORAGE_KEY);
}

/** Persist or clear the non-secret UUID of the API key backing the current browser session. */
export function setActiveApiKeyId(apiKeyId: string | null): void {
  if (apiKeyId) {
    sessionStorage.setItem(ACTIVE_API_KEY_ID_STORAGE_KEY, apiKeyId);
  } else {
    sessionStorage.removeItem(ACTIVE_API_KEY_ID_STORAGE_KEY);
  }
}

/** Clear all non-secret session metadata and any legacy API key from tab storage. */
export function clearSessionMetadata(): void {
  sessionStorage.removeItem(ACTIVE_API_KEY_ID_STORAGE_KEY);
  sessionStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  sessionStorage.removeItem('openwa_user_role');
  sessionStorage.removeItem('openwa_engine_type');
  sessionStorage.removeItem('openwa_key_scoped');
}

/** Structural cache surface (a TanStack QueryClient satisfies this) so tests can use a stub. */
export interface ClearableCache {
  clear(): void;
}

/**
 * Drop every piece of actor-scoped cached state on logout. The React Query cache is keyed by
 * resource, not by actor; without a full clear, logout -> login in the same tab with a
 * different key/scope renders the previous actor's sessions/messages/apiKeys/audit rows.
 */
export function clearActorState(...caches: ClearableCache[]): void {
  for (const cache of caches) cache.clear();
}

/**
 * Captures the active session actor id now and returns a check that holds only while it is still
 * the active one. Logout cancels nothing in flight, so a download or import started before it must
 * not commit once the session is gone or another sign-in has replaced it.
 */
export function keepsSameKey(): () => boolean {
  const actorId = getActiveApiKeyId();
  return () => getActiveApiKeyId() === actorId;
}

const IP_REFUSALS: ReadonlySet<string> = new Set(['IP address not allowed', 'Client IP could not be determined']);

/**
 * True when a response proves the active browser session cannot be used from this client, so the
 * dashboard must log out: a 401, or a 403 because the key's allowedIps refuse this client (the IP
 * can change mid-session). A role or scope 403 leaves the session usable for other requests.
 */
export function isKeyUnusable(status: number, message: unknown): boolean {
  return status === 401 || (status === 403 && typeof message === 'string' && IP_REFUSALS.has(message));
}

export type StartupValidation =
  | { action: 'role'; role: UserRole; scoped: boolean; engineType?: string; apiKeyId?: string }
  | { action: 'logout' }
  | { action: 'keep' };

/**
 * Fold the startup GET /auth/session answer into an auth decision:
 * - 401/403 (missing, expired, revoked, or IP-restricted session) -> full logout.
 * - any other non-ok status (429 rate limit, 5xx, a proxy error page) -> keep the cached role:
 *   a transient failure proves nothing about the session, so it must not eject the user.
 * - ok + role -> refresh the cached role from the server (a demoted key must lose its old powers),
 *   along with its session scope, engine, and non-secret apiKeyId.
 * - anything else (unexpected body shape) -> keep the cached role.
 */
export function resolveStartupValidation(
  status: number,
  body: { valid?: boolean; role?: string; engineType?: string; scoped?: unknown; apiKeyId?: unknown } | null,
): StartupValidation {
  if (status === 401 || status === 403) return { action: 'logout' };
  if (status < 200 || status >= 300) return { action: 'keep' };
  if (body?.valid && isUserRole(body.role)) {
    const decision: StartupValidation = { action: 'role', role: body.role, scoped: body.scoped === true };
    if (typeof body.engineType === 'string') decision.engineType = body.engineType;
    if (typeof body.apiKeyId === 'string' && body.apiKeyId.length > 0) decision.apiKeyId = body.apiKeyId;
    return decision;
  }
  return { action: 'keep' };
}
