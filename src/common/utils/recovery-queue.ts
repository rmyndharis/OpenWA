import { isTransientDbError } from './db-errors';

/**
 * Work the database refused, kept in memory until it answers again, in the order it is retried: a send's own row
 * first (it must exist before changes are judged against it), then message changes, then webhook dispatches.
 */
export type RecoveryLane = 'send' | 'change' | 'dispatch';
const LANES: RecoveryLane[] = ['send', 'change', 'dispatch'];

/** Why a record was given up on: its lane is full, it is too old, the byte budget is spent, it kept failing, or the process stopped. */
export type RecoveryLoss = 'count' | 'age' | 'bytes' | 'failures' | 'shutdown';

export interface RecoveryRecord {
  readonly lane: RecoveryLane;
  readonly sessionId: string;
  /** When the record was first kept, in ms; the oldest go first when a bound is reached. */
  readonly since: number;
  /** The serialized size of what the record holds, counted against the byte budget every lane shares. Cheap: kept, not computed. */
  bytes(): number;
  /** Whether the lane's age cap applies; a record holding only a revoke is kept until the count cap. */
  ageCapped(): boolean;
  /** A step that must run for every record before any record's retry (the outbox steps of message changes). */
  prepare?(): Promise<void>;
  /** One more try: resolves true once nothing is left of the record, and throws when the database fails. */
  retry(): Promise<boolean>;
  /** The record was given up on: it logs what is lost. */
  lost(reason: RecoveryLoss): void;
  /** The record left the queue with nothing lost: settled, or forgotten with its session. */
  dropped?(): void;
}

export interface RecoveryQueueOptions {
  /** Shared by every lane, on the serialized data the records hold. */
  maxBytes: number;
  maxRecords: Record<RecoveryLane, number>;
  maxAgeMs: Record<RecoveryLane, number>;
  /** First retry delay, and the longest while the database keeps failing. */
  baseDelayMs: number;
  capDelayMs: number;
  now?: () => number;
}

/** A record that failed this many times for a reason of its own (not the database being away) is given up on. */
export const RECOVERY_MAX_RECORD_FAILURES = 3;

/** 64 MiB, the byte budget every lane shares. */
export const RECOVERY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * SQLite codes that say the database file cannot be used now (an I/O error, a full or read-only disk, a file that
 * cannot be opened), not that a statement is wrong: like a dropped connection, they say nothing of the record.
 */
const SQLITE_UNAVAILABLE = /^SQLITE_(IOERR|FULL|CANTOPEN|READONLY)/;

/** Whether an error says the database cannot answer now, so the rest of the pass would fail the same way. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (isTransientDbError(error)) return true;
  const e = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  const code = e?.driverError?.code ?? e?.code;
  return typeof code === 'string' && SQLITE_UNAVAILABLE.test(code);
}

/**
 * Retries what the database refused, one unref'd timer while anything is kept. A pass runs every record's
 * `prepare` first, then every `retry`, lanes in order and records oldest first. An error that says the database
 * cannot answer ends the pass, and the next waits twice as long, up to the cap; while failing, a pass tries one
 * record, and the first that settles resets the wait and lets the pass drain the rest. Any other error counts against
 * its record alone, which is given up on after {@link RECOVERY_MAX_RECORD_FAILURES}, so one record the database will
 * never take cannot hold back the others.
 */
export class RecoveryQueue {
  private readonly records = new Map<string, RecoveryRecord>();
  private readonly failures = new Map<RecoveryRecord, number>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private failing = false;
  private delayMs: number;
  private stopped = false;

  constructor(private readonly options: RecoveryQueueOptions) {
    this.now = options.now ?? Date.now;
    this.delayMs = options.baseDelayMs;
  }

  get size(): number {
    return this.records.size;
  }

  get(lane: RecoveryLane, key: string): RecoveryRecord | undefined {
    return this.records.get(`${lane}:${key}`);
  }

  /** Keep a record (one already kept under the key keeps its place), then hold every bound. */
  park(key: string, record: RecoveryRecord): void {
    if (this.stopped) {
      record.lost('shutdown');
      return;
    }
    this.records.set(`${record.lane}:${key}`, record);
    this.bound(record.lane);
    this.schedule();
  }

