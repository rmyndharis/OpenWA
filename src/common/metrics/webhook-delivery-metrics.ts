/**
 * Process-local monotonic counter of webhook deliveries that terminally failed (every retry
 * exhausted), incremented one-for-one alongside the durable `webhook_delivery_failures` dead-letter
 * rows. Kept as a plain in-process counter rather than a `COUNT(*)` over that table because the table
 * is pruned on a retention schedule, which would make its count non-monotonic and therefore invalid
 * as a Prometheus `counter` (a prune would look like a counter reset to `rate()`/`increase()`). An
 * in-process counter only resets on restart, which those functions already handle correctly, and it
 * also captures the failure even when persisting the dead-letter row itself fails.
 */
let terminalFailureTotal = 0;

/** Record one terminal (all-retries-exhausted) webhook delivery failure. */
export function incrementWebhookDeliveryFailures(): void {
  terminalFailureTotal += 1;
}

/** Current process-lifetime total of terminal webhook delivery failures. */
export function getWebhookDeliveryFailuresTotal(): number {
  return terminalFailureTotal;
}
