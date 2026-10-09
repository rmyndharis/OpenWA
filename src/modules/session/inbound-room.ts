import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { inboundMediaConcurrency, inboundMediaTimeoutMs } from '../../engine';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

/**
 * One message's claim on its session's {@link InboundRoom}. It holds no message, so a waiter parked
 * in the room costs a few closures, never a payload.
 */
export interface RoomState {
  granted: boolean;
  /** Gave up before its grant: once admitted, it passes the slot straight on. */
  abandoned: boolean;
  grant: Deferred<boolean>;
  /** Resolved once the message's row is written, or once it will not be emitted. */
  done: Deferred<void>;
  /** Work on the payload that may outlive `done` (engine processing, a page download, a status ingest). */
  holds: Promise<unknown>[];
}

export function roomState(): RoomState {
  return { granted: false, abandoned: false, grant: deferred(), done: deferred(), holds: [] };
}

/**
 * Room for the downloaded payloads one session holds in memory before their rows are written:
 * INBOUND_MEDIA_CONCURRENCY slots of one payload each, granted in arrival order. A slot is held until
 * the row is written AND every hold settles, so a stalled insert keeps it, and the payloads held stay
 * within the slots however long the store takes.
 */
export class InboundRoom {
  readonly gate = new ConcurrencyLimiter(inboundMediaConcurrency());
  private lastRelease = Date.now();

  /** Queue `s` for a slot. Synchronous: a free slot is granted before this returns. */
  request(s: RoomState): Promise<void> {
    return this.gate
      .run(async () => {
        if (s.abandoned) return;
        s.granted = true;
        s.grant.resolve(true);
        await s.done.promise;
        // Read after `done`, and to the end of the array: a hold pushed while an earlier one runs counts too.
        for (let i = 0; i < s.holds.length; i++) await s.holds[i];
      })
      .then(() => {
        this.lastRelease = Date.now();
      });
  }

  /**
   * Wait for the grant. Gives up only when the room made no progress (no slot released) for twice
   * MEDIA_DOWNLOAD_TIMEOUT_MS: a holder is legitimately busy for one download deadline plus its
   * commit, so a burst behind a moving room keeps its media, and only a stalled room sheds.
   */
  wait(s: RoomState): Promise<boolean> {
    if (s.granted) return Promise.resolve(true);
    const window = 2 * inboundMediaTimeoutMs();
    const asked = Date.now();
    const arm = (delay: number): void => {
      const timer = setTimeout(() => {
        if (s.granted || s.abandoned) return;
        const idle = Date.now() - Math.max(this.lastRelease, asked);
        if (idle < window) return arm(window - idle);
        s.abandoned = true;
        s.grant.resolve(false);
      }, delay);
      timer.unref?.();
      void s.grant.promise.then(() => clearTimeout(timer));
    };
    arm(window);
    return s.grant.promise;
  }

  get idle(): boolean {
    return this.gate.activeCount === 0 && this.gate.queuedCount === 0;
  }
}
