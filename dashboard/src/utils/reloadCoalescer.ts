// Single-flight reloads with one trailing run: while a reload is out, every call shares ONE follow-up
// reload that starts when it settles, so a burst of triggers costs two reloads instead of one each.
//
// Used for the chat-list refetch. A reload walks every page of the list, and each live event the sidebar
// cannot apply locally asks for one. A caller gets the result of the run that serves IT: a call made while
// a reload is out waits for the trailing run, which starts after the call, so what it reads includes
// whatever raised the call.
//
// `cancel()` drops the trailing run that has not started (its session was left) and settles that run's
// callers with `false`. The run already out is the owner's to abort. The coalescer stays usable after a
// cancel, because React replays effect cleanups in StrictMode.
//
// A reload that never answers (a connection that went half-open) would hold every later call behind it, so
// a run can be given a deadline: at the deadline the signal handed to the reload is aborted, the run settles
// with `false` and the trailing run, if any, starts.

export interface ReloadCoalescer {
  run(): Promise<boolean>;
  cancel(): void;
}

export interface ReloadCoalescerOptions {
  /** How long one run may take before it is abandoned. No deadline when omitted. */
  deadlineMs?: number;
}

interface Trailing {
  promise: Promise<boolean>;
  settle: (result: boolean | PromiseLike<boolean>) => void;
}

export function createReloadCoalescer(
  reload: (signal: AbortSignal) => Promise<boolean>,
  { deadlineMs }: ReloadCoalescerOptions = {},
): ReloadCoalescer {
  let running = false;
  let trailing: Trailing | null = null;

  const start = (): Promise<boolean> => {
    running = true;
    const controller = new AbortController();
    const current = new Promise<boolean>((resolve, reject) => {
      const timer =
        deadlineMs === undefined
          ? undefined
          : setTimeout(() => {
              controller.abort();
              resolve(false);
            }, deadlineMs);
      // A pending deadline must not keep a Node process open (the unit tests); a browser timer is a number.
      if (typeof timer === 'object') (timer as { unref?: () => void }).unref?.();
      new Promise<boolean>(started => started(reload(controller.signal))).then(
        result => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    // Both outcomes release the slot, or one failed reload would starve every later call.
    const release = () => {
      const queued = trailing;
      trailing = null;
      if (queued) queued.settle(start());
      else running = false;
    };
    current.then(release, release);
    return current;
  };

  return {
    run() {
      if (!running) return start();
      if (!trailing) {
        let settle!: Trailing['settle'];
        const promise = new Promise<boolean>(resolve => {
          settle = resolve;
        });
        trailing = { promise, settle };
      }
      return trailing.promise;
    },
    cancel() {
      trailing?.settle(false);
      trailing = null;
    },
  };
}
