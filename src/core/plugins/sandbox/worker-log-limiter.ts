import { performance } from 'perf_hooks';
import { SANDBOX_LOG_MAX_PER_WINDOW, SANDBOX_LOG_WINDOW_MS } from './protocol';

/**
 * The worker's own bound on the log lines it posts to the host. Every line posted is read, cloned and routed on the
 * host's one thread, and a loop that logs without yielding posts faster than the host can read: the backlog grows in
 * native memory and every session and request waits behind it. `admit` says whether the next line may go out. A line
 * past the bound is counted and dropped here, which costs the plugin's own thread an increment and the host nothing.
 *
 * Two notes leave through `note`, outside the bound: one at the first drop of a window, and the count with the first
 * line after the window ends. The first is what a flood that stops, or kills the worker, before its window ends leaves
 * behind. The windows run on the monotonic clock: a wall-clock step must not open or hold one.
 */
export class WorkerLogLimiter {
  private windowStart = Number.NEGATIVE_INFINITY;
  private count = 0;
  private dropped = 0;

  constructor(
    private readonly note: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  admit(): boolean {
    const now = this.now();
    if (now - this.windowStart >= SANDBOX_LOG_WINDOW_MS) {
      if (this.dropped > 0) this.note(`Dropped ${this.dropped} log messages (log rate limit)`);
      this.windowStart = now;
      this.count = 0;
      this.dropped = 0;
    }
    if (this.count < SANDBOX_LOG_MAX_PER_WINDOW) {
      this.count++;
      return true;
    }
    if (this.dropped++ === 0) {
      this.note(
        `Log rate limit reached (${SANDBOX_LOG_MAX_PER_WINDOW} per ${SANDBOX_LOG_WINDOW_MS / 1000} s): ` +
          'further log messages are dropped until the window ends',
      );
    }
    return false;
  }
}
