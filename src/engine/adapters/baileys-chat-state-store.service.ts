import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatState } from './baileys-chat-state.entity';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';

export type ChatStateField = 'muteEndTime' | 'archived' | 'pinned' | 'deletedAt';
const FIELDS: ChatStateField[] = ['muteEndTime', 'archived', 'pinned', 'deletedAt'];

/**
 * Durable chat app-state Baileys cannot re-deliver on reconnect. `muteEndTime` is canonical epoch ms.
 * `deletedAt` is the epoch ms WhatsApp deleted the chat, null (or absent) when it was not.
 * `updatedAt` (epoch ms) is when the row last changed, when known; it is read, never written by a patch.
 * `observed` lists the fields the row has seen a value for, the others holding their default; undefined
 * on a row written before the list was kept, which counts its set fields as seen. Like `updatedAt`, a
 * patch never sets it.
 */
export type ChatStateValue = {
  muteEndTime: number | null;
  archived: boolean;
  pinned: boolean;
  deletedAt?: number | null;
  updatedAt?: number;
  observed?: ChatStateField[];
};

/**
 * Narrow read/write port over the persisted `chat_states` table. The Baileys session store depends on
 * this (a sync read on the chat-list hot path plus write-through), on the interface not the concrete
 * service, so the store stays unit-testable with a fake (mirrors {@link LidMappingStore}).
 */
export interface ChatStateStore {
  /** Sync read from the in-memory mirror; undefined = no persisted state for this chat (defaults apply). */
  get(sessionId: string, chatId: string): ChatStateValue | undefined;
  /** The chat ids the in-memory mirror holds a state for in one session (bounded by the cache cap). */
  chatIds(sessionId: string): string[];
  /**
   * Write-through, last-write-wins: merge the patch into the stored state and persist. With `create`
   * false, a patch that only restates defaults writes nothing for a chat with no row (an update that
   * merely carries the field, like the unarchive every message brings, must not add a row per chat).
   */
  remember(sessionId: string, chatId: string, patch: Partial<ChatStateValue>, create?: boolean): Promise<void>;
  /**
   * Like {@link remember}, but first folds the rows filed under `twins` (other spellings of the chat)
   * onto `chatId`: all the rows, read from the table and merged by {@link mergeTwinStates}, are the
   * merge base, and the twin rows are deleted once the result is written. `create` applies as in
   * {@link remember} when no twin row is found. Writes of the twins wait for it, so none can land between
   * the read of a twin row and its delete.
   */
  fold(
    sessionId: string,
    chatId: string,
    twins: string[],
    patch: Partial<ChatStateValue>,
    create?: boolean,
  ): Promise<void>;
  /** (Re)load the in-memory mirror from the table (boot, and after a full-replace restore). */
  reload(): Promise<void>;
  /** Forget every chat state of one session (an unlink: the next account to link it starts clean). */
  clearSession(sessionId: string): Promise<void>;
  /** Forget the named chats of one session (a deleted chat a later message re-creates: it starts clean). */
  forget(sessionId: string, chatIds: string[]): Promise<void>;
  /** Re-read one session's rows from the table (a start: another node may have written them since). */
  refreshSession(sessionId: string): Promise<void>;
}

const DEFAULT_STATE: ChatStateValue = { muteEndTime: null, archived: false, pinned: false, deletedAt: null };

/** The field's value, an absent `deletedAt` (a row or patch from before it was kept) read as its default. */
const valueOf = (v: Partial<ChatStateValue>, field: ChatStateField) => v[field] ?? DEFAULT_STATE[field];

function fromRow(row: ChatState): ChatStateValue {
  return {
    muteEndTime: row.muteEndTime,
    archived: row.archived,
    pinned: row.pinned,
    deletedAt: row.deletedAt ?? null,
    updatedAt: row.updatedAt?.getTime(),
    observed: row.observed == null ? undefined : (row.observed.split(',').filter(Boolean) as ChatStateField[]),
  };
}

/**
 * Whether a row saw a value for the field. A row written before `observed` was kept saw its set fields
 * only: such a row was created by the first patch that set something, so a default there almost always
 * means the field never reached it. Reading every field of it as seen let a legacy row holding only a
 * mute outweigh an older legacy pin. The first patch written onto a legacy row after it has been read
 * records its observed list (a blind write, made when the row could not be read, does not), so the
 * cost is limited to a clear made before the column existed or written blind: it loses to an older
 * set value on a twin row.
 */
