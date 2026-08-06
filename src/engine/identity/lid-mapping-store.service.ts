import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LidMapping } from './lid-mapping.entity';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

// Default cap on the in-memory lid->phone mirror. Every other long-lived map in the audited surface is
// bounded (the per-session lidPhoneCache is 5000); the LID mirror was the lone exception. A miss falls
// back to engine re-resolution, so the cap trades a re-resolution for bounded memory, never data loss.
export const LID_MAPPING_CACHE_DEFAULT = 5000;

/**
 * Narrow read/write port over the `lid -> phone` table. The Baileys session store depends on this (sync
 * reads on the resolution hot path + write-through) and the message from-filter depends on the reverse
 * lookup - both on the interface, not the concrete service, so each stays unit-testable with a fake
 * (mirrors {@link BaileysMessageStore}).
 */
export interface LidMappingStore {
  /**
   * Sync read from the in-memory cache: phone digits, `null` = known-unresolved, `undefined` = never
   * seen. A miss is warmed from the persisted table in the background, so a later read can hit.
   */
  getCached(lid: string): string | null | undefined;
  /** Sync reverse lookup: the lids currently mapped to this phone (used by the message from-filter). */
  lidsForPhone(phone: string): string[];
  /** Write-through, last-write-wins: update the cache + persist. A `null` phone records a negative result. */
  remember(lid: string, phone: string | null, sessionId?: string): Promise<void>;
}

/**
 * Backs lid resolution with the persisted {@link LidMapping} table. Resolution must be synchronous
 * (filters/dispatch can't await a query), so the table is loaded into an in-memory map on boot and kept
 * warm by write-through. A forward map (lid -> phone) serves resolution; a reverse map (phone -> lids)
 * serves the from-filter.
 *
 * The forward map is bounded by an LRU cap (`LID_MAPPING_CACHE_MAX`, default 5000) so a long-running,
 * contact-heavy account does not accumulate one entry per distinct LID ever seen into a slow memory leak.
 * A cache miss is warmed from the table in the background (rows past the preload cap stay resolvable)
 * and otherwise falls back to engine re-resolution (the table remains the source of truth), so eviction
 * only costs a re-resolution, never data loss. The reverse map is reconciled on each eviction so it does
 * not retain entries for LIDs no longer in the forward cache.
 */
@Injectable()
export class LidMappingStoreService implements LidMappingStore, OnModuleInit {
  private readonly logger = createLogger('LidMappingStore');
  private readonly lidToPhone = new Map<string, string | null>();
  private readonly phoneToLids = new Map<string, Set<string>>();
  /** Repository fallbacks in flight, one per lid, so a hot miss path can't stack duplicate queries. */
  private readonly pendingLookups = new Set<string>();
  // 0 = unbounded (legacy behaviour). Every other long-lived map in the audited surface is bounded, so
  // the default is finite; the env override exists for operators who explicitly want the old behaviour.
  private readonly maxCachedLids: number;

