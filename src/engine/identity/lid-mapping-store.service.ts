import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LidMapping } from './lid-mapping.entity';
import { userPart } from './wa-id';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

// Default cap on the in-memory lid->phone mirror. Every other long-lived map in the engine surface is
// bounded (the per-session lidPhoneCache is 5000); the LID mirror was the lone exception. A miss falls
// back to engine re-resolution (a reverse lookup reads the table), so the cap trades a re-resolution for
// bounded memory, never data loss.
export const LID_MAPPING_CACHE_DEFAULT = 5000;

/**
 * SQLite binds at most 32766 variables in one statement (Postgres 65535), so an `IN (...)` over a
 * large allowlist is chunked. Small enough to stay well inside both, large enough that a realistic
 * allowlist is one round trip.
 */
const LID_QUERY_CHUNK = 500;

function chunk<T>(items: T[], size = LID_QUERY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
  /**
   * Resolve any WA JID through the mirror: the phone digits for its user part, `null` when the lid
   * is known-unresolved or never seen. The webhook filter match, automation-rule match, plugin
   * engine reads, and status contact grouping all resolve through this one method so they agree.
   */
  resolveLid(jid: string): string | null;
  /** Sync reverse lookup: the lids currently mapped to this phone (used by the message from-filter). */
  lidsForPhone(phone: string): string[];
  /** The phone the table holds for a lid JID, read from the database; null when none is stored. */
  findPhoneForLid?(jid: string): Promise<string | null>;
  /** The lids the table maps to these phone digits, read from the database. */
  findLidsForPhone?(phone: string): Promise<string[]>;
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
 * only costs a re-resolution, never data loss. The reverse map has no such warm path (nothing looks a
 * lid up by phone), so a phone-keyed filter uses {@link findLidsForPhone}, which reads the table. The
 * reverse map is reconciled on each eviction so it does not retain entries for LIDs no longer in the
 * forward cache.
 */
@Injectable()
export class LidMappingStoreService implements LidMappingStore, OnModuleInit {
  private readonly logger = createLogger('LidMappingStore');
  private readonly lidToPhone = new Map<string, string | null>();
  private readonly phoneToLids = new Map<string, Set<string>>();
  /** Repository fallbacks in flight, one per lid, so a hot miss path can't stack duplicate queries. */
  private readonly pendingLookups = new Set<string>();
  /**
   * Lids the table answered for and had no row for. {@link pendingLookups} collapses only the lookups
   * that overlap a query already in flight, so without this every DISPATCH that names an unmapped lid
   * issued a fresh query for it, and the callers are on hot paths: a webhook filter resolves both the
   * event's actor and each of its own rule values, on every dispatch.
   *
   * Cleared for a lid the moment this process learns a mapping for it ({@link index}), and wholesale
   * when the table is reloaded. An absence is never RECORDED for a lid this process already holds or
   * is still writing ({@link unsettledWrites}), which is what keeps a query that raced a write from
   * shadowing the row it could not see yet.
   *
   * What it does NOT notice is a row ANOTHER process writes: that mapping stays unseen here until
   * this process learns it or reloads, exactly as a phone already cached in {@link lidToPhone} does.
   * Bounded by the same cap as the forward map, oldest-recorded first (the forward map is ordered by
   * recency of USE, this one by when the absence was recorded).
   */
  private readonly absentFromTable = new Set<string>();
  /**
   * Lids whose row this process has indexed but not yet committed. `remember()` updates the in-memory
   * maps synchronously and writes the table afterwards, so between the two a table read answers "no
   * row" about a mapping that is about to exist. The forward map cannot stand in for this: the LRU
   * can evict the entry inside that same window, leaving it indistinguishable from never-learned.
   */
  private readonly unsettledWrites = new Set<string>();
  // 0 = unbounded (legacy behaviour). Every other long-lived map in the engine surface is bounded, so
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
      // A reload re-reads the table, so every recorded absence is a fresh question again.
      this.absentFromTable.clear();
      // Oldest first, so the newest row ends at the most-recent end of the LRU rather than the first
      // one evicted.
      for (const row of rows.reverse()) {
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

  resolveLid(jid: string): string | null {
    return this.getCached(userPart(jid)) ?? null;
  }

  lidsForPhone(phone: string): string[] {
    const set = this.phoneToLids.get(phone);
    return set ? [...set] : [];
  }

  /**
   * Reverse lookup that also reads the table. {@link lidsForPhone} only sees lids resident in the
   * forward cache, and nothing phone-keyed ever warms it, so a mapping past the preload cap or
   * evicted by the LRU would stay invisible to a phone filter for good. For callers that can await
   * (the message and status filters, the handover gate, the API-key chat fence). Same rule as
   * {@link lidsForPhonesPersisted}; a read error falls back to the cache alone.
   */
  async findLidsForPhone(phone: string): Promise<string[]> {
    try {
      return (await this.readLidsForPhones([phone]))[phone];
    } catch (err) {
      this.logger.warn(`Could not read lids for a phone: ${err instanceof Error ? err.message : String(err)}`);
      return this.lidsForPhone(phone);
    }
  }

  /**
   * Batched forward lookup for a list filter: lid user-part -> phone digits. Chunked queries for the
   * whole allowlist instead of one per entry, and the TABLE wins over the mirror so a stale cached
   * negative cannot shadow a mapping another node persisted.
   */
  async phonesForLidsPersisted(lids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    if (lids.length === 0) return out;
    for (const lid of lids) out[lid] = this.getCached(lid) ?? null;
    try {
      for (const batch of chunk(lids)) {
        const rows = await this.repo.find({ where: { lid: In(batch) } });
        // The table WINS: a stale cached negative must not shadow a mapping another node persisted.
        for (const row of rows) out[row.lid] = row.phone;
      }
    } catch {
      // The table may not exist yet (migration pending); the mirror is the best available answer.
    }
    return out;
  }

  /** Batched reverse lookup, companion to {@link phonesForLidsPersisted}: phone digits -> lids. */
  async lidsForPhonesPersisted(phones: string[]): Promise<Record<string, string[]>> {
    try {
      return await this.readLidsForPhones(phones);
    } catch {
      // The table may not exist yet (migration pending); the cache is the best available answer.
      return Object.fromEntries(phones.map(phone => [phone, this.lidsForPhone(phone)]));
    }
  }

  /**
   * A lid answers a phone only when the cache and the table do not disagree: a cached reverse entry
   * whose row another node has since re-mapped to a different phone is dropped, and a row this
   * process has since re-mapped elsewhere is skipped. Either side alone may vouch for it (the row
   * can be past the cache cap, the cached write can still be in flight). Throws on a read error.
   */
  private async readLidsForPhones(phones: string[]): Promise<Record<string, string[]>> {
    const out: Record<string, Set<string>> = {};
    for (const phone of phones) out[phone] = new Set(this.lidsForPhone(phone));
    const cachedLids = [...new Set(phones.flatMap(phone => [...out[phone]]))];
    for (const batch of chunk(cachedLids)) {
      for (const row of await this.repo.find({ where: { lid: In(batch) } })) {
        for (const phone of phones) if (row.phone !== phone) out[phone].delete(row.lid);
      }
    }
    for (const batch of chunk(phones)) {
      for (const { lid, phone } of await this.repo.find({ where: { phone: In(batch) } })) {
        if (!phone || !out[phone]) continue;
        const cached = this.lidToPhone.get(lid);
        if (cached === undefined || cached === phone) out[phone].add(lid);
      }
    }
    return Object.fromEntries(phones.map(phone => [phone, [...out[phone]]]));
  }

  /**
   * Forward lookup for callers that can await: the API-key chat fence and every chat-bound read
   * behind it (message history and media, the quoted body, status and handover filters). The table
   * answers first, the in-memory mirror only when the read fails or has no row. The mirror alone is
   * not enough: it is LRU-evicted at `LID_MAPPING_CACHE_MAX`, and nothing refreshes it when another
   * node re-maps a lid in the shared table, so a cache-first answer could resolve the same lid to
   * a phone the fence no longer sees, and a read behind the fence would serve that other chat. The
   * row is not indexed into the cache, so a lookup cannot evict hot entries.
   */
  async findPhoneForLid(jid: string): Promise<string | null> {
    const lid = userPart(jid);
    try {
      const row = await this.repo.findOne({ where: { lid } });
      if (row) return row.phone;
    } catch (err) {
      this.logger.warn(`Could not read the phone for a lid: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.getCached(lid) ?? null;
  }

  async remember(lid: string, phone: string | null, sessionId?: string): Promise<void> {
    if (!lid || this.lidToPhone.get(lid) === phone) {
      return; // unseen-or-changed only; a no-op write would just churn updatedAt
    }
    this.index(lid, phone);
    this.unsettledWrites.add(lid);
    try {
      await this.repo.upsert({ lid, phone, sessionId: sessionId ?? null, updatedAt: new Date() }, ['lid']);
    } catch (err) {
      this.logger.warn(
        `Failed to persist lid->phone mapping for ${lid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.unsettledWrites.delete(lid);
    }
  }

  /**
   * Repository fallback for a cache miss. Rows past the preload cap (or evicted by the LRU) are
   * still persisted, so a miss is warmed from the table: THIS lookup still returns undefined —
   * the sync read contract can't await, and callers fall back to engine re-resolution, but the
   * next one hits. A table miss IS remembered, so an unmapped lid stops re-querying on every
   * lookup ({@link absentFromTable}), but only when nothing learned that lid in the meantime;
   * a read error is swallowed (the table may not exist yet), the same posture as reload().
   */
  private warmFromTable(lid: string): void {
    if (!lid || this.pendingLookups.has(lid) || this.absentFromTable.has(lid)) return;
    this.pendingLookups.add(lid);
    // Captured BEFORE the query: a write for this lid that has not reached the table yet means the
    // answer is already stale, whatever it says. The forward-map check below cannot see that case,
    // because `remember()` indexes synchronously and the LRU can evict the entry again before the
    // query answers, at which point the map looks exactly like "never learned".
    const writeInFlight = this.unsettledWrites.has(lid);
    void this.repo
      .findOne({ where: { lid } })
      .then(row => {
        // Last-write-wins: a remember() that landed while the lookup was in flight is newer.
        if (row && !this.lidToPhone.has(row.lid)) {
          this.index(row.lid, row.phone);
          return;
        }
        // Same rule for the negative: an absence recorded over a mapping this process already holds,
        // or is still writing, would block the warm-back once the LRU evicts the forward entry, and
        // the row would then be unreachable until something taught the same lid again.
        if (!row && !this.lidToPhone.has(lid) && !writeInFlight) this.noteAbsent(lid);
      })
      .catch(() => undefined)
      .finally(() => this.pendingLookups.delete(lid));
  }

  /** Update both in-memory indexes, dropping any stale reverse entry from a previous phone. */
  private index(lid: string, phone: string | null): void {
    const prev = this.lidToPhone.get(lid);
    if (prev && prev !== phone) {
      this.unindex(lid, prev);
    }
    // Re-insert (delete + set) so the entry moves to the most-recent end of the LRU order even on update.
    this.lidToPhone.delete(lid);
    this.lidToPhone.set(lid, phone);
    if (phone) {
      const set = this.phoneToLids.get(phone) ?? new Set<string>();
      set.add(lid);
      this.phoneToLids.set(phone, set);
    }
    this.absentFromTable.delete(lid);
    this.evictIfOverCap();
  }

  /**
   * Record that the table holds no row for this lid, bounded oldest-recorded first.
   *
   * Skipped entirely when the cap is disabled: that mode is the legacy unbounded cache, and an
   * absence set is the one map here that grows on ids a caller supplies rather than on mappings the
   * account really has, so leaving it unbounded would be a leak an operator never opted into.
   */
  private noteAbsent(lid: string): void {
    if (!this.maxCachedLids) return;
    this.absentFromTable.add(lid);
    while (this.absentFromTable.size > this.maxCachedLids) {
      const oldest = this.absentFromTable.values().next().value;
      if (oldest === undefined) break;
      this.absentFromTable.delete(oldest);
    }
  }

  /** Evict the least-recently-used forward entry (and its reverse index) while over the cap. */
  private evictIfOverCap(): void {
    if (!this.maxCachedLids) return; // unbounded
    while (this.lidToPhone.size > this.maxCachedLids) {
      const oldest = this.lidToPhone.keys().next().value;
      if (oldest === undefined) break;
      const phone = this.lidToPhone.get(oldest);
      this.lidToPhone.delete(oldest);
      if (phone) this.unindex(oldest, phone);
    }
  }

  /** Drop a lid from its phone's reverse entry, and the entry itself once no lid is left under it. */
  private unindex(lid: string, phone: string): void {
    const set = this.phoneToLids.get(phone);
    if (set?.delete(lid) && set.size === 0) this.phoneToLids.delete(phone);
  }
}