const saw = (v: ChatStateValue, field: ChatStateField): boolean =>
  v.observed ? v.observed.includes(field) : valueOf(v, field) !== DEFAULT_STATE[field];

/**
 * One chat's rows under several spellings, merged field by field: each field comes from the newest row
 * that observed it (see {@link saw}), else from the newest row. A row created by a lone pin carries a
 * default mute it never saw, so taking the newest row whole would drop a mute kept on the other;
 * favouring any set value instead would bring back a pin the newer row explicitly cleared. The result
 * observed what any of the rows did.
 */
export function mergeTwinStates(rows: ChatStateValue[]): ChatStateValue | undefined {
  if (!rows.length) return undefined;
  const sorted = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const out: ChatStateValue = { ...sorted[0] };
  for (const field of FIELDS) {
    const from = sorted.find(r => saw(r, field));
    if (from) Object.assign(out, { [field]: from[field] });
  }
  out.observed = FIELDS.filter(f => sorted.some(r => saw(r, f)));
  return out;
}

type SessionWrites = { pending: Set<Promise<void>>; seq: number; generation: number };

const SEP = '\u0000'; // a null byte never appears in a session name or JID, so the join cannot collide

// One global LRU across all sessions, default 5000, matching the other engine maps. A
// many-session deployment with large chat lists should raise BAILEYS_CHAT_STATE_CACHE_MAX; an evicted
// row stays persisted and both paths read-through on a miss (the read warms lazily, the write merges
// the patch onto the persisted row), so eviction costs a re-read, never data loss. The first read of an
// evicted row still answers undefined, so the chat list shows that chat's live record once; the first
// eviction is logged for that reason.
export const CHAT_STATE_CACHE_DEFAULT = 5000;

/**
 * Backs the Baileys `muted`/`archived`/`pinned` chat fields with the persisted {@link ChatState} table.
 * The read is synchronous (the chat list cannot await a query), so the table is loaded into an in-memory
 * map on boot and kept warm by write-through. Live `chats.update` mutations update it (an unmute arrives
 * as `muteEndTime: null` and correctly clears); a fresh process rehydrates from the table, which is why
 * a chat muted before a restart still reads muted afterwards.
 */
@Injectable()
export class ChatStateStoreService implements ChatStateStore, OnModuleInit {
  private readonly logger = createLogger('ChatStateStore');
  private readonly states = new Map<string, ChatStateValue>();
  /** Repository fallbacks in flight, one per key, so a hot miss path can't stack duplicate queries. */
  private readonly pendingLookups = new Set<string>();
  /**
   * Keys the table has no row for, so a chat never muted, archived or pinned (most of them) is not
   * queried again on every chat-list read. Kept apart from `states` so it never evicts a real row;
   * bounded by the same cap, and a key leaves it the moment a state is indexed for it. Only consulted
   * for a session that is not in {@link completeSessions}.
   */
  private readonly absent = new Set<string>();
  /**
   * Sessions whose every persisted row is in `states`, so a miss there means "no row" without a query.
   * Proving absence key by key instead cost one query per never-muted chat per start, and once the
   * chats across sessions outgrew the cap the FIFO `absent` set cycled and every chat list queried
   * once per chat. A session joins after an untruncated load no write overlapped, and leaves when one
   * of its rows is evicted or a write could not be indexed; every other write indexes before it
   * persists, so the mark stays true.
   */
  private readonly completeSessions = new Set<string>();
  /** Bumped by every write that indexes or persists, so a load can tell a write overlapped its read. */
  private writeSeq = 0;
  /**
   * Per session: its writes queued or running, a count bumped like {@link writeSeq} by its own writes
   * only, so a refresh is not held up by another session's traffic, and the generation
   * {@link clearSession} bumps, so a write queued before an unlink cannot re-create a row after it.
   */
  private readonly sessionWrites = new Map<string, SessionWrites>();
  private warnedEviction = false;
  private readonly maxEntries: number;
  /**
   * One write chain per chat, so each remember() merges onto the state the previous one left. A fold
   * holds the chains of its twins as well (see {@link enqueue}).
   */
  private readonly writes = new KeyedMutationQueue();
  /**
   * A load (reload, refreshSession, a read-through) reads the table while writes go on, so its rows can
   * be older than a change made after the read began. `inFlight` counts a chat's writes and forgets
   * queued or running. Each one, as it settles, and every unlink of a session takes the next `touchSeq`
   * and is recorded in `touched` under the chat's key (the session's prefix, for an unlink). A load
   * notes `touchSeq` before it reads and, when the answer comes, skips any row {@link changedSince}
   * flags. `touched` is bounded by the cache cap: when full it is dropped and `touchedFloor` makes every
   * load begun before then distrust all of its rows, which only costs those chats another read.
   */
  private readonly inFlight = new Map<string, number>();
  private touchSeq = 0;
  private touchedFloor = 0;
  private readonly touched = new Map<string, number>();
  /** The `updatedAt` of the last write, so the next one never shares it (see {@link stamp}). */
  private lastStamp = 0;

