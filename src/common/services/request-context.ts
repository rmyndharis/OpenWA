/**
 * Per-request async context (today: the X-Request-ID), propagated to every log line and audit
 * record produced while handling a request. Backed by a dedicated AsyncLocalStorage instance —
 * independent of the existing plugin/hook ALS instances (multiple ALS instances coexist fine).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const requestContextStorage = new AsyncLocalStorage<{ requestId: string }>();

/** Run `fn` (and every async continuation it starts) with `requestId` as the active context. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run({ requestId }, fn);
}

/** The active request id, or `undefined` when not running inside a request scope. */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
