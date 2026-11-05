const noop = (): void => undefined;

/** Longest one write holds up the writes and reads behind it, and longest a read waits for the writes before it. */
const PHONE_WRITE_WAIT_MS = 5_000;
/** Reads repeated because another phone write was issued while one ran, before the caller is told. */
const MAX_READ_ATTEMPTS = 3;

/**
 * The row writes that change a session's phone binding: the clear of a terminal unlink, the number and push name a
 * READY links, the push name an engine syncs after it, and the clear of a logout (its issuer awaits the answer, the
 * others do not). Two rules keep what a reader sees in step with what this process wrote:
 *
 *  - {@link PhoneWrites.run} issues them one after another per session, so the database receives them in the order they
 *    were issued, whichever connection of the pool each one takes;
 *  - {@link PhoneWrites.readSettled} starts a read that acts on the phone once the writes issued so far have been
 *    answered, and repeats it when another is issued while it runs.
 *
 * A write that is not answered holds up the ones behind it for {@link PHONE_WRITE_WAIT_MS} at most, and the order is then
 * best effort. A read that finds the writes unanswered for that long, counted over the whole call, or still being issued
 * after its attempts, rejects: the disconnect handler reads again shortly, as after any failed read, and a start fails
 * with it (a failed read of its own kind, a dropped connection, is retried once; this rejection is not).
 */
export class PhoneWrites {
  /** Settles once every write issued for a session so far has been answered, or has held things up for the limit. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Writes issued per session since boot: a read that sees it move was overlapped. */
  private readonly issued = new Map<string, number>();

  /**
   * Issues `write` once the writes issued before it for the session have been answered (at once when there are none)
   * and returns its promise. The caller handles a failure: only its answer counts here.
   */
  run<T>(id: string, write: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id);
    let expire!: () => void;
    const limit = new Promise<void>(resolve => (expire = resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The limit counts from the moment the write begins, not from the moment it was queued.
    const begin = (): Promise<T> => {
      const started = write();
      timer = setTimeout(expire, PHONE_WRITE_WAIT_MS);
      timer.unref();
      return started;
    };
    const result = previous ? previous.then(begin) : begin();
    const answered = result.then(noop, noop);
    const tail = Promise.race([answered, limit]).then(() => clearTimeout(timer));
    this.tails.set(id, tail);
    this.issued.set(id, (this.issued.get(id) ?? 0) + 1);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return result;
  }

  /** Drops what is kept for a session that was deleted. */
  forget(id: string): void {
    this.tails.delete(id);
    this.issued.delete(id);
  }

  /** Whether a write is still waiting for its answer. */
  hasPending(id: string): boolean {
    return this.tails.has(id);
  }

  /** A point in the session's writes, to ask {@link PhoneWrites.overlapped} about after a read. */
  mark(id: string): number {
    return this.issued.get(id) ?? 0;
  }

  /** Whether a write is pending now or was issued since `mark`: a read that began at the mark may not reflect it. */
  overlapped(id: string, mark: number): boolean {
    return this.tails.has(id) || (this.issued.get(id) ?? 0) !== mark;
  }

  /**
   * `read`, started once no write is pending for the session and repeated while another is issued during it. Rejects
   * when the writes are not answered within the limit, counted over the whole call, or keep being issued.
   */
  async readSettled<T>(id: string, read: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The phone writes of session ${id} were not answered in ${PHONE_WRITE_WAIT_MS} ms`)),
        PHONE_WRITE_WAIT_MS,
      );
      timer.unref();
    });
    late.catch(noop); // it may settle while a read runs and nothing waits for it
    try {
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
        // The check that nothing is pending, the mark and the start of the read are one synchronous step: a write
        // issued after the wait ended but before the read began would otherwise be missed by both.
        for (let pending = this.tails.get(id); pending; pending = this.tails.get(id)) {
          await Promise.race([pending, late]);
        }
        const mark = this.mark(id);
        const value = await read();
        if (!this.overlapped(id, mark)) return value;
      }
      throw new Error(`The phone of session ${id} was written again while its row was read`);
    } finally {
      clearTimeout(timer);
    }
  }
}
