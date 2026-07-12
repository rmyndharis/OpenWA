/**
 * Minimal async concurrency gate: runs at most `max` tasks concurrently, queueing the rest (FIFO).
 * Used to bound how many inbound media downloads run at once — each materializes a full decrypted
 * buffer in heap, so an unbounded fire-and-forget loop lets a sender flood the gateway with N parallel
 * multi-MB allocations. No external dependency (the codebase ships no p-limit/semaphore).
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * `max` is clamped to at least 1 so a misconfigured 0/negative value never deadlocks the gate.
   * `maxQueued` bounds how many tasks may PARK waiting for a slot; an (active + queued)th arrival is
   * rejected (throws) instead of parking forever — this caps in-heap state under a burst, since each
   * parked closure holds its task (and an inbound media buffer) alive. Default Infinity preserves the
   * original unbounded-queue behavior for callers that don't opt into a cap.
   */
  constructor(
    private readonly max: number,
    private readonly maxQueued = Infinity,
  ) {
    this.max = Math.max(1, Math.floor(max));
    this.maxQueued = Math.max(0, Math.floor(maxQueued));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++;
    } else {
      if (this.waiters.length >= this.maxQueued) {
        throw new Error('ConcurrencyLimiter queue full');
      }
      // Park until a finishing task HANDS us its slot. We must not increment on wake: the count was
      // never released (it was transferred), so re-incrementing would over-admit when a fresh run()
      // raced into the microtask gap and already took a (wrongly-freed) slot.
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next(); // transfer this slot to the next waiter — active count stays the same (no free window)
      } else {
        this.active--; // no one waiting: actually release the slot
      }
    }
  }
}
