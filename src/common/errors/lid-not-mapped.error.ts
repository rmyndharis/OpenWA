/**
 * Thrown by an engine's `resolveContactPhone` when it cannot map a lid to a phone right now: no
 * cache, table or key store knows the pair. It is not a "no phone" answer, and unlike a transient
 * engine failure it will not clear on the next attempt, so callers may hold off before asking again.
 */
export class LidNotMappedError extends Error {
  constructor(lid: string) {
    super(`lid ${lid} is not mapped in this session`);
    this.name = 'LidNotMappedError';
  }
}
