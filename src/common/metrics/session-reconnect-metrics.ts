/**
 * Process-local monotonic counters for session reconnect observability, incremented one-for-one in
 * `SessionService.scheduleReconnect`. Kept as plain in-process counters rather than a `COUNT(*)` over
 * any persisted table because reconnect scheduling itself is not persisted at all — there is no
 * durable source to count, and a pruned/rotated one would be non-monotonic and therefore invalid as a
 * Prometheus `counter` (a prune would look like a counter reset to `rate()`/`increase()`). An
 * in-process counter only resets on restart, which those functions already handle correctly.
 */
let reconnectAttemptsTotal = 0;
let reconnectLoopAlertsTotal = 0;

/** Record one scheduled reconnect attempt (any session). */
export function incrementSessionReconnectAttempts(): void {
  reconnectAttemptsTotal += 1;
}

/** Current process-lifetime total of scheduled reconnect attempts. */
export function getSessionReconnectAttemptsTotal(): number {
  return reconnectAttemptsTotal;
}

/** Record one emitted reconnect-loop alert (every Nth consecutive attempt of a session). */
export function incrementSessionReconnectLoopAlerts(): void {
  reconnectLoopAlertsTotal += 1;
}

/** Current process-lifetime total of emitted reconnect-loop alerts. */
export function getSessionReconnectLoopAlertsTotal(): number {
  return reconnectLoopAlertsTotal;
}
