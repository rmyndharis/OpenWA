import { retryThrottled } from './fetchAllPages.ts';

// The gateway answers a route 10 times a second per IP by default and refuses the rest with a 429,
// which also counts against the minute tier. A chat opened on archived media wants one fetch per
// preview near the viewport, so the fetches start 125 ms apart (8 a second) rather than all at once;
// otherwise the newest previews are the ones refused and stay download buttons for good. A 429 that
// still arrives (a lower configured limit, another tab) is retried like fetchAllPages retries a page.
// So is a 503: on S3 the gateway refuses a download at once while 50 are open, and a place frees as soon
// as one of them ends. Any other failure is not retried.
const START_GAP_MS = 125;
const RETRIED_STATUSES = [429, 503];
let lastStart = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const waiting: Array<() => void> = [];

// One timer hands out the turns, a gap apart. A load that gives up its turn (its preview unmounted) leaves
// the queue, so it costs the loads behind it nothing.
function pump(): void {
  if (timer !== undefined || waiting.length === 0) return;
  timer = setTimeout(
    () => {
      timer = undefined;
      const next = waiting.shift();
      if (next) {
        lastStart = Date.now();
        next();
      }
      pump();
    },
    Math.max(0, lastStart + START_GAP_MS - Date.now()),
  );
}

function waitForTurn(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const turn = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      const at = waiting.indexOf(turn);
      if (at >= 0) waiting.splice(at, 1);
      reject(signal.reason);
    };
    waiting.push(turn);
    signal.addEventListener('abort', onAbort, { once: true });
    pump();
  });
}

export function loadArchivedMedia<T>(signal: AbortSignal, load: () => Promise<T>, retryDelayMs = 1000): Promise<T> {
  return retryThrottled(
    async () => {
      await waitForTurn(signal);
      return load();
    },
    retryDelayMs,
    RETRIED_STATUSES,
  );
}
