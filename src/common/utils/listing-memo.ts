/** How long a session's full listing stays reusable for the later pages of the walk that read it. */
export const LISTING_MEMO_TTL_MS = 5_000;

interface Entry<T> {
  items: Promise<T[]>;
  expiresAt: number;
  evictor?: NodeJS.Timeout;
}

/**
 * A session's last full engine listing (every chat, or every contact), kept a few seconds so the pages
 * of one walk (offset 0, 1000, 2000 ...) share one engine read instead of each re-reading the whole
 * list, which on whatsapp-web.js is a page evaluation over the entire account.
 *
 * Only a later page reuses it. A read at offset 0 starts a walk and always goes to the engine, so a
 * reload after a live event never starts from an old list. It holds the raw list of one session and
 * nothing else: every request applies its own chat-scope filter and window after reading it. Reads in
 * flight are shared, a failed read is not kept, an expired list is evicted by a timer that never keeps
 * the process alive, and the owner drops a session's entry when a write may have changed the list or
 * the session's engine stops being the live one.
 */
export class ListingMemo<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs = LISTING_MEMO_TTL_MS) {}

  async read(sessionId: string, offset: number | undefined, load: () => Promise<T[]>): Promise<T[]> {
    let entry = this.entries.get(sessionId);
    if (!(entry && (offset ?? 0) > 0 && entry.expiresAt > Date.now())) {
      clearTimeout(entry?.evictor);
      const fresh: Entry<T> = { items: load(), expiresAt: Infinity };
      this.entries.set(sessionId, fresh);
      fresh.items.then(
        () => {
          fresh.expiresAt = Date.now() + this.ttlMs;
          // An idle session is never read again, so an expired list has to leave the heap on its own.
          if (this.entries.get(sessionId) === fresh) {
            fresh.evictor = setTimeout(() => this.entries.delete(sessionId), this.ttlMs).unref();
          }
        },
        () => {
          if (this.entries.get(sessionId) === fresh) this.entries.delete(sessionId);
        },
      );
      entry = fresh;
    }
    // A copy, so no caller can reorder or trim the list the next page reads.
    return [...(await entry.items)];
  }

  drop(sessionId: string): void {
    clearTimeout(this.entries.get(sessionId)?.evictor);
    this.entries.delete(sessionId);
  }
}
