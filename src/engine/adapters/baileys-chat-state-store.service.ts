import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatState } from './baileys-chat-state.entity';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

/** Durable chat app-state Baileys cannot re-deliver on reconnect. `muteEndTime` is canonical epoch ms. */
export type ChatStateValue = { muteEndTime: number | null; archived: boolean; pinned: boolean };

/**
 * Narrow read/write port over the persisted `chat_states` table. The Baileys session store depends on
 * this (a sync read on the chat-list hot path plus write-through), on the interface not the concrete
 * service, so the store stays unit-testable with a fake (mirrors {@link LidMappingStore}).
 */
export interface ChatStateStore {
  /** Sync read from the in-memory mirror; undefined = no persisted state for this chat (defaults apply). */
  get(sessionId: string, chatId: string): ChatStateValue | undefined;
  /** Write-through, last-write-wins: merge the patch into the stored state and persist. */
  remember(sessionId: string, chatId: string, patch: Partial<ChatStateValue>): Promise<void>;
  /** (Re)load the in-memory mirror from the table (boot, and after a full-replace restore). */
  reload(): Promise<void>;
}

const DEFAULT_STATE: ChatStateValue = { muteEndTime: null, archived: false, pinned: false };
const SEP = '\u0000'; // a null byte never appears in a session name or JID, so the join cannot collide

// One global LRU across all sessions, default 5000, matching the other engine maps. A
// many-session deployment with large chat lists should raise BAILEYS_CHAT_STATE_CACHE_MAX; an evicted
// row stays persisted and both paths read-through on a miss (the read warms lazily, the write merges
// the patch onto the persisted row), so eviction costs a re-read, never data loss.
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
  private readonly maxEntries: number;

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
    try {
      const rows = await this.repo.find({
        order: { updatedAt: 'DESC' },
        take: this.maxEntries > 0 ? this.maxEntries : undefined,
      });
      this.states.clear();
      for (const row of rows) {
        this.index(this.key(row.sessionId, row.chatId), {
          muteEndTime: row.muteEndTime,
          archived: row.archived,
          pinned: row.pinned,
        });
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
    this.warmFromTable(k, sessionId, chatId);
    return undefined;
  }

  async remember(sessionId: string, chatId: string, patch: Partial<ChatStateValue>): Promise<void> {
    const k = this.key(sessionId, chatId);
    // The merge base must be the CURRENT state, not DEFAULT_STATE, or a partial `chats.update` (Baileys
    // emits single-field patches, e.g. `{ pinned }` alone) would reset the columns it omits. On a cache
    // miss the persisted row is that base: the read path warms lazily, but the write path upserts every
    // column, so it has to read-through first or a lone pin update on an evicted muted chat wipes its
    // mute. A row absent from the table resolves to DEFAULT_STATE, which is the correct base for a chat
    // whose state has never been persisted.
    let existing = this.states.get(k);
    if (!existing) {
      const row = await this.repo.findOne({ where: { sessionId, chatId } }).catch(() => null);
      existing = row ? { muteEndTime: row.muteEndTime, archived: row.archived, pinned: row.pinned } : DEFAULT_STATE;
    }
    const next: ChatStateValue = { ...existing, ...patch };
    if (
      existing.muteEndTime === next.muteEndTime &&
      existing.archived === next.archived &&
      existing.pinned === next.pinned
    ) {
      this.index(k, next); // warm the cache even on a no-op so the next read is a hit
      return; // nothing changed against the current state; skip the write that would just churn updatedAt
    }
    this.index(k, next);
    try {
      await this.repo.upsert({ sessionId, chatId, ...next, updatedAt: new Date() }, ['sessionId', 'chatId']);
    } catch (err) {
      this.logger.warn(
        `Failed to persist chat state for ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Warm a cache miss from the table. This lookup still returns undefined (the read cannot await); the next hits. */
  private warmFromTable(k: string, sessionId: string, chatId: string): void {
    if (this.pendingLookups.has(k)) return;
    this.pendingLookups.add(k);
    void this.repo
      .findOne({ where: { sessionId, chatId } })
      .then(row => {
        if (row && !this.states.has(k)) {
          this.index(k, { muteEndTime: row.muteEndTime, archived: row.archived, pinned: row.pinned });
        }
      })
      .catch(() => undefined)
      .finally(() => this.pendingLookups.delete(k));
  }

  private index(k: string, value: ChatStateValue): void {
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
    }
  }

  private key(sessionId: string, chatId: string): string {
    return `${sessionId}${SEP}${chatId}`;
  }
}
