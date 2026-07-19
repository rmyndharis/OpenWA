/**
 * Per-request async context, propagated to every log line and audit record produced while handling a
 * request. Today it carries the X-Request-ID plus the resolved API key and client IP, so audit log
 * rows are stamped with who made the call and from where WITHOUT every controller having to thread
 * `@CurrentApiKey()` + `req.ip` into each `auditService.log*()` call (most call sites legitimately
 * don't know the key — they fire from deep inside services). Backed by a dedicated AsyncLocalStorage
 * instance — independent of the existing plugin/hook ALS instances (multiple ALS instances coexist fine).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /** The API key that authenticated this request, if any (@Public routes have none). */
  apiKeyId?: string;
  apiKeyName?: string;
  /** The real client IP (ProxyAwareThrottlerGuard's notion, honoring TRUSTED_PROXIES). */
  ipAddress?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` (and every async continuation it starts) with `requestId` as the active context. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run({ requestId }, fn);
}

/** The active request id, or `undefined` when not running inside a request scope. */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

/**
 * Stamp the resolved API key + client IP into the active request context so downstream audit log
 * writes (which typically happen inside services without DI access to the key) can attribute the
 * action. No-op outside a request scope (e.g. worker/cron), so callers don't need to guard. The
 * guard/middleware call this once they've resolved the key; services never need to.
 */
export function setRequestActor(actor: { apiKeyId?: string; apiKeyName?: string; ipAddress?: string }): void {
  const store = requestContextStorage.getStore();
  if (!store) return; // not in a request scope — nothing to stamp
  if (actor.apiKeyId !== undefined) store.apiKeyId = actor.apiKeyId;
  if (actor.apiKeyName !== undefined) store.apiKeyName = actor.apiKeyName;
  if (actor.ipAddress !== undefined) store.ipAddress = actor.ipAddress;
}

/** The active request's resolved actor (API key + IP), or `undefined` outside a request scope. */
export function getRequestActor(): { apiKeyId?: string; apiKeyName?: string; ipAddress?: string } | undefined {
  const store = requestContextStorage.getStore();
  if (!store) return undefined;
  return { apiKeyId: store.apiKeyId, apiKeyName: store.apiKeyName, ipAddress: store.ipAddress };
}
