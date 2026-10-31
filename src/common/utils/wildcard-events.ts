/**
 * Events a '*' subscription (webhook or socket) does NOT receive; they are delivered only when named
 * explicitly. A `message.receipt` fires once per recipient (a message to a 1,000-member group yields
 * about 2,000), so folding it into '*' would multiply the traffic of every existing catch-all subscriber.
 */
export const WILDCARD_EXCLUDED_EVENTS: readonly string[] = ['message.receipt'];

/** Whether a subscription to `events` covers `event`, honouring the '*' exclusions above. */
export function subscriptionCoversEvent(events: readonly string[], event: string): boolean {
  return events.includes(event) || (events.includes('*') && !WILDCARD_EXCLUDED_EVENTS.includes(event));
}
