// Per-key trailing coalescer: collapse a burst of calls for the same key into ONE invocation
// fired after the key goes quiet for `delayMs`.
//
// Used for the mark-as-read RPC: every incoming message in the visible chat raises a read
// event, and a per-event POST sprays the gateway into 429s. Keys are independent (each chat
// gets its own quiet window), and `cancel()` drops every pending call so a late fire never
// targets an unmounted component.

export interface TrailingCoalescer<K> {
  call(key: K): void;
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
    cancel() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
