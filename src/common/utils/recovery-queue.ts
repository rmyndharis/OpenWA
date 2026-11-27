import { isTransientDbError } from './db-errors';
import type { RecoveryJournal } from './recovery-journal';

/**
 * Work the database refused, kept in memory until it answers again, in the order it is retried: a send's own row
 * first (it must exist before changes are judged against it), then message changes, then webhook dispatches.
 */
export type RecoveryLane = 'send' | 'change' | 'dispatch';
const LANES: RecoveryLane[] = ['send', 'change', 'dispatch'];

/** The key a send's SENT write is kept under in the `send` lane, by the message id it writes. */
export const sendRerunKey = (sessionId: string, waMessageId: string): string => `${sessionId}:${waMessageId}`;

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

/** How a lane's records are kept in the journal across a restart, by the lane's owner. */
export interface RecoveryCodec {
  /** What the journal keeps of a record; undefined for one that must not outlive the process. */
  encode(record: RecoveryRecord): unknown;
  /** The record a journaled entry restores, with its owner's own bookkeeping; undefined to let it go. */
  decode(key: string, value: unknown): RecoveryRecord | undefined;
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
  /** Where what is kept outlives the process (see RecoveryJournal); without it, a restart loses it. */
  journal?: RecoveryJournal;
}

/** A record that failed this many times for a reason of its own (not the database being away) is given up on. */
export const RECOVERY_MAX_RECORD_FAILURES = 3;

/** 64 MiB, the byte budget every lane shares. */
export const RECOVERY_MAX_BYTES = 64 * 1024 * 1024;

/** Records a lane keeps: a message's changes and a send's rerun one each, a dispatch one per webhook event. */
export const RECOVERY_MAX_RECORDS: Readonly<Record<RecoveryLane, number>> = {
  send: 1000,
  change: 1000,
  dispatch: 10_000,
};

/** How long a record with content is kept (a revoke alone is kept until its lane is full). */
export const RECOVERY_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The queue of one process, every lane sharing it so a pass runs them in order. A record waits before its next try
 * while the database keeps failing: SQLite is one node, and every try against a lock can hold the event loop for its
 * busy timeout, so it backs off to 30 s; on PostgreSQL the wait plus a pass must stay under the sweep's grace
 * (`graceMs`), so a peer's sweep, held for one grace after the database comes back, does not replay what this node is
 * about to withdraw.
 */
