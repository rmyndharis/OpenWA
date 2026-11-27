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
  // Per lane, in the order the records were first kept: one kept again under its key keeps its place, so the first is
  // always the oldest, and a bound gives it up without sorting.
  private readonly lanes: Record<RecoveryLane, Map<string, RecoveryRecord>> = {
    send: new Map(),
    change: new Map(),
    dispatch: new Map(),
  };
  // What each record counted against the byte budget when it was last measured, and their sum.
  private readonly sizes = new Map<RecoveryRecord, number>();
  private bytes = 0;
  private readonly failures = new Map<RecoveryRecord, number>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private failing = false;
  private delayMs: number;
  private stopped = false;

  constructor(private readonly options: RecoveryQueueOptions) {
    this.now = options.now ?? (() => Date.now());
    this.delayMs = options.baseDelayMs;
  }

  get size(): number {
    return LANES.reduce((size, lane) => size + this.lanes[lane].size, 0);
  }

  get(lane: RecoveryLane, key: string): RecoveryRecord | undefined {
    return this.lanes[lane].get(key);
  }

  /** Keep a record (one already kept under the key keeps its place), then hold every bound. */
  park(key: string, record: RecoveryRecord): void {
    if (this.stopped) {
      record.lost('shutdown');
      return;
    }
    const lane = this.lanes[record.lane];
    const was = lane.get(key);
    if (was && was !== record) this.forgetSize(was);
    lane.set(key, record);
    this.measure(record);
    this.bound(record.lane);
    this.schedule();
  }

  /** Count a kept record against the byte budget again, once what it holds changed. */
  remeasure(lane: RecoveryLane, key: string): void {
    const record = this.lanes[lane].get(key);
    if (!record) return;
    this.measure(record);
    this.bound(lane);
  }

  /** The record needs nothing more, settled by a later change. */
  settle(lane: RecoveryLane, key: string): void {
    const record = this.lanes[lane].get(key);
    if (record) this.release(key, record);
  }

  /** Drop a removed session's records: nothing they hold can apply any more. */
  forget(sessionId: string): void {
    for (const [key, record] of this.entries()) if (record.sessionId === sessionId) this.release(key, record);
  }

  /**
   * One pass at shutdown, bounded by `budgetMs`, then the loss of whatever is left is logged. Nothing is kept or
   * retried after it.
   */
  async drain(budgetMs: number): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.size) {
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
    for (const [key, record] of this.entries()) {
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

  /** Every record, lanes in order and the oldest first. */
  private entries(): Array<[string, RecoveryRecord]> {
    return LANES.flatMap(lane => [...this.lanes[lane]]);
  }

  private kept(key: string, record: RecoveryRecord): boolean {
    return this.lanes[record.lane].get(key) === record;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.running || this.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  private async pass(final: boolean): Promise<void> {
    this.evictAged();
    try {
      if (this.failing && !final) {
        const [first] = this.entries();
        if (first && (await this.step(first, true))) this.recovered();
        else return;
      }
      for (const entry of this.entries()) if (entry[1].prepare && this.kept(...entry)) await this.step(entry, false);
      for (const entry of this.entries()) if (this.kept(...entry)) await this.step(entry, true);
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
      const settled = await record.retry();
      if (!settled) {
        // A try that wrote part of what the record holds leaves it smaller.
        if (this.kept(key, record)) this.measure(record);
        return false;
      }
      this.release(key, record);
      return true;
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw error;
      const failures = (this.failures.get(record) ?? 0) + 1;
      this.failures.set(record, failures);
      if (failures >= RECOVERY_MAX_RECORD_FAILURES && this.kept(key, record)) {
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

  private measure(record: RecoveryRecord): void {
    const size = record.bytes();
    this.bytes += size - (this.sizes.get(record) ?? 0);
    this.sizes.set(record, size);
  }

  private forgetSize(record: RecoveryRecord): void {
    this.bytes -= this.sizes.get(record) ?? 0;
    this.sizes.delete(record);
    this.failures.delete(record);
  }

  private drop(key: string, record: RecoveryRecord): void {
    if (!this.kept(key, record)) return;
    this.lanes[record.lane].delete(key);
    this.forgetSize(record);
  }

  /** Remove a record with nothing lost. */
  private release(key: string, record: RecoveryRecord): void {
    if (!this.kept(key, record)) return;
    this.drop(key, record);
    record.dropped?.();
  }

  /** Hold the lane's count cap and the shared byte budget, giving up on the oldest first: the first of a lane. */
  private bound(lane: RecoveryLane): void {
    const inLane = this.lanes[lane];
    while (inLane.size > this.options.maxRecords[lane]) {
      const [key, record] = inLane.entries().next().value!;
      this.drop(key, record);
      record.lost('count');
    }
    while (this.bytes > this.options.maxBytes) {
      let oldest: [string, RecoveryRecord] | undefined;
      for (const each of LANES) {
        const first = this.lanes[each].entries().next().value;
        if (first && (!oldest || first[1].since < oldest[1].since)) oldest = first;
      }
      if (!oldest) break;
      this.drop(...oldest);
      oldest[1].lost('bytes');
    }
  }

  private evictAged(): void {
    const now = this.now();
    for (const [key, record] of this.entries()) {
      if (record.ageCapped() && now - record.since > this.options.maxAgeMs[record.lane]) {
        this.drop(key, record);
        record.lost('age');
      }
    }
  }
}