  /** The record needs nothing more, settled by a later change. */
  settle(lane: RecoveryLane, key: string): void {
    const record = this.records.get(`${lane}:${key}`);
    if (record) this.release(`${lane}:${key}`, record);
  }

  /** Drop a removed session's records: nothing they hold can apply any more. */
  forget(sessionId: string): void {
    for (const [key, record] of [...this.records]) if (record.sessionId === sessionId) this.release(key, record);
  }

  /**
   * One pass at shutdown, bounded by `budgetMs`, then the loss of whatever is left is logged. Nothing is kept or
   * retried after it.
   */
  async drain(budgetMs: number): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.records.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (this.running ?? Promise.resolve()).then(() => this.pass(true)),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, budgetMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    for (const [key, record] of [...this.records]) {
      this.drop(key, record);
      record.lost('shutdown');
    }
  }

  /** Run a pass now (tests, and the recovery of a database that answers again). */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    // A pass already under way may have started before the database answered: this one runs after it.
    while (this.running) await this.running;
    // Once the pass is over, a record kept meanwhile or one that still waits gets the next.
    this.running = this.pass(false).finally(() => {
      this.running = undefined;
      this.schedule();
    });
    await this.running;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.running || this.records.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  private async pass(final: boolean): Promise<void> {
    this.evictAged();
    const ordered = (): Array<[string, RecoveryRecord]> =>
      LANES.flatMap(lane => [...this.records].filter(([, r]) => r.lane === lane));
    try {
      if (this.failing && !final) {
        const [first] = ordered();
        if (first && (await this.step(first, true))) this.recovered();
        else return;
      }
      for (const entry of ordered()) if (entry[1].prepare && this.records.has(entry[0])) await this.step(entry, false);
      for (const entry of ordered()) if (this.records.has(entry[0])) await this.step(entry, true);
      this.recovered();
    } catch {
      // Only a database failure leaves step(): the rest of the pass would fail the same way.
      this.failing = true;
      this.delayMs = Math.min(this.delayMs * 2, this.options.capDelayMs);
    }
  }

  /** Run one step of a record; true when it settled. Rethrows a database failure, counts any other. */
  private async step([key, record]: [string, RecoveryRecord], retry: boolean): Promise<boolean> {
    try {
      if (!retry) {
        await record.prepare?.();
        return false;
      }
      if (!(await record.retry())) return false;
      this.release(key, record);
      return true;
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw error;
      const failures = (this.failures.get(record) ?? 0) + 1;
      this.failures.set(record, failures);
      if (failures >= RECOVERY_MAX_RECORD_FAILURES && this.records.get(key) === record) {
        this.drop(key, record);
        record.lost('failures');
      }
      return false;
    }
  }

  private recovered(): void {
    this.failing = false;
    this.delayMs = this.options.baseDelayMs;
  }

  private drop(key: string, record: RecoveryRecord): void {
    if (this.records.get(key) === record) this.records.delete(key);
    this.failures.delete(record);
  }

  /** Remove a record with nothing lost. */
  private release(key: string, record: RecoveryRecord): void {
    if (this.records.get(key) !== record) return;
    this.drop(key, record);
    record.dropped?.();
  }

  /** Hold the lane's count cap and the shared byte budget, giving up on the oldest first. */
  private bound(lane: RecoveryLane): void {
    const inLane = [...this.records].filter(([, r]) => r.lane === lane);
    for (let excess = inLane.length - this.options.maxRecords[lane], i = 0; excess > 0; excess--, i++) {
      const [key, record] = inLane[i];
      this.drop(key, record);
      record.lost('count');
    }
    let bytes = 0;
    for (const record of this.records.values()) bytes += record.bytes();
    const oldest = [...this.records].sort(([, a], [, b]) => a.since - b.since);
    for (const [key, record] of oldest) {
      if (bytes <= this.options.maxBytes) break;
      bytes -= record.bytes();
      this.drop(key, record);
      record.lost('bytes');
    }
  }

  private evictAged(): void {
    const now = this.now();
    for (const [key, record] of [...this.records]) {
      if (record.ageCapped() && now - record.since > this.options.maxAgeMs[record.lane]) {
        this.drop(key, record);
        record.lost('age');
      }
    }
  }
}
