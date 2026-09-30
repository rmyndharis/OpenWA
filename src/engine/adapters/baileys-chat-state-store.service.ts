import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatState } from './baileys-chat-state.entity';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';

export type ChatStateField = 'muteEndTime' | 'archived' | 'pinned';
const FIELDS: ChatStateField[] = ['muteEndTime', 'archived', 'pinned'];

/**
 * Durable chat app-state Baileys cannot re-deliver on reconnect. `muteEndTime` is canonical epoch ms.
 * `updatedAt` (epoch ms) is when the row last changed, when known; it is read, never written by a patch.
 * `observed` lists the fields the row has seen a value for, the others holding their default; undefined
 * on a row written before the list was kept, which counts its set fields as seen. Like `updatedAt`, a
 * patch never sets it.
 */
export type ChatStateValue = {
  muteEndTime: number | null;
  archived: boolean;
  pinned: boolean;
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
   * {@link remember} when no twin row is found.
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
  /** Forget the named chats of one session (a deleted chat: one a later message re-creates starts clean). */
  forget(sessionId: string, chatIds: string[]): Promise<void>;
  /** Re-read one session's rows from the table (a start: another node may have written them since). */
  refreshSession(sessionId: string): Promise<void>;
}

const DEFAULT_STATE: ChatStateValue = { muteEndTime: null, archived: false, pinned: false };

function fromRow(row: ChatState): ChatStateValue {
  return {
    muteEndTime: row.muteEndTime,
    archived: row.archived,
    pinned: row.pinned,
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
  v.observed ? v.observed.includes(field) : v[field] !== DEFAULT_STATE[field];

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
  private warnedEviction = false;
  private readonly maxEntries: number;
  /** One write chain per chat, so each remember() merges onto the state the previous one left. */
  private readonly writes = new KeyedMutationQueue();

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
      for (const row of [...rows].reverse()) {
        this.index(this.key(row.sessionId, row.chatId), fromRow(row));
      }
      if (this.loadWasWhole(rows.length, seq)) {
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
    return new Promise<void>((resolve, reject) =>
      this.writes.enqueue(k, () => this.applyPatch(k, sessionId, chatId, patch, create).then(() => resolve(), reject)),
    );
  }

  fold(
    sessionId: string,
    chatId: string,
    twins: string[],
    patch: Partial<ChatStateValue>,
    create = true,
  ): Promise<void> {
    const k = this.key(sessionId, chatId);
    return new Promise<void>((resolve, reject) =>
      this.writes.enqueue(k, () => this.applyFold(k, sessionId, chatId, twins, patch, create).then(resolve, reject)),
    );
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
      await this.applyPatch(k, sessionId, chatId, patch, create);
      return;
    }
    if (!found.length) {
      await this.applyPatch(k, sessionId, chatId, patch, create);
      return;
    }
    // Only the fields some row observed are carried, so the folded row still tells them from defaults.
    const merged = mergeTwinStates(rows)!;
    const base = Object.fromEntries(FIELDS.filter(f => saw(merged, f)).map(f => [f, merged[f]]));
    if (await this.applyPatch(k, sessionId, chatId, { ...base, ...patch })) {
      await this.forget(sessionId, found);
    }
  }

  /** The row as the table holds it: the cache when it has the key or knows it absent, else a query. */
  private async peek(k: string, sessionId: string, chatId: string): Promise<ChatStateValue | undefined> {
    const cached = this.states.get(k);
    if (cached || this.completeSessions.has(sessionId) || this.absent.has(k)) return cached;
    const row = await this.repo.findOne({ where: { sessionId, chatId } });
    return row ? fromRow(row) : undefined;
  }

  /** True once the table holds the result: written, or already equal to it. */
  private async applyPatch(
    k: string,
    sessionId: string,
    chatId: string,
    patch: Partial<ChatStateValue>,
    create = true,
  ): Promise<boolean> {
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
      const restatesDefaults = !create && FIELDS.every(f => !Object.hasOwn(patch, f) || patch[f] === DEFAULT_STATE[f]);
      if (restatesDefaults && (this.completeSessions.has(sessionId) || this.absent.has(k))) return true;
      let row: ChatState | null;
      try {
        row = await this.repo.findOne({ where: { sessionId, chatId } });
      } catch {
        // Persisted but not indexed, so the session's cache no longer holds all of its rows.
        this.writeSeq++;
        this.completeSessions.delete(sessionId);
        const ok = await this.persistBlind(sessionId, chatId, patch, !restatesDefaults);
        this.absent.delete(k);
        return ok;
      }
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
      existing.muteEndTime === next.muteEndTime &&
      existing.archived === next.archived &&
      existing.pinned === next.pinned &&
      FIELDS.every(f => saw(existingRow, f) === observed.includes(f))
    ) {
      this.index(k, next); // warm the cache even on a no-op so the next read is a hit
      return true; // nothing changed against the current state; skip the write that would just churn updatedAt
    }
    const at = new Date();
    next.updatedAt = at.getTime();
    this.writeSeq++;
    this.index(k, next);
    return this.persist(sessionId, chatId, next, at);
  }

  private async persist(
    sessionId: string,
    chatId: string,
    values: Partial<ChatStateValue>,
    at = new Date(),
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
    const updatedAt = new Date();
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

  async clearSession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
    // Evicted after the delete, so a read-through that raced it cannot leave a deleted row cached.
    const prefix = `${sessionId}${SEP}`;
    for (const k of [...this.states.keys()]) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
  }

  /** Queued behind each chat's pending writes, so a patch still in flight cannot re-create the row. */
  async forget(sessionId: string, chatIds: string[]): Promise<void> {
    await Promise.all(
      chatIds.map(chatId => {
        const k = this.key(sessionId, chatId);
        return new Promise<void>(resolve =>
          this.writes.enqueue(k, async () => {
            try {
              await this.repo.delete({ sessionId, chatId });
            } catch (err) {
              this.logger.warn(
                `Failed to forget chat state for ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            this.states.delete(k);
            resolve();
          }),
        );
      }),
    );
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
    const seq = this.writeSeq;
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
    for (const k of [...this.states.keys()]) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
    for (const row of [...rows].reverse()) {
      // Oldest first, as in reload.
      this.index(this.key(sessionId, row.chatId), fromRow(row));
    }
    // Marked after the loop: indexing these rows can evict other sessions' keys, never this one's.
    if (this.loadWasWhole(rows.length, seq)) this.completeSessions.add(sessionId);
  }

  /**
   * True when a load holds every row it asked for and no write ran meanwhile. A write in flight during
   * the read may be missing from `rows` while its key was just dropped from the cache, so the session
   * cannot be vouched for; skipping the mark only keeps the read-through path.
   */
  private loadWasWhole(count: number, seq: number): boolean {
    return (this.maxEntries === 0 || count < this.maxEntries) && this.writeSeq === seq && this.writes.size === 0;
  }

  /** Warm a cache miss from the table. This lookup still returns undefined (the read cannot await); the next hits. */
  private warmFromTable(k: string, sessionId: string, chatId: string): void {
    if (this.pendingLookups.has(k)) return;
    this.pendingLookups.add(k);
    void this.repo
      .findOne({ where: { sessionId, chatId } })
      .then(row => {
        if (this.states.has(k)) return;
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
