/**
 * Serializes async work per key, so concurrent mutations of the same entity apply in arrival order.
 *
 * Extracted from SessionService, where it existed to keep stored-message mutations ordered:
 * reactions perform a read-modify-write and rapid edits must remain latest-write-wins, and sharing
 * one chain per message also preserves order when different mutation kinds for the same message
 * arrive together.
 *
 * There is nothing session-specific about it — it is a keyed promise chain — so it lives on its own
 * where its failure-isolation and memory-reclamation behaviour can be tested directly, rather than
 * through engine callbacks.
 */
export class KeyedMutationQueue {
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * @param onUnexpectedError Last-resort handler. Callers' work functions are expected to do their
   *   own contextual error handling; this exists so a future one cannot leak a rejected
   *   fire-and-forget promise or permanently block the key's later mutations.
   */
  constructor(private readonly onUnexpectedError: (key: string, err: unknown) => void = () => {}) {}

  /** Queue work for `key`. A failed operation is isolated so later work on the same key still runs. */
  enqueue(key: string, work: () => Promise<void>): void {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(work)
      .catch(err => this.onUnexpectedError(key, err));
    this.chains.set(key, next);
    // Reclaim the entry once the chain drains, but only if no later work replaced it — otherwise a
    // long-lived process would accumulate one settled promise per entity touched.
    void next.finally(() => {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    });
  }

  /** Number of keys with in-flight work. Exposed for tests and diagnostics. */
  get size(): number {
    return this.chains.size;
  }
}