export function recoveryQueueOptions(postgres: boolean, graceMs: number): RecoveryQueueOptions {
  const cap = postgres ? Math.max(1000, Math.min(5000, graceMs / 4)) : 30_000;
  return {
    maxBytes: RECOVERY_MAX_BYTES,
    maxRecords: { ...RECOVERY_MAX_RECORDS },
    maxAgeMs: { send: RECOVERY_MAX_AGE_MS, change: RECOVERY_MAX_AGE_MS, dispatch: RECOVERY_MAX_AGE_MS },
    baseDelayMs: Math.min(1000, cap),
    capDelayMs: cap,
  };
}

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
  // The records the byte budget may give up, with their keys, across lanes in the order they became so (kept, or held
  // content again): the first is the one it gives up. One the age cap does not apply to (a revoke) is never among them.
  private readonly evictable = new Map<RecoveryRecord, string>();
  // What each record counted against the byte budget when it was last measured, and their sum.
  private readonly sizes = new Map<RecoveryRecord, number>();
  private bytes = 0;
  private readonly failures = new Map<RecoveryRecord, number>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private failing = false;
  private delayMs: number;
  // Lanes whose shutdown pass ran: what is kept in them after it is lost.
  private readonly stopped = new Set<RecoveryLane>();
  private readonly codecs: Partial<Record<RecoveryLane, RecoveryCodec>> = {};
  // Lanes the journal restores records to whose owner has not registered yet: no pass runs until none is left, so the
  // outbox steps of restored changes come before any restored dispatch goes out.
  private readonly waiting = new Set<RecoveryLane>();
  // Set while records the journal restored wait for the application to be up (ready): the hooks they reach are
  // registered by then.
  private held = false;

  constructor(private readonly options: RecoveryQueueOptions) {
    this.now = options.now ?? (() => Date.now());
    this.delayMs = options.baseDelayMs;
    for (const lane of options.journal?.waiting() ?? [])
      if (LANES.includes(lane as RecoveryLane)) this.waiting.add(lane as RecoveryLane);
    this.held = this.waiting.size > 0;
  }

  /**
   * The owner of a lane registers how its records are journaled, and takes back what the last process left in it.
   * Restored records are kept as they were (their age included), under every bound, before the first pass.
   */
  register(lane: RecoveryLane, codec: RecoveryCodec): void {
    this.codecs[lane] = codec;
    const journal = this.options.journal;
    if (!journal) return;
    journal.snapshot(lane, () => this.journaled(lane));
    for (const [key, value] of journal.take(lane)) {
      const record = codec.decode(key, value);
      if (!record) {
        journal.del(lane, key);
        continue;
      }
      this.lanes[lane].set(key, record);
      this.measure(key, record);
    }
    this.bound(lane);
    this.waiting.delete(lane);
    this.schedule();
  }

  /**
   * Once the application is up, its plugins included: what the journal restored is tried from now on, and a lane no
   * owner registered for gives up what the journal restored to it.
   */
  ready(): void {
    this.held = false;
    const journal = this.options.journal;
    for (const lane of this.waiting) {
      const entries = journal?.take(lane) ?? [];
      for (const [key] of entries) journal?.del(lane, key);
      if (entries.length) journal?.noteUnclaimed(lane, entries.length);
    }
    this.waiting.clear();
    this.schedule();
  }

  get size(): number {
    return LANES.reduce((size, lane) => size + this.lanes[lane].size, 0);
  }

  get(lane: RecoveryLane, key: string): RecoveryRecord | undefined {
    return this.lanes[lane].get(key);
  }

  /**
   * Keep a record (one already kept under the key keeps its place), then hold every bound. One larger than the whole
   * byte budget is given up at once, and nothing older is given up for it: no eviction would make it fit.
   */
  park(key: string, record: RecoveryRecord): void {
    if (record.ageCapped() && record.bytes() > this.options.maxBytes) {
      this.drop(key, record);
      record.lost('bytes');
      return;
    }
    if (this.stopped.has(record.lane)) {
      // After the shutdown pass: kept for the next start when the journal takes it, else lost.
      if (this.journal(key, record)) this.options.journal!.noteKept(1);
      else record.lost('shutdown');
      return;
    }
    const lane = this.lanes[record.lane];
    const was = lane.get(key);
    if (was && was !== record) this.forgetSize(was);
    lane.set(key, record);
    this.measure(key, record);
    this.journal(key, record);
    this.bound(record.lane);
    this.schedule();
  }

  /** Count a kept record against the byte budget again, once what it holds changed. */
  remeasure(lane: RecoveryLane, key: string): void {
    const record = this.lanes[lane].get(key);
    if (!record) return;
    this.measure(key, record);
    this.journal(key, record);
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
   * One pass at shutdown over `lanes`, bounded by `budgetMs` (the outbox steps of every lane run first, as in any pass),
   * then the loss of whatever is left in them is logged. Nothing is kept in them or retried after it; the other lanes
   * go on until their own pass.
   */
  async drain(budgetMs: number, lanes: readonly RecoveryLane[] = LANES): Promise<void> {
    for (const lane of lanes) this.stopped.add(lane);
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries(lanes).length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (this.running ?? Promise.resolve()).then(() => this.pass(true, lanes)),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, budgetMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    // What the journal holds stays there for the next start; the rest is lost.
    let kept = 0;
    for (const [key, record] of this.entries(lanes)) {
      const journaled = this.options.journal?.has(record.lane, key) === true;
      this.drop(key, record, !journaled);
      if (journaled) kept++;
      else record.lost('shutdown');
    }
    this.options.journal?.noteKept(kept);
    this.schedule();
  }

  /** Run a pass now (tests, and the recovery of a database that answers again). */
  async flush(): Promise<void> {
    if (this.held || this.waiting.size) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    // A pass already under way may have started before the database answered: this one runs after it.
    while (this.running) await this.running;
    // Once the pass is over, a record kept meanwhile or one that still waits gets the next.
    this.running = this.pass(false, this.live()).finally(() => {
      this.running = undefined;
      this.schedule();
    });
    await this.running;
  }

  /** Every record of `lanes`, lanes in order and the oldest first. */
  private entries(lanes: readonly RecoveryLane[] = LANES): Array<[string, RecoveryRecord]> {
    return LANES.filter(lane => lanes.includes(lane)).flatMap(lane => [...this.lanes[lane]]);
  }

  /** The lanes a pass still tries. */
  private live(): RecoveryLane[] {
    return LANES.filter(lane => !this.stopped.has(lane));
  }

  private kept(key: string, record: RecoveryRecord): boolean {
    return this.lanes[record.lane].get(key) === record;
  }

  private schedule(): void {
    if (this.held || this.waiting.size || this.timer || this.running || this.entries(this.live()).length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  private async pass(final: boolean, lanes: readonly RecoveryLane[] = this.live()): Promise<void> {
    this.evictAged();
    try {
      if (this.failing && !final) {
        const [first] = this.entries(lanes);
        if (first && (await this.step(first, true))) this.recovered();
        else return;
      }
      // The outbox steps of every lane still kept go first, also in a pass that tries only some lanes.
      const prepared = [...new Set([...lanes, ...this.live()])];
      for (const entry of this.entries(prepared)) {
        if (entry[1].prepare && this.kept(...entry)) await this.step(entry, false);
      }
      for (const entry of this.entries(lanes)) if (this.kept(...entry)) await this.step(entry, true);
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
        if (this.kept(key, record)) {
          this.measure(key, record);
          this.journal(key, record);
        }
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

  private measure(key: string, record: RecoveryRecord): void {
    const size = record.bytes();
    this.bytes += size - (this.sizes.get(record) ?? 0);
    this.sizes.set(record, size);
    if (!record.ageCapped()) this.evictable.delete(record);
    else if (!this.evictable.has(record)) this.evictable.set(record, key);
  }

  private forgetSize(record: RecoveryRecord): void {
    this.bytes -= this.sizes.get(record) ?? 0;
    this.sizes.delete(record);
    this.evictable.delete(record);
    this.failures.delete(record);
  }

  /** Keep what a record holds now in the journal; true once the journal holds it. */
  private journal(key: string, record: RecoveryRecord): boolean {
    const journal = this.options.journal;
    const codec = this.codecs[record.lane];
    if (!journal || !codec) return false;
    const value = codec.encode(record);
    if (value !== undefined) return journal.put(record.lane, key, value);
    journal.del(record.lane, key);
    return false;
  }

  /** The journal entries of a lane's records, for the journal to be written again with only them. */
  private *journaled(lane: RecoveryLane): Iterable<[string, unknown]> {
    const codec = this.codecs[lane];
    for (const [key, record] of this.lanes[lane]) {
      const value = codec?.encode(record);
      if (value !== undefined) yield [key, value];
    }
  }

  /** Take a record out of the queue, and out of the journal unless it must outlive the process (`unjournal`). */
  private drop(key: string, record: RecoveryRecord, unjournal = true): void {
    if (!this.kept(key, record)) return;
    this.lanes[record.lane].delete(key);
    this.forgetSize(record);
    if (unjournal) this.options.journal?.del(record.lane, key);
  }

  /** Remove a record with nothing lost. */
  private release(key: string, record: RecoveryRecord): void {
    if (!this.kept(key, record)) return;
    this.drop(key, record);
    record.dropped?.();
  }

  /**
   * Hold the lane's count cap and the shared byte budget, giving up on the oldest first: the first of a lane, and the
   * first of the records the budget may give up.
   */
  private bound(lane: RecoveryLane): void {
    const inLane = this.lanes[lane];
    while (inLane.size > this.options.maxRecords[lane]) {
      const [key, record] = inLane.entries().next().value!;
      this.drop(key, record);
      record.lost('count');
    }
    while (this.bytes > this.options.maxBytes && this.evictable.size > 0) {
      const [record, key] = this.evictable.entries().next().value!;
      this.drop(key, record);
      record.lost('bytes');
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
