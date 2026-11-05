const noop = (): void => undefined;

/** Longest a row read waits for the phone writes issued before it. */
const PHONE_WRITE_WAIT_MS = 5_000;
/** Reads repeated because another phone write was issued while one ran, before the caller is told. */
const MAX_READ_ATTEMPTS = 3;

/**
 * The row writes that change a session's phone and whose issuer does not wait for them: the clear of a terminal unlink
 * and the row a READY writes. A row read that overlaps one of them can return the binding it replaces, so a reader that
 * acts on the phone starts its read after the writes issued so far have been answered, and repeats it when another is
 * issued while it runs. What it returns is then the phone this process last wrote, whichever order the database
 * executes the statements in.
 */
export class PhoneWrites {
  /** Settles once every write tracked for a session so far has been answered. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Writes tracked per session since boot: a read that sees it move was overlapped. */
  private readonly issued = new Map<string, number>();

  /** Registers a write the caller does not await. Its outcome stays the caller's to handle: only its answer counts here. */
  track(id: string, write: Promise<unknown>): void {
    const tail = Promise.all([this.tails.get(id), write.then(noop, noop)]).then(noop);
    this.tails.set(id, tail);
    this.issued.set(id, (this.issued.get(id) ?? 0) + 1);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
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
   * when the writes are not answered in time or keep arriving: a caller treats that as a read that failed.
   */
  async readSettled<T>(id: string, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      if (this.tails.has(id)) await this.answered(id);
      const mark = this.mark(id);
      const value = await read();
      if (!this.overlapped(id, mark)) return value;
    }
    throw new Error(`The phone of session ${id} was written again while its row was read`);
  }

  private async answered(id: string): Promise<void> {
    for (let pending = this.tails.get(id); pending; pending = this.tails.get(id)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The phone writes of session ${id} were not answered in ${PHONE_WRITE_WAIT_MS} ms`)),
          PHONE_WRITE_WAIT_MS,
        );
      });
      try {
        await Promise.race([pending, late]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