  constructor(
    @InjectRepository(ChatState, 'data')
    private readonly repo: Repository<ChatState>,
  ) {
    this.maxEntries = resolveNonNegativeIntEnv(process.env.BAILEYS_CHAT_STATE_CACHE_MAX, CHAT_STATE_CACHE_DEFAULT);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const seq = this.writeSeq;
    const idle = this.writes.size === 0;
    const since = this.touchSeq;
    // Dropped before the read, as refreshSession does: a restore may have replaced the table, so if
    // the read fails, every chat not cached must read through rather than trust a stale mark.
    this.completeSessions.clear();
    this.absent.clear();
    try {
      const rows = await this.repo.find({
        order: { updatedAt: 'DESC' },
        take: this.maxEntries > 0 ? this.maxEntries : undefined,
      });
      this.states.clear();
      this.absent.clear();
      this.completeSessions.clear();
      // Oldest first, so the newest row ends at the most-recent end of the LRU rather than the first
      // one evicted (the query is DESC only so `take` keeps the newest rows).
      let skipped = false;
      for (const row of [...rows].reverse()) {
        const k = this.key(row.sessionId, row.chatId);
        if (this.changedSince(k, since)) skipped = true;
        else this.index(k, fromRow(row));
      }
      if (this.loadWasWhole(rows.length, idle && this.writeSeq === seq && this.writes.size === 0 && !skipped)) {
        for (const row of rows) this.completeSessions.add(row.sessionId);
      }
      this.logger.log(
        `Loaded ${rows.length} chat states into cache${this.maxEntries ? ` (cap ${this.maxEntries})` : ''}`,
      );
    } catch (err) {
      this.logger.warn(`Could not preload chat states: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get(sessionId: string, chatId: string): ChatStateValue | undefined {
    const k = this.key(sessionId, chatId);
    if (this.states.has(k)) {
      const value = this.states.get(k)!;
      this.states.delete(k); // LRU touch: re-insert at the most-recent end
      this.states.set(k, value);
      return value;
    }
    if (!this.completeSessions.has(sessionId) && !this.absent.has(k)) this.warmFromTable(k, sessionId, chatId);
    return undefined;
  }

  chatIds(sessionId: string): string[] {
    const prefix = `${sessionId}${SEP}`;
    return [...this.states.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
  }

  /**
   * Serialized per chat: the caller does not await, so two patches for an uncached chat would otherwise
   * both merge onto the same pre-change row and the later full-row write would drop the earlier patch.
   */
  remember(sessionId: string, chatId: string, patch: Partial<ChatStateValue>, create = true): Promise<void> {
    const k = this.key(sessionId, chatId);
    const generation = this.writesOf(sessionId).generation;
    return this.enqueue(sessionId, [k], async () => {
      await this.applyPatch(k, sessionId, chatId, patch, generation, create);
    });
  }

  fold(
    sessionId: string,
    chatId: string,
    twins: string[],
    patch: Partial<ChatStateValue>,
    create = true,
  ): Promise<void> {
    const k = this.key(sessionId, chatId);
    const generation = this.writesOf(sessionId).generation;
    const keys = [...new Set([k, ...twins.map(twin => this.key(sessionId, twin))])];
    return this.enqueue(sessionId, keys, () => this.applyFold(k, sessionId, chatId, twins, patch, generation, create));
  }

  /**
   * Queues work on the write chain of each key and counts it under the session until it settles. The
   * work starts once it is first in line on all of them and holds them until it ends. Every chain is
   * joined in this one synchronous step, so they all order their work alike and two works sharing
   * chains can never each wait for the other; the work itself must not queue on a chain it holds.
   */
  private enqueue(sessionId: string, keys: string[], work: () => Promise<void>): Promise<void> {
    const { pending } = this.writesOf(sessionId);
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const turns = keys.map(k => {
      this.inFlight.set(k, (this.inFlight.get(k) ?? 0) + 1);
      return new Promise<void>(turn =>
        this.writes.enqueue(k, () => {
          turn();
          return held;
        }),
      );
    });
    // Settled inside the chains, before the work counts as done, so a load never sees the chat idle
    // without also seeing the change.
    const done = Promise.all(turns).then(() =>
      work().finally(() => {
        for (const k of keys) this.settled(k);
        release();
      }),
    );
    pending.add(done);
    const settle = () => pending.delete(done);
    done.then(settle, settle);
    return done;
  }

  /**
   * The `updatedAt` of a write: the clock, or one millisecond past the previous write when the clock has
   * not moved past it. Twin rows rank by it and a tie goes to the phone row, so a write of a twin made in
   * the same millisecond as one of the phone row would rank older however late it came. A burst of
   * writes runs it ahead of the clock by its writes beyond one per millisecond, until the clock catches up.
   * A lead of more than a minute is no burst (5000 writes at once lead by about 4 s) but the clock set
   * back, and the stamp follows the clock again: kept, it would date every later write up to that far
   * ahead, past a twin row a restarted process or another node writes in the meantime.
   */
  private stamp(): Date {
    const now = Date.now();
    this.lastStamp = this.lastStamp - now > 60_000 ? now : Math.max(now, this.lastStamp + 1);
    return new Date(this.lastStamp);
  }

  private writesOf(sessionId: string): SessionWrites {
    let writes = this.sessionWrites.get(sessionId);
    if (!writes) {
      writes = { pending: new Set(), seq: 0, generation: 0 };
      this.sessionWrites.set(sessionId, writes);
    }
    return writes;
  }

  /** True once {@link clearSession} ran after the write was queued: it must neither index nor persist. */
  private cleared(sessionId: string, generation: number): boolean {
    return this.writesOf(sessionId).generation !== generation;
  }

  private bumpWriteSeq(sessionId: string): void {
    this.writeSeq++;
    this.writesOf(sessionId).seq++;
  }

  /** One write or forget of the chat is over: it no longer counts as in flight, and the chat has changed. */
  private settled(k: string): void {
    const left = (this.inFlight.get(k) ?? 1) - 1;
    if (left > 0) this.inFlight.set(k, left);
    else this.inFlight.delete(k);
    this.touch(k);
  }

  /** Records a change to the chat `key`, or to a whole session when it is the session's prefix. */
  private touch(key: string): void {
    if (this.maxEntries && this.touched.size >= this.maxEntries) {
      this.touched.clear();
      this.touchedFloor = this.touchSeq;
    }
    this.touched.set(key, ++this.touchSeq);
  }

  /**
   * Whether the row a load read for chat `k` may be older than the chat's state: a write or forget of
   * it is under way, or it, or its session, changed after the load began at `since`.
   */
  private changedSince(k: string, since: number): boolean {
    if (this.inFlight.has(k)) return true;
    const last = (key: string): number => this.touched.get(key) ?? this.touchedFloor;
    return last(k) > since || last(k.slice(0, k.indexOf(SEP) + 1)) > since;
  }

  /**
   * The rows merge by {@link mergeTwinStates}, and each row is read from the table when the cache does
   * not hold it: a key the cache lacks may still have a newer row on disk, so a cached twin alone must
   * not win. When a read fails the merge cannot be told, so only the patch is applied and the twins stay;
   * they stay too when the merged row could not be written, or they would be its only copy on disk.
   */
  private async applyFold(
    k: string,
    sessionId: string,
    chatId: string,
    twins: string[],
    patch: Partial<ChatStateValue>,
    generation: number,
    create: boolean,
  ): Promise<void> {
    const rows: ChatStateValue[] = [];
    const found: string[] = [];
    try {
      const own = await this.peek(k, sessionId, chatId);
      if (own) rows.push(own);
      for (const twin of twins) {
        const v = await this.peek(this.key(sessionId, twin), sessionId, twin);
        if (!v) continue;
        found.push(twin);
        rows.push(v);
      }
    } catch {
      await this.applyPatch(k, sessionId, chatId, patch, generation, create);
      return;
    }
    if (!found.length) {
      await this.applyPatch(k, sessionId, chatId, patch, generation, create);
      return;
    }
    // Only the fields some row observed are carried, so the folded row still tells them from defaults.
    const merged = mergeTwinStates(rows)!;
    const base = Object.fromEntries(FIELDS.filter(f => saw(merged, f)).map(f => [f, merged[f]]));
    if (await this.applyPatch(k, sessionId, chatId, { ...base, ...patch }, generation)) {
      // Deleted here, not through forget(), which would queue behind this fold on the chains it holds.
      await Promise.all(
        found.map(twin => {
          const tk = this.key(sessionId, twin);
          this.states.delete(tk);
          this.markAbsent(tk);
          return this.drop(sessionId, twin);
        }),
      );
    }
  }

  /**
   * The row as the table holds it: the cache when it has the key or knows it absent, else a query. The
   * fold holds the chain of every key it reads, so no write or forget of the chat lands between the read
   * and its answer, and a miss is recorded like a listing's, or every fold of a lid-addressed chat would
   * query its twin again.
   */
  private async peek(k: string, sessionId: string, chatId: string): Promise<ChatStateValue | undefined> {
    const cached = this.states.get(k);
    if (cached || this.completeSessions.has(sessionId) || this.absent.has(k)) return cached;
    const row = await this.repo.findOne({ where: { sessionId, chatId } });
    if (!row && !this.states.has(k)) this.markAbsent(k);
    return row ? fromRow(row) : undefined;
  }

  /** True once the table holds the result: written, or already equal to it. */
  private async applyPatch(
    k: string,
    sessionId: string,
    chatId: string,
    patch: Partial<ChatStateValue>,
    generation: number,
    create = true,
  ): Promise<boolean> {
    if (this.cleared(sessionId, generation)) return false;
    // The merge base must be the CURRENT state, not DEFAULT_STATE, or a partial `chats.update` (Baileys
    // emits single-field patches, e.g. `{ pinned }` alone) would reset the columns it omits. On a cache
    // miss the persisted row is that base: the read path warms lazily, but the write path upserts every
    // column, so it has to read-through first or a lone pin update on an evicted muted chat wipes its
    // mute. A row absent from the table resolves to DEFAULT_STATE, which is the correct base for a chat
    // whose state has never been persisted. A read that FAILS is not an absent row: with no base to
    // merge onto, only the patched columns are written (see persistBlind) and the cache stays cold, so
    // the next read warms from the table instead of from a guess.
    let existing = this.states.get(k);
    if (!existing) {
      // A patch that may not create a row and only restates defaults has nothing to write for a chat
      // with no row; the table and the absent set answer that without a query where they can.
      const restatesDefaults =
        !create && FIELDS.every(f => !Object.hasOwn(patch, f) || valueOf(patch, f) === DEFAULT_STATE[f]);
      if (restatesDefaults && (this.completeSessions.has(sessionId) || this.absent.has(k))) return true;
      let row: ChatState | null;
      try {
        row = await this.repo.findOne({ where: { sessionId, chatId } });
      } catch {
        if (this.cleared(sessionId, generation)) return false;
        // Persisted but not indexed, so the session's cache no longer holds all of its rows.
        this.bumpWriteSeq(sessionId);
        this.completeSessions.delete(sessionId);
        const ok = await this.persistBlind(sessionId, chatId, patch, !restatesDefaults);
        this.absent.delete(k);
        return ok;
      }
      if (this.cleared(sessionId, generation)) return false;
      if (!row && restatesDefaults) {
        this.markAbsent(k);
        return true;
      }
      existing = row ? fromRow(row) : { ...DEFAULT_STATE, observed: [] };
    }
    // Every patched field is recorded as observed, on a new row and on a legacy one alike, so a lone
    // unpin still writes: it has to outweigh an older pin on a twin row of the chat.
    const existingRow = existing;
    const observed = FIELDS.filter(f => saw(existingRow, f) || Object.hasOwn(patch, f));
    const next: ChatStateValue = { ...existing, ...patch, updatedAt: existing.updatedAt, observed };
    if (
      FIELDS.every(f => valueOf(existingRow, f) === valueOf(next, f) && saw(existingRow, f) === observed.includes(f))
    ) {
      this.index(k, next); // warm the cache even on a no-op so the next read is a hit
      return true; // nothing changed against the current state; skip the write that would just churn updatedAt
    }
    const at = this.stamp();
    next.updatedAt = at.getTime();
    this.bumpWriteSeq(sessionId);
    this.index(k, next);
    const persisted = await this.persist(sessionId, chatId, next, at);
    if (!persisted) {
      // The value was never stored, so a later patch equal to it must not be read as a no-op, nor a fold
      // delete its twins on the strength of it: the next write reads the table again.
      this.states.delete(k);
      this.completeSessions.delete(sessionId);
    }
    return persisted;
  }

  private async persist(
    sessionId: string,
    chatId: string,
    values: Partial<ChatStateValue>,
    at: Date,
  ): Promise<boolean> {
    const columns: Record<string, unknown> = { ...values, observed: values.observed?.join(',') };
    delete columns.updatedAt;
    try {
      await this.repo.upsert({ sessionId, chatId, ...columns, updatedAt: at }, ['sessionId', 'chatId']);
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed to persist chat state for ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Writes the patched columns when the row could not be read. A new row records what the patch
   * carried, like any new row, or its unset columns would read as observed defaults; an existing row
   * keeps its own observed list. `create` false only updates a row that exists.
   */
  private async persistBlind(
    sessionId: string,
    chatId: string,
    patch: Partial<ChatStateValue>,
    create: boolean,
  ): Promise<boolean> {
    const carried = FIELDS.filter(f => Object.hasOwn(patch, f));
    const columns = Object.fromEntries(carried.map(f => [f, patch[f]]));
    const updatedAt = this.stamp();
    try {
      if (create) {
        await this.repo
          .createQueryBuilder()
          .insert()
          .values({ sessionId, chatId, ...columns, observed: carried.join(','), updatedAt })
          .orIgnore()
          .execute();
      }
      await this.repo.update({ sessionId, chatId }, { ...columns, updatedAt });
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed to persist chat state for ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Fences the session's writes first: one queued before the unlink skips its write, and the delete
   * waits for any already writing, so none can land after it and hand the old account's chat to the
   * next one.
   */
  async clearSession(sessionId: string): Promise<void> {
    const writes = this.writesOf(sessionId);
    writes.generation++;
    await Promise.allSettled([...writes.pending]);
    await this.repo.delete({ sessionId });
    // Evicted after the delete, so a read-through that raced it cannot leave a deleted row cached.
    const prefix = `${sessionId}${SEP}`;
    for (const k of [...this.states.keys()]) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
    // And noted, for a load whose read ran before the delete and is answered after these entries go.
    this.touch(prefix);
  }

  /**
   * Queued behind each chat's pending writes, so a patch still in flight cannot re-create the row. The
   * cache drops the chat at once and knows it absent, so a listing in the meantime neither shows it nor
   * warms it back from the table; the drop repeats after the delete for a patch queued ahead of it.
   */
  async forget(sessionId: string, chatIds: string[]): Promise<void> {
    await Promise.all(
      chatIds.map(chatId => {
        const k = this.key(sessionId, chatId);
        this.states.delete(k);
        this.markAbsent(k);
        return this.enqueue(sessionId, [k], () => this.drop(sessionId, chatId));
      }),
    );
  }

  /** Deletes the chat's row; run with the chat's write chain held. */
  private async drop(sessionId: string, chatId: string): Promise<void> {
    const k = this.key(sessionId, chatId);
    try {
      await this.repo.delete({ sessionId, chatId });
      this.markAbsent(k);
    } catch (err) {
      this.logger.warn(
        `Failed to forget chat state for ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.states.delete(k);
  }

  /**
   * Replaces the session's cached rows, the ones known absent included, with what the table holds now,
   * so the first chat list after a start already reads it; a row changed or deleted while another node
   * held the session would otherwise stay cached. Awaited before the socket opens: dropping the entries
   * and warming them lazily instead would serve that first list from the live record, which carries no
   * mute, archive or pin after a reconnect. A failed read keeps the cached rows, which are no worse
   * than before, and only makes the absent ones read through again.
   */
  async refreshSession(sessionId: string): Promise<void> {
    const prefix = `${sessionId}${SEP}`;
    const writes = this.writesOf(sessionId);
    const seq = writes.seq;
    const idle = writes.pending.size === 0;
    const since = this.touchSeq;
    this.completeSessions.delete(sessionId);
    let rows: ChatState[] | undefined;
    try {
      rows = await this.repo.find({
        where: { sessionId },
        order: { updatedAt: 'DESC' },
        take: this.maxEntries > 0 ? this.maxEntries : undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Could not refresh chat states for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const k of [...this.absent]) {
      if (k.startsWith(prefix)) this.absent.delete(k);
    }
    if (!rows) return;
    // Dropped again here, as reload does: a refresh begun later may have marked the session complete
    // while this read was out, and dropping the entries below leaves the cache short of its rows.
    this.completeSessions.delete(sessionId);
    for (const k of [...this.states.keys()]) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
    let skipped = false;
    for (const row of [...rows].reverse()) {
      // Oldest first, as in reload.
      const k = this.key(sessionId, row.chatId);
      if (this.changedSince(k, since)) skipped = true;
      else this.index(k, fromRow(row));
    }
    // Marked after the loop: indexing these rows can evict other sessions' keys, never this one's.
    // Only this session's writes can leave its keys out of the load, so another session's do not count.
    if (this.loadWasWhole(rows.length, idle && writes.seq === seq && writes.pending.size === 0 && !skipped)) {
      this.completeSessions.add(sessionId);
    }
  }

  /**
   * True when a load holds every row it asked for and no write was in flight from the start of its read
   * to the end, and it set none of its rows aside as older than a change (`quiet`). A write in flight
   * during the read may be missing from `rows` while its key was just dropped from the cache, even one
   * that finished before the read did, and a row set aside is not cached, so the session cannot be
   * vouched for; skipping the mark only keeps the read-through path.
   */
  private loadWasWhole(count: number, quiet: boolean): boolean {
    return quiet && (this.maxEntries === 0 || count < this.maxEntries);
  }

  /** Warm a cache miss from the table. This lookup still returns undefined (the read cannot await); the next hits. */
  private warmFromTable(k: string, sessionId: string, chatId: string): void {
    if (this.pendingLookups.has(k)) return;
    this.pendingLookups.add(k);
    const since = this.touchSeq;
    void this.repo
      .findOne({ where: { sessionId, chatId } })
      .then(row => {
        // An answer older than a change to the chat is dropped, not cached and not read as "no row": the
        // next read asks again.
        if (this.states.has(k) || this.changedSince(k, since)) return;
        if (row) this.index(k, fromRow(row));
        else this.markAbsent(k);
      })
      .catch(() => undefined)
      .finally(() => this.pendingLookups.delete(k));
  }

  private markAbsent(k: string): void {
    this.absent.add(k);
    if (this.maxEntries && this.absent.size > this.maxEntries) {
      this.absent.delete(this.absent.values().next().value!);
    }
  }

  private index(k: string, value: ChatStateValue): void {
    this.absent.delete(k);
    this.states.delete(k); // re-insert so the entry moves to the most-recent end even on update
    this.states.set(k, value);
    this.evictIfOverCap();
  }

  private evictIfOverCap(): void {
    if (!this.maxEntries) return; // unbounded
    while (this.states.size > this.maxEntries) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
      this.completeSessions.delete(oldest.slice(0, oldest.indexOf(SEP)));
      if (!this.warnedEviction) {
        this.warnedEviction = true;
        this.logger.warn(
          `Chat state cache is full (${this.maxEntries}); raise BAILEYS_CHAT_STATE_CACHE_MAX so pin, mute and archive stay cached`,
        );
      }
    }
  }

  private key(sessionId: string, chatId: string): string {
    return `${sessionId}${SEP}${chatId}`;
  }
}
