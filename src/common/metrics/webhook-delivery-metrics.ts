/**
 * Process-local monotonic counter of webhook delivery failures: deliveries whose every retry was
 * exhausted, deliveries never sent (shed, refused at shutdown, rejected before sending), and direct
 * deliveries stopped by shutdown between retries after earlier attempts were sent. It is
 * incremented once per row inserted into the durable `webhook_delivery_failures` dead-letter table;
 * a later replay may replace or remove that row, and the counter keeps the failure. Kept as a plain
 * in-process counter rather than a `COUNT(*)` over that table because the table is pruned on a
 * retention schedule, which would make its count non-monotonic and therefore invalid as a
 * Prometheus `counter` (a prune would look like a counter reset to `rate()`/`increase()`). An
 * in-process counter only resets on restart, which those functions already handle correctly, and it
 * also captures the failure even when persisting the dead-letter row itself fails.
 */
let terminalFailureTotal = 0;

/** Record one webhook delivery failure, terminal or never sent. */
export function incrementWebhookDeliveryFailures(): void {
  terminalFailureTotal += 1;
}

/** Current process-lifetime total of recorded webhook delivery failures. */
export function getWebhookDeliveryFailuresTotal(): number {
  return terminalFailureTotal;
}
