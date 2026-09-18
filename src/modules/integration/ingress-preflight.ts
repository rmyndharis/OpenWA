import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import type { IngressRouteDescriptor } from './ingress.service';

export type PreflightRejection = { status: number; body: string; headers?: Record<string, string> };

/**
 * Retry-After on the session-alive 503. Presence is what buys the retry: the provider dispatchers that
 * matter re-attempt a 503 only when the header is set and do not parse its value (supabase/auth checks
 * `Get("retry-after") != ""`). A session that is merely still coming up already passes through to the
 * normal 202 + enqueue path, so a rejection means no live engine or FAILED, and what bounds a provider
 * hammering a dead session is InstanceThrottlerGuard's per-instance bucket, not this number.
 */
const PREFLIGHT_RETRY_AFTER_SECONDS = 5;

/**
 * Evaluates a route's host-side preflight checks. Returns null to PASS (proceed to dedup + ack + enqueue),
 * or a `{status, body}` to REJECT synchronously. Runs AFTER signature verify and BEFORE the dedup persist
 * (see IngressService.handle) — a rejection therefore writes no dedup row, so a provider retry on the 5xx
 * is treated as new (this is what avoids the dedup trap).
 *
 * `session-alive`: skipped for wildcard (null/'*') scopes and when sessionStatus is unwired; rejects 503
 * only when the concrete session has no live engine or is EngineStatus.FAILED. Recoverable statuses and
 * READY pass through to the normal 202+enqueue path so the worker can fail fast and the delivery stays durable.
 */
export function evaluatePreflight(
  route: IngressRouteDescriptor,
  sessionScope: string | null,
  sessionStatus: ((scope: string) => EngineStatus | undefined) | undefined,
): PreflightRejection | null {
  const checks = route.response?.preflight;
  if (!checks?.length) return null;
  for (const check of checks) {
    if (check.type === 'session-alive') {
      if (!sessionScope || sessionScope === '*') continue; // wildcard: no single session to probe
      if (!sessionStatus) continue; // unwired (pure unit mode): skip rather than false-reject
      const status = sessionStatus(sessionScope);
      if (status === undefined || status === EngineStatus.FAILED) {
        // Attached at the return site, not to every rejection: a future non-retryable check must not
        // inherit a header that tells the provider to come back.
        return {
          status: 503,
          body: 'session not ready',
          headers: { 'Retry-After': String(PREFLIGHT_RETRY_AFTER_SECONDS) },
        };
      }
    }
  }
  return null;
}
