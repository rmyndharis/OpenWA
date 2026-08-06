/**
 * How many sessions WhatsApp is currently restricting, for the Prometheus gauge.
 *
 * A gauge and not a counter: what an operator alerts on is "an account is restricted right now", and
 * a restriction that is applied, lifted and re-applied is the same one fact recurring, not a total to
 * accumulate. It is mirrored here rather than read from the store at render time so the metrics
 * module does not have to depend on the session module for one number — `SessionRestrictionStore` is
 * the single writer and republishes its own size after every mutation.
 */
let restrictedSessions = 0;

/** Publish the current number of restricted sessions (called by SessionRestrictionStore). */
export function setRestrictedSessionCount(count: number): void {
  restrictedSessions = count;
}

/** Sessions under a WhatsApp-imposed restriction at this moment. */
export function getRestrictedSessionCount(): number {
  return restrictedSessions;
}
