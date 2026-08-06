/**
 * Sends the pacing governor refused, by the rule that refused them.
 *
 * A counter rather than a gauge: each refusal is a discrete event, and what an operator wants is the
 * rate — "we started hitting the daily cap at 14:00" — which `rate()` only answers over a monotonic
 * series. Kept in process rather than derived from a table because no row is written for a send that
 * never happened, and because a retention prune would read as a counter reset.
 */
export type SendPacingRefusalReason = 'daily_cap' | 'cold_daily_cap' | 'breaker_open';

const refusals = new Map<SendPacingRefusalReason, number>();

/** Record one refused send. */
export function incrementSendPacingRefusals(reason: SendPacingRefusalReason): void {
  refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
}

/**
 * Refusal totals by reason since process start. Reasons that have never fired are absent rather than
 * zero, matching the HTTP metrics' behaviour of emitting nothing until something is observed — a
 * series that appears at its first occurrence is easier to alert on than one pinned at zero.
 */
export function getSendPacingRefusals(): ReadonlyMap<SendPacingRefusalReason, number> {
  return refusals;
}

/** Test-only: the counters are module-global and never reset in production. */
export function resetSendPacingRefusals(): void {
  refusals.clear();
}