  constructor(
    @InjectRepository(LidMapping, 'data')
    private readonly repo: Repository<LidMapping>,
  ) {
    this.maxCachedLids = resolveNonNegativeIntEnv(process.env.LID_MAPPING_CACHE_MAX, LID_MAPPING_CACHE_DEFAULT);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /**
   * (Re)load the in-memory mirror from the table. Called on boot, and by the infra data import after
   * a committed full-replace restore — the mirror is otherwise write-through only, so restored rows
   * would never reach it and entries the restore removed would stay resolvable until the next start.
   * Never throws: a missing table (migration not yet applied) or a read error must not block boot or
   * fail the import — resolution falls back to engine re-resolution until the table is readable.
   */
  async reload(): Promise<void> {
    try {
      // Deterministic preload: an unordered find() followed by LRU eviction keeps an ARBITRARY
      // subset once the table exceeds the cap. Order by last-write and take at most the cap, so
      // the resident subset is the most-recently-written mappings; older rows stay persisted and
      // are warmed back on the first cache miss (see getCached).
      const rows = await this.repo.find({
        order: { updatedAt: 'DESC' },
        take: this.maxCachedLids > 0 ? this.maxCachedLids : undefined,
      });
      this.lidToPhone.clear();
      this.phoneToLids.clear();
      for (const row of rows) {
        this.index(row.lid, row.phone);
      }
      this.logger.log(
        `Loaded ${rows.length} lid->phone mappings into cache${this.maxCachedLids ? ` (cap ${this.maxCachedLids})` : ''}`,
      );
    } catch (err) {
      this.logger.warn(`Could not preload lid->phone mappings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getCached(lid: string): string | null | undefined {
    // LRU touch: re-insert the entry so iteration order (insertion order for Map) tracks recency.
    // A missed lookup returns undefined without disturbing the order.
    if (this.lidToPhone.has(lid)) {
      const phone = this.lidToPhone.get(lid);
      this.lidToPhone.delete(lid);
      this.lidToPhone.set(lid, phone as string | null);
      return phone;
    }
    this.warmFromTable(lid);
    return undefined;
  }

  lidsForPhone(phone: string): string[] {
    const set = this.phoneToLids.get(phone);
    return set ? [...set] : [];
  }

  async remember(lid: string, phone: string | null, sessionId?: string): Promise<void> {
    if (!lid || this.lidToPhone.get(lid) === phone) {
      return; // unseen-or-changed only; a no-op write would just churn updatedAt
    }
    this.index(lid, phone);
    try {
      await this.repo.upsert({ lid, phone, sessionId: sessionId ?? null, updatedAt: new Date() }, ['lid']);
    } catch (err) {
      this.logger.warn(
        `Failed to persist lid->phone mapping for ${lid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Repository fallback for a cache miss. Rows past the preload cap (or evicted by the LRU) are
   * still persisted, so a miss is warmed from the table: THIS lookup still returns undefined —
   * the sync read contract can't await, and callers fall back to engine re-resolution — but the
   * next one hits. A table miss is NOT cached (a false negative would shadow a later remember);
   * a read error is swallowed (the table may not exist yet), the same posture as reload().
   */
  private warmFromTable(lid: string): void {
    if (!lid || this.pendingLookups.has(lid)) return;
    this.pendingLookups.add(lid);
    void this.repo
      .findOne({ where: { lid } })
      .then(row => {
        // Last-write-wins: a remember() that landed while the lookup was in flight is newer.
        if (row && !this.lidToPhone.has(row.lid)) {
          this.index(row.lid, row.phone);
        }
      })
      .catch(() => undefined)
      .finally(() => this.pendingLookups.delete(lid));
  }

  /** Update both in-memory indexes, dropping any stale reverse entry from a previous phone. */
  private index(lid: string, phone: string | null): void {
    const prev = this.lidToPhone.get(lid);
    if (prev && prev !== phone) {
      this.phoneToLids.get(prev)?.delete(lid);
    }
    // Re-insert (delete + set) so the entry moves to the most-recent end of the LRU order even on update.
    this.lidToPhone.delete(lid);
    this.lidToPhone.set(lid, phone);
    if (phone) {
      const set = this.phoneToLids.get(phone) ?? new Set<string>();
      set.add(lid);
      this.phoneToLids.set(phone, set);
    }
    this.evictIfOverCap();
  }

  /** Evict the least-recently-used forward entry (and its reverse index) while over the cap. */
  private evictIfOverCap(): void {
    if (!this.maxCachedLids) return; // unbounded
    while (this.lidToPhone.size > this.maxCachedLids) {
      const oldest = this.lidToPhone.keys().next().value;
      if (oldest === undefined) break;
      const phone = this.lidToPhone.get(oldest);
      this.lidToPhone.delete(oldest);
      if (phone) this.phoneToLids.get(phone)?.delete(oldest);
    }
  }
}
