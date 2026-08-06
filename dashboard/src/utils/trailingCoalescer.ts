// Per-key trailing coalescer: collapse a burst of calls for the same key into ONE invocation
// fired after the key goes quiet for `delayMs`.
//
// Used for the mark-as-read RPC: every incoming message in the visible chat raises a read
// event, and a per-event POST sprays the gateway into 429s. Keys are independent (each chat
// gets its own quiet window). `flush()` fires every pending key immediately — used on
// unmount/navigation so a queued mark-as-read isn't lost when the user leaves mid-window —
// while `cancel()` drops pending calls without firing them.

export interface TrailingCoalescer<K> {
  call(key: K): void;
  flush(): void;
  cancel(): void;
}

export function createTrailingCoalescer<K>(send: (key: K) => void, delayMs: number): TrailingCoalescer<K> {
  const timers = new Map<K, ReturnType<typeof setTimeout>>();
  return {
    call(key: K) {
      const existing = timers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          send(key);
        }, delayMs),
      );
    },
    flush() {
      const pending = [...timers.keys()];
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const key of pending) send(key);
    },
    cancel() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
