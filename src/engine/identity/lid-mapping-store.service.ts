import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Raw, Repository } from 'typeorm';
import { LidMapping } from './lid-mapping.entity';
import { userPart } from './wa-id';
import { createLogger } from '../../common/services/logger.service';
import { outsideRequest } from '../../common/services/request-context';
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

/**
 * How often a failed write is logged. A database that is down or full takes one failed statement per report
 * that has something to write (each inbound message that carries the lid, while its write keeps failing),
 * since a report held back would leave the table naming a number the contact no longer has; the warning is
 * what is bounded, to one in this interval for the whole store, with a count of the failures in between. A
 * dropped second-lid check, a failed second-lid read, a failed-write mark the bound forgets and a lid it forgets again
 * after the lid was reported are logged the same way, each on its own.
 */
const LID_WRITE_WARN_MS = 60_000;

/** How long second-lid checks are collected into one table read: a sync lands its writes over seconds. */
const SECOND_LID_WINDOW_MS = 250;
/** At most this many second-lid checks wait after a failed write or read, oldest dropped first. */
const SECOND_LID_OWED_MAX = 10_000;
/** A pair reported is not reported again for this long, among the last this many pairs. */
const SECOND_LID_REPORTED_MS = 10 * 60_000;
const SECOND_LID_REPORTED_MAX = 2000;

/** A stored report owes a second-lid check for this phone; queued once a write of it lands. */
interface SecondLidCheck {
  phone: string;
  sessionId: string | null;
  queued: boolean;
}

/** The writes of one lid under way, one entry per lid: see {@link LidMappingStoreService.unsettledWrites}. */
interface UnsettledWrite {
  count: number;
  latestReport?: object;
  latestOperation?: { phone: string | null };
  check?: SecondLidCheck;
  /**
   * The phone of the latest actual report begun, until every write of the lid has settled. The lid's mirror entry can
   * leave while that write is under way (the LRU, a reload), and this is what a row of the table is held against then.
   */
  reportPhone?: string;
  /**
   * The display lookup that contradicted the stored phone, while its revocation has not settled and no report or
   * clearing negative has taken its place: no row is answered meanwhile.
   */
  revoking?: object;
  /** The latest actual call begun, a report or a negative. Unlike `latestReport`, an eviction or a reload leaves it. */
  latestActual?: object;
  /** A statement of these writes failed, so the table may lack what the cache holds. */
  failed?: boolean;
}

/** An engine reported `newLid` for a phone the table already maps to the reported `previousLid`. */
export interface SecondLidReport {
  phone: string;
  previousLid: string;
  newLid: string;
  sessionId: string | null;
}

/** Set a key as the newest, dropping the oldest past `max`; the key dropped, if any. */
function setNewest<V>(map: Map<string, V>, key: string, value: V, max: number): string | undefined {
  map.delete(key);
  map.set(key, value);
  if (map.size <= max) return undefined;
  const oldest = map.keys().next().value as string;
  map.delete(oldest);
  return oldest;
}

/** Bits of the record of dropped failed-write marks: 128 KiB, however many marks the bound drops. */
const DROPPED_MARK_BITS = 1 << 20;

/** The bit a lid takes in the record of dropped marks (FNV-1a, its high bits). */
function markBit(lid: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < lid.length; i++) hash = Math.imul(hash ^ lid.charCodeAt(i), 0x01000193);
  return hash >>> 12;
}

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
   * seen. A miss is warmed from the persisted table in the background, so a later read can hit. An entry
   * is judged as a stored row is: while this process holds a failed write of the lid against another
   * phone, the entry is not returned.
   */
  getCached(lid: string): string | null | undefined;
  /**
   * Resolve any WA JID through the mirror: the phone digits for its user part, `null` when the lid
   * is known-unresolved, unreported, never seen or held against its entry by a failed write. This
   * hot-cache view may lag another process; alias authorization and rule matching await the persisted
   * reads below.
   */
  resolveLid(jid: string): string | null;
  /**
   * Sync reverse lookup: the lids currently mapped to this phone, less those a failed write holds against
   * it. The Baileys store scopes a chat's twin keys, and so what a chat deletion removes, with it.
   */
  lidsForPhone(phone: string): string[];
  /** The phone the table holds for a lid JID, read from the database; null when none is stored. */
  findPhoneForLid?(jid: string): Promise<string | null>;
  /** The lids the table maps to these phone digits, read from the database. */
  findLidsForPhone?(phone: string): Promise<string[]>;
  /**
   * Write-through: update the cache + persist. A phone is last-write-wins. A session reporting the phone
   * this node already holds takes the row, unless this node already counted a report of it from that
   * session: after s1, s2, s1 report one phone the owner is s2. A `null` phone records a negative result,
   * and replaces a stored phone only when its owner (or none, or one since deleted or logged out) gives it.
   * Never rejects; resolves false when its write failed.
   */
  remember(lid: string, phone: string | null, sessionId?: string): Promise<boolean>;
  /** Keep a cached lookup for display without authorizing it or replacing a stored phone or negative. */
  rememberIfUnknown?(lid: string, phone: string, sessionId?: string): Promise<boolean>;
}

/**
 * Backs lid resolution with the persisted {@link LidMapping} table. A bounded synchronous mirror
 * serves display and hot-cache reads, while authorization and rule matching await the table's current
 * reported pairings. Write-through keeps the local forward and reverse maps warm.
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
export class LidMappingStoreService implements LidMappingStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('LidMappingStore');
  private readonly lidToPhone = new Map<string, string | null>();
  /** Origin of resident display-only mappings, bounded and evicted with the forward mirror. */
  private readonly unreported = new Set<string>();
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
   * can evict the entry inside that same window, leaving it indistinguishable from never-learned, and a reload
   * leaves it out. What the table's row is held against meanwhile, the phone of an actual report or a revocation by
   * a display lookup, lives on this entry ({@link UnsettledWrite}) until the last write of the lid settles.
   * Counted per lid, so the first of two overlapping writes settling does not clear the second. The
   * latest actual report's token remains until all older writes settle, isolating their late results.
   * It also holds the second-lid check the latest new pairing owes until a landed write queues it, for a report
   * overlapping it.
   */
  private readonly unsettledWrites = new Map<string, UnsettledWrite>();
  /**
   * Lids a write started for while their table read was in flight. That read may have run before the
   * write committed, so whatever it answers predates the mapping this process now holds.
   */
  private readonly racedLookups = new Set<string>();
  /**
   * Sessions counted as having written or reported the phone a lid holds in {@link lidToPhone} (a loaded
   * row counts its owner). An uncounted session reporting the same phone takes the row and is counted
   * after its write succeeds; one already counted preserves the owner while checking for a changed row
   * on another node. So the row names the latest uncounted session to report
   * the phone, not the latest to report it: after s1, s2, s1 report one phone it names s2, and s2's
   * negative clears a phone s1 still sees. Started anew when the phone changes, dropped with the cached
   * entry, on an applied negative and on any release. A failed write does not forget an earlier success.
   */
  private readonly seenBy = new Map<string, Set<string>>();
  /**
   * Cached phones whose report is pending or failed.
   * Kept only while the cache holds that phone, until a current write lands or a negative clears it. A write still
   * under way keeps its own witness on its {@link unsettledWrites} entry, which eviction and a reload leave.
   */
  private readonly failedWrites = new Set<string>();
  /**
   * The phone a write failed to store, by lid: that of a report that did not land, or none (an empty one, which no
   * row has) for a display lookup that did not store, whose statement may have revoked a row this node never saw, so
   * that no row is answered. The table still names the phone the write was to replace, so the entry that
   * {@link failedWrites} marks going out with the mirror entry (the cap, a reload) must not make the lid answer it
   * again. It outranks an entry warmed back from that row. Ended by a report of the lid that begins or lands, a
   * negative that clears the row and a reload, which replaces the table, except for the marks of lids written while its
   * read was out. Bounded like the mirror (`LID_MAPPING_CACHE_MAX`), oldest first; the lid of a mark the bound drops
   * goes on in {@link droppedMarks}. The mark of a failed lookup is not ended by another node's later report of the lid,
   * as a lookup that landed would be: only this node's own report, a negative that clears the row or a reload ends it,
   * and a row that names another phone than the lookup is refused until then.
   */
  private readonly failedPhones = new Map<string, string>();
  /**
   * The lids whose mark in {@link failedPhones} the bound dropped, as a bit per hash of the lid, so that its size stays
   * fixed however many marks go: a lid that hashes to a set bit may have lost its mark, as may another lid that shares
   * the bit. Such a lid with no mirror entry, no mark and no report under way answers no phone, and is not warmed back
   * from the table, which may still name the phone it replaced. A report of it that lands puts it in {@link recovered},
   * so the lid answers its row again. Ended by a reload, except for the lids written while its read was out.
   */
  private droppedMarks?: Uint8Array;
  private readonly markDropWarning = { at: -Infinity, held: 0 };
  /**
   * The lids whose report landed while {@link droppedMarks} held their bit: each answers, and is warmed back, as a
   * lid no mark of which was dropped, until a mark of its own goes again. Kept apart from the failed-write marks,
   * which it neither pushes out nor outranks. Bounded like them, oldest report first: a lid that goes is in the record
   * again, and answers no phone once it has no mirror entry, until it is reported again or the mapping reloads. A
   * reload leaves it, as the lid has no mark the reload could end.
   */
  private readonly recovered = new Set<string>();
  private readonly recoveryDropWarning = { at: -Infinity, held: 0 };
  /**
   * The table statements of each lid with a write under way, as one chain. A pool hands the statements of two writes
   * to two connections, which can apply them in either order, and on any database a write of two statements (a
   * negative, a display lookup) lets the statement of a call made in the same turn in between them. So the table could
   * end on what the older call said: a report behind the display lookup that contradicted it, the phone of the earlier
   * of two reports, or a pair behind the negative that cleared it.
   */
  private readonly turns = new Map<string, Promise<void>>();
  /**
   * For each {@link reload} whose table read is out, the lids with a write under way when it began or begun since.
   * Its snapshot may predate what those writes store.
   */
  private readonly reloadsOut = new Set<Set<string>>();
  /** When a failed write was last logged, on {@link now}, and how many have failed since without a line. */
  private readonly writeWarning = { at: -Infinity, held: 0 };
  /**
   * Second-lid checks owed after the writes of the report that owed one failed, or its read did, or its read found
   * the row no longer holding the phone this node still holds, until a write of that phone lands. A new check stays
   * on its lid's {@link unsettledWrites} entry until a landed write queues it or every write of the lid has settled.
   * Kept apart from the mapping cache and its eviction.
   */
  private readonly secondLidOwed = new Map<string, SecondLidCheck>();
  private readonly secondLidDropWarning = { at: -Infinity, held: 0 };
  private readonly secondLidReadWarning = { at: -Infinity, held: 0 };
  /** Checks queued for the next read: phone -> lid -> its check, in the order their writes landed. */
  private secondLidChecks = new Map<string, Map<string, SecondLidCheck>>();
  private secondLidTimer?: ReturnType<typeof setTimeout>;
  /** {@link SECOND_LID_WINDOW_MS}, a seam for tests. */
  private readonly secondLidWindowMs = SECOND_LID_WINDOW_MS;
  /** Pairs reported, keyed by phone and both lids sorted, with when on {@link now}. */
  private readonly secondLidReported = new Map<string, number>();
  private secondLidClosing = false;
  private secondLidListener?: (report: SecondLidReport) => unknown;
  /** Monotonic clock in ms (a seam for tests). */
  private readonly now = (): number => performance.now();
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
   * Stop the second-lid checks without waiting: none is read after this and a read under way ends without a
   * report, so the checks collected in the last window before a stop go unreported.
   */
  onModuleDestroy(): void {
    this.secondLidClosing = true;
    clearTimeout(this.secondLidTimer);
  }

  /**
   * (Re)load the in-memory mirror from the table. Called on boot, and by the infra data import after
   * a committed full-replace restore — the mirror is otherwise write-through only, so restored rows
   * would never reach it and entries the restore removed would stay resolvable until the next start.
   * Never throws: a missing table (migration not yet applied) or a read error must not block boot or
   * fail the import — resolution falls back to engine re-resolution until the table is readable.
   */
  async reload(): Promise<void> {
    // Dropped before the read too: a restore may have replaced the table, so if the read fails, a lid
    // not cached must read through rather than trust a stale absence.
    this.absentFromTable.clear();
    // A lid whose write is under way when the read starts, or begins while it is out, is not taken from the
    // snapshot: the row may predate what that write stores, and the entry would go on answering it once the write
    // has landed (the phone a negative cleared, or the one a report replaced). It stays uncached, and the next read
    // warms it once its writes have settled (see warmFromTable).
    const raced = new Set(this.unsettledWrites.keys());
    this.reloadsOut.add(raced);
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
      this.unreported.clear();
      this.phoneToLids.clear();
      this.seenBy.clear();
      this.failedWrites.clear();
      // The marks that predate the read go with the table they were made against. A write that failed while the read was
      // out made its own, for a lid that is not taken from the snapshot: that mark is all that refuses the lid then.
      for (const lid of [...this.failedPhones.keys()]) if (!raced.has(lid)) this.failedPhones.delete(lid);
      const racedDrops = [...raced].filter(lid => this.markDropped(lid));
      this.droppedMarks?.fill(0);
      for (const lid of racedDrops) this.recordDropped(lid);
      for (const writing of this.unsettledWrites.values()) {
        delete writing.latestReport;
        delete writing.latestOperation;
      }
      // A reload re-reads the table, so every recorded absence is a fresh question again.
      this.absentFromTable.clear();
      // Oldest first, so the newest row ends at the most-recent end of the LRU rather than the first
      // one evicted.
      for (const row of rows.reverse()) {
        if (!raced.has(row.lid)) this.index(row.lid, row.phone, row.sessionId, row.isReported);
      }
      this.logger.log(
        `Loaded ${rows.length} lid->phone mappings into cache${this.maxCachedLids ? ` (cap ${this.maxCachedLids})` : ''}`,
      );
    } catch (err) {
      this.logger.warn(`Could not preload lid->phone mappings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.reloadsOut.delete(raced);
    }
  }

  getCached(lid: string): string | null | undefined {
    // LRU touch: re-insert the entry so iteration order (insertion order for Map) tracks recency.
    // A missed lookup returns undefined without disturbing the order.
    if (this.lidToPhone.has(lid)) {
      const phone = this.lidToPhone.get(lid);
      this.lidToPhone.delete(lid);
      this.lidToPhone.set(lid, phone as string | null);
      return phone && this.markedOut(lid, phone) ? null : phone;
    }
    this.warmFromTable(lid);
    return undefined;
  }

  resolveLid(jid: string): string | null {
    const lid = userPart(jid);
    return this.unreported.has(lid) ? null : (this.getCached(lid) ?? null);
  }

  lidsForPhone(phone: string): string[] {
    const set = this.phoneToLids.get(phone);
    return set ? [...set].filter(lid => !this.unreported.has(lid) && !this.markedOut(lid, phone)) : [];
  }

  /**
   * A failed write of the lid names another phone than its entry holds (the empty mark names none): the entry is the
   * row a read warmed back, which the write was to replace, or one a conflicting lookup revoked. The synchronous views
   * leave it out, as the readers that await judge a row, so what a caller scopes with them (the Baileys store
   * expands a chat deletion and its state over them) never reaches a lid this process knows has moved. An entry that
   * is the phone the mark names is this process's own, and stays.
   */
  private markedOut(lid: string, phone: string): boolean {
    const mark = this.failedPhones.get(lid);
    return mark !== undefined && mark !== phone;
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
    // The mirror is only the fallback for a failed table read, so it is read without getCached:
    // that warms every miss with a findOne of its own, one per lid ahead of the batched query below.
    for (const lid of lids) out[lid] = this.mirrorPhone(lid, this.lidToPhone.get(lid));
    try {
      for (const batch of chunk(lids)) {
        const rows = await this.repo.find({ where: { lid: In(batch) } });
        for (const lid of batch) out[lid] = null;
        // The table WINS: a stale cached negative must not shadow a mapping another node persisted.
        for (const row of rows) out[row.lid] = this.rowPhone(row.lid, row.phone, row.isReported);
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
   * What the mirror answers for a lid, read without touching it: its entry, judged as a row would be. The synchronous
   * views answer the same way ({@link markedOut}), and are what the readers that await fall back to while the table
   * cannot be read: a lid with a failed write has the table's row warmed back into the mirror beside its mark, and
   * that row is the phone the write was to replace, which the mark refuses.
   */
  private mirrorPhone(lid: string, held: string | null | undefined): string | null {
    return !held || this.unreported.has(lid) ? null : this.rowPhone(lid, held, true);
  }

  /** Read only current table rows on success; a resident mapping cannot restore a deleted row. */
  private async readLidsForPhones(phones: string[]): Promise<Record<string, string[]>> {
    const out: Record<string, Set<string>> = Object.fromEntries(phones.map(phone => [phone, new Set<string>()]));
    for (const batch of chunk(phones)) {
      for (const { lid, phone, isReported } of await this.repo.find({ where: { phone: In(batch) } })) {
        if (!phone || !out[phone]) continue;
        if (this.rowPhone(lid, phone, isReported) === phone) out[phone].add(lid);
      }
    }
    return Object.fromEntries(phones.map(phone => [phone, [...out[phone]]]));
  }

  /** This process has a phone write for the lid that the table does not have: in flight, or failed. */
  private unstored(lid: string): boolean {
    return this.unsettledWrites.has(lid) || this.failedWrites.has(lid) || this.failedPhones.has(lid);
  }

  /**
   * The phone a lid's row answers. The table is the truth across nodes, but while a phone this process holds
   * for the lid is not stored yet, a row that differs may be the number it replaces: the lid then answers
   * none, so no fence lookup admits either one until the write lands. The mirror entry is not the only witness
   * of that phone: the LRU or a reload can drop it while the write is under way, so with none resident the
   * write's own entry stands in for it, and keeps a revocation not stored yet in the same way.
   */
  private rowPhone(lid: string, phone: string | null, isReported = false): string | null {
    if (!isReported || (this.unreported.has(lid) && this.unstored(lid))) return null;
    const writing = this.unsettledWrites.get(lid);
    if (writing?.revoking) return null;
    // The mark of this lid may be gone with the bound: the phone this node holds for it is then not known, and nothing
    // but a mirror entry, a mark, a report under way or one that landed since ({@link recovered}) says it again. The
    // entry of a write that failed says nothing: its report may have landed, and its failure left a mark that the bound
    // has since dropped.
    if (
      this.markDropped(lid) &&
      !this.lidToPhone.has(lid) &&
      !this.failedPhones.has(lid) &&
      !(writing?.reportPhone && !writing.failed)
    )
      return null;
    const cached =
      this.failedPhones.get(lid) ?? (this.lidToPhone.has(lid) ? this.lidToPhone.get(lid) : writing?.reportPhone);
    return this.unstored(lid) && cached !== undefined && cached !== phone ? null : phone;
  }

  /**
   * Forward lookup for callers that can await: the API-key chat fence and every chat-bound read
   * behind it (message history and media, the quoted body, status and handover filters). The table
   * answers first, the in-memory mirror only when the read fails. The mirror alone is
   * not enough: it is LRU-evicted at `LID_MAPPING_CACHE_MAX`, and nothing refreshes it when another
   * node re-maps a lid in the shared table, so a cache-first answer could resolve the same lid to
   * a phone the fence no longer sees, and a read behind the fence would serve that other chat. The
   * row is not indexed into the cache, so a lookup cannot evict hot entries. A row is vetoed while this
   * process has a different phone for the lid in flight or failed ({@link rowPhone}); with no row, no
   * alias is authorized until a report commits.
   */
  async findPhoneForLid(jid: string): Promise<string | null> {
    const lid = userPart(jid);
    try {
      const row = await this.repo.findOne({ where: { lid } });
      return row ? this.rowPhone(lid, row.phone, row.isReported) : null;
    } catch (err) {
      this.logger.warn(`Could not read the phone for a lid: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.resolveLid(lid);
  }

  /**
   * A cached lookup can introduce display data, but cannot replace a stored phone or negative or grant
   * alias access. A conflicting positive revokes alias trust until an engine reports the mapping again.
   */
  async rememberIfUnknown(lid: string, phone: string, sessionId?: string): Promise<boolean> {
    if (!lid) return true;
    const cached = this.lidToPhone.get(lid);
    const lookup = { phone };
    if (cached && cached !== phone) {
      this.unreported.add(lid);
      this.seenBy.set(lid, new Set());
    }
    const reporters = this.seenBy.get(lid);
    const writing = this.beginWrite(lid, lookup);
    if (cached && cached !== phone) writing.revoking = lookup;
    try {
      const { affected } = await this.inTurn(lid, async () => {
        await this.repo
          .createQueryBuilder()
          .insert()
          .values({ lid, phone, sessionId: sessionId ?? null, updatedAt: new Date() })
          .orIgnore()
          .execute();
        return this.repo.update(
          { lid, phone: Raw(column => `${column} <> :lookupPhone`, { lookupPhone: phone }), isReported: true },
          { isReported: false, updatedAt: () => '"updatedAt"' },
        );
      });
      if (
        affected &&
        writing.latestOperation === lookup &&
        this.seenBy.get(lid) === reporters &&
        this.lidToPhone.has(lid)
      )
        this.unreported.add(lid);
      // No optimistic mirror write: another node may already hold a newer phone or negative.
      this.absentFromTable.delete(lid);
      return true;
    } catch (err) {
      writing.failed = true;
      // The update revokes any reported row that names another phone than the lookup's, whatever the mirror holds: a row
      // another node reported is revoked by the statement that landed, so a failed one marks the lid however it compared
      // with the mirror. The row the lookup names is the one the statement leaves, so the mark names that phone and
      // answers that row only: a lookup that merely repeats the stored phone must not hide the lid. The mark names no
      // phone where one would hide a witness: another mark (a failed report's mark must not come to admit a row), a
      // report of another phone on the entry (a mark outranks it), or a lid whose marks the bound dropped (a mark would
      // exempt it from {@link droppedMarks}).
      const held = this.failedPhones.get(lid);
      const named = held === phone || (held === undefined && !this.markDropped(lid));
      this.keepMark(lid, named && (!writing.reportPhone || writing.reportPhone === phone) ? phone : '');
      this.warnWriteFailed(`Could not store lid mapping: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.endWrite(lid, writing);
    }
  }

  async remember(lid: string, phone: string | null, sessionId?: string): Promise<boolean> {
    if (!lid) return true;
    const cached = this.lidToPhone.get(lid);
    // Unseen-or-changed only, or a phone a session reports here for the first time: a no-op write would
    // just churn updatedAt.
    const seen =
      !this.unreported.has(lid) &&
      cached === phone &&
      (phone === null || !sessionId || this.seenBy.get(lid)?.has(sessionId));
    // This report gives the lid a phone this node did not hold for it, a new or changed pairing or one only
    // display data had, so it owes a second-lid check; a lid outside the cache cannot be told from a new one.
    // Any other report carries the check an earlier report of the lid still owes, in flight or not, unless that
    // check names another phone (the cache read this one back from the table since): then it owes its own.
    const earlier = this.unsettledWrites.get(lid)?.check ?? this.secondLidOwed.get(lid);
    const gaining =
      phone !== null && (cached !== phone || this.unreported.has(lid) || (!!earlier && earlier.phone !== phone));
    const owed = gaining ? { phone, sessionId: sessionId ?? null, queued: false } : earlier;
    // A negative is not cached until the table has taken it: see clear().
    if (!seen && phone !== null) this.index(lid, phone, null);
    if (phone !== null) {
      this.failedWrites.add(lid);
      this.failedPhones.delete(lid); // this report takes the place of the one that failed
    }
    const reporters = this.seenBy.get(lid);
    const report = { phone };
    const writing = this.beginWrite(lid, report, true);
    if (phone !== null) {
      writing.reportPhone = phone;
      if (!seen) writing.revoking = undefined; // index() above took the lid off `unreported`
    }
    if (gaining) {
      writing.check = owed; // outside the cap of owed checks while the lid's writes are unsettled
      this.secondLidOwed.delete(lid);
    }
    try {
      await this.inTurn(lid, async () => {
        if (seen && phone !== null) {
          // A peer may have changed or revoked this row since this node counted the report. Keep the
          // owner and timestamp for the same phone, but let the latest actual report replace another one.
          const changed = '"lid_mappings"."phone" IS NULL OR "lid_mappings"."phone" <> EXCLUDED."phone"';
          const [insert, parameters] = this.repo
            .createQueryBuilder('lid_mappings')
            .insert()
            .values({ lid, phone, sessionId: sessionId ?? null, isReported: true, updatedAt: new Date() })
            .getQueryAndParameters();
          await this.repo.query(
            insert +
              ` ON CONFLICT ("lid") DO UPDATE SET "phone" = EXCLUDED."phone", "isReported" = true, ` +
              `"sessionId" = CASE WHEN ${changed} THEN EXCLUDED."sessionId" ELSE "lid_mappings"."sessionId" END, ` +
              `"updatedAt" = CASE WHEN ${changed} THEN EXCLUDED."updatedAt" ELSE "lid_mappings"."updatedAt" END ` +
              `WHERE ${changed} OR "lid_mappings"."isReported" = false`,
            parameters,
          );
        } else if (phone === null) await this.clear(lid, sessionId ?? null, seen, report);
        else {
          await this.repo.upsert(
            { lid, phone, sessionId: sessionId ?? null, isReported: true, updatedAt: new Date() },
            ['lid'],
          );
        }
      });
      if (phone !== null) {
        this.failedPhones.delete(lid);
        // The table names this phone now: a lid whose mark the bound dropped answers it, as one whose mark never went.
        if (writing.latestActual === report) this.recover(lid);
      }
      // Count only a stored report in this phone's current cache epoch. A late completion after
      // P -> Q -> P must not count the first P as a report of the replacement P.
      if (phone !== null && reporters && this.seenBy.get(lid) === reporters) {
        const operation = writing.latestOperation;
        let reported = !this.unreported.has(lid);
        // A consistent lookup may have revoked the old stored phone while this actual write was
        // in flight. Only the current reported row can establish which SQL statement landed last.
        if (!reported && writing.latestReport === report && operation?.phone === phone) {
          const row = await this.repo.findOne({ where: { lid } }).catch(() => null);
          reported = row?.isReported === true && row.phone === phone;
        }
        if (
          reported &&
          this.seenBy.get(lid) === reporters &&
          writing.latestReport === report &&
          writing.latestOperation === operation &&
          operation?.phone === phone
        ) {
          this.failedWrites.delete(lid);
          this.unreported.delete(lid);
        }
        if (sessionId && this.seenBy.get(lid) === reporters) reporters.add(sessionId);
      }
      // A check owed again after its read failed, or found the row not holding its phone, is a copy no write already in
      // flight carries. The lid's latest report takes it when it lands with that phone; an older one could run it
      // before a newer write moves the row.
      const again = writing.latestReport === report ? this.secondLidOwed.get(lid) : undefined;
      if (owed && owed.phone === phone) this.queueSecondLid(lid, owed);
      if (again?.phone === phone) this.queueSecondLid(lid, again);
      return true;
    } catch (err) {
      writing.failed = true;
      // The latest report of the lid, still marked or already without a mirror entry (a report that landed clears its mark).
      if (
        phone !== null &&
        writing.reportPhone === phone &&
        (this.failedWrites.has(lid) || !this.lidToPhone.has(lid))
      ) {
        this.keepMark(lid, phone);
      }
      this.warnWriteFailed(
        `Failed to persist lid->phone mapping for ${lid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      if (owed?.queued && writing.check === owed) writing.check = undefined; // a landed write queued it
      this.endWrite(lid, writing);
    }
  }

  /**
   * Run the table statements of a write once those of every write of the lid that began before it have ended, in
   * success or failure. Called in the turn the write begins, before any await, so the order is the order of the calls.
   */
  private inTurn<T>(lid: string, statements: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(lid);
    // With no write of the lid under way the statements start at once, as they always did.
    const run = previous ? previous.then(statements) : statements();
    const ended = run.then(
      () => undefined,
      () => undefined,
    );
    this.turns.set(lid, ended);
    void ended.then(() => {
      if (this.turns.get(lid) === ended) this.turns.delete(lid);
    });
    return run;
  }

  /** Keep report and lookup ordering until all older writes settle, without counting a lookup as a report. */
  private beginWrite(lid: string, operation: { phone: string | null }, actual = false): UnsettledWrite {
    const writing = this.unsettledWrites.get(lid) ?? { count: 0 };
    writing.count++;
    writing.latestOperation = operation;
    if (actual) {
      writing.latestReport = operation;
      writing.latestActual = operation;
    }
    this.unsettledWrites.set(lid, writing);
    for (const raced of this.reloadsOut) raced.add(lid);
    if (this.pendingLookups.has(lid)) this.racedLookups.add(lid);
    return writing;
  }

  /**
   * Once the last write of the lid settles, the latest new pairing's check, if no landed write queued it, is owed
   * until a write of its phone lands, unless a newer report of the lid took its place. Not before: an overlapping
   * report or negative can fail while the pairing's own write is still in flight, and that write queues the check if
   * it lands. It also ends the failed-write mark of a report that landed, when a write that came after the report kept
   * it from clearing the mark itself.
   */
  private endWrite(lid: string, writing: UnsettledWrite): void {
    if (this.unsettledWrites.get(lid) !== writing || --writing.count > 0) return;
    this.unsettledWrites.delete(lid);
    // A report clears the failed-write mark only while it is the lid's latest, yet a later write can displace it and
    // leave the table holding its phone: a negative the owner rule refused, a lookup that only revoked it. With no
    // failed statement and the cache still holding the last report's phone, nothing is pending or failed any more.
    if (!writing.failed && writing.reportPhone !== undefined && this.lidToPhone.get(lid) === writing.reportPhone)
      this.failedWrites.delete(lid);
    if (writing.check && !writing.check.queued) this.oweSecondLid(lid, writing.check);
  }

  /**
   * Record that a session found no phone for a lid. The row is shared by every session, and one account
   * can see a contact's number while another cannot, so a negative replaces the row only when it holds
   * no phone or the phone was written by this session (or by none, or by one no longer linked: gone from
   * `sessions`, or logged out, which clears its `phone`); another linked session's mapping stays. The check
   * is part of the update, not a read before it, so a phone stored meanwhile is never overwritten. When the
   * row is cleared the cached entry is dropped rather than set: a phone written while the statements ran may
   * be the newer value, and the next read takes whichever the table holds.
   */
  private async clear(
    lid: string,
    sessionId: string | null,
    preserveEmpty: boolean | undefined,
    report: object,
  ): Promise<void> {
    const updatedAt = new Date();
    // Creates the row when there is none; an existing one is left to the conditional update.
    await this.repo
      .createQueryBuilder()
      .insert()
      .values({ lid, phone: null, sessionId, isReported: true, updatedAt })
      .orIgnore()
      .execute();
    const replaceable = [
      { lid, phone: IsNull() },
      { lid, sessionId: IsNull() },
      // A session deleted without its rows being released (an older release, a crash, a restored backup)
      // owns them no more than a released one does, and neither does one logged out: it reports nothing
      // until it is linked again. CAST: sessions.id is a uuid on PostgreSQL.
      {
        lid,
        sessionId: Raw(
          owner => `${owner} NOT IN (SELECT CAST(s."id" AS TEXT) FROM sessions s WHERE s."phone" IS NOT NULL)`,
        ),
      },
      ...(sessionId ? [{ lid, sessionId }] : []),
    ];
    // A loaded negative may be stale after a peer's positive report. Recheck ownership atomically,
    // preserving an unchanged empty row's owner and timestamp rather than trusting this mirror.
    const eligible = preserveEmpty
      ? replaceable.slice(1).map(where => ({ ...where, phone: Not(IsNull()) }))
      : replaceable;
    const { affected } = await this.repo.update(eligible, { phone: null, sessionId, isReported: true, updatedAt });
    if (!affected) return;
    const writing = this.unsettledWrites.get(lid);
    // The witnesses a resident entry would have had go with it, also after an eviction or a reload dropped the entry.
    // Only when this negative is the lid's latest call: a report begun after it has its own, and its statement is not
    // run yet.
    if (writing?.latestActual === report) {
      writing.reportPhone = undefined;
      writing.revoking = undefined;
    }
    // A newer report of a phone owns the cached entry. A newer negative says what this one did, so the entry goes
    // now: left to that negative, it would stay if its statement failed, answering a phone the table has cleared.
    // Read through latestActual: an eviction or a reload erases latestReport while this statement is under way, and
    // the marks that guarded the row it cleared must still end with it.
    const latest = writing?.latestActual as { phone: string | null } | undefined;
    if (latest !== report && latest?.phone !== null) return;
    const cached = this.lidToPhone.get(lid);
    this.lidToPhone.delete(lid);
    this.unreported.delete(lid);
    this.seenBy.delete(lid);
    this.failedWrites.delete(lid);
    this.failedPhones.delete(lid);
    if (cached) this.unindex(lid, cached);
    this.absentFromTable.delete(lid);
  }

  /** Set the one listener told of each second-lid report; the session module audits it. */
  onSecondLid(listener: (report: SecondLidReport) => unknown): void {
    this.secondLidListener = listener;
  }

  /**
   * Keep a check owed, dropping the oldest past {@link SECOND_LID_OWED_MAX}: a dropped check runs only if a report
   * in flight already carries it.
   */
  private oweSecondLid(lid: string, check: SecondLidCheck): void {
    if (setNewest(this.secondLidOwed, lid, check, SECOND_LID_OWED_MAX)) {
      const message = `More than ${SECOND_LID_OWED_MAX} second-lid checks are owed; dropping the oldest`;
      this.warnAtMost(this.secondLidDropWarning, message, 'dropped');
    }
  }

  /**
   * Queue the check a landed write carries, for one table read once {@link secondLidWindowMs} has passed. The
   * read runs outside the request that made the report, and the write never waits for it.
   */
  private queueSecondLid(lid: string, check: SecondLidCheck): void {
    if (check.queued || this.secondLidClosing) return;
    check.queued = true;
    if (this.secondLidOwed.get(lid) === check) this.secondLidOwed.delete(lid);
    const lids = this.secondLidChecks.get(check.phone) ?? new Map<string, SecondLidCheck>();
    lids.set(lid, check);
    this.secondLidChecks.set(check.phone, lids);
    this.secondLidTimer ??= outsideRequest(() =>
      setTimeout(() => void this.checkSecondLids(), this.secondLidWindowMs).unref(),
    );
  }

  /** The gateway is stopping or the data source has closed: a check neither reads nor warns. */
  private get closed(): boolean {
    return this.secondLidClosing || this.repo.manager?.dataSource?.isInitialized === false;
  }

  /**
   * Read the table once for the checks collected and warn for each other engine-reported lid it maps a checked
   * phone to: WhatsApp gave the number to someone else or moved its holder, and a chat fence entry for either
   * lid, or for the number, now admits both. The lid the read finds is previous; of two checked together, the
   * one whose write landed first. {@link firstReport} keeps a pair checked twice to one warning.
   */
  private async checkSecondLids(): Promise<void> {
    this.secondLidTimer = undefined;
    const checks = this.secondLidChecks;
    this.secondLidChecks = new Map();
    if (this.closed) return;
    let found: Record<string, string[]>;
    try {
      found = await this.readLidsForPhones([...checks.keys()]);
    } catch (err) {
      // Owed again, for the next write of the lid that lands, unless the lid has a newer check or this node holds
      // another phone for it by now: its next landed write then moves it off this phone or owes a fresh check.
      for (const lids of checks.values())
        for (const [lid, check] of lids) {
          const cached = this.lidToPhone.get(lid);
          if (!this.secondLidOwed.has(lid) && (cached === undefined || cached === check.phone))
            this.oweSecondLid(lid, { ...check, queued: false });
        }
      // A read the closing data source cut off is not worth a line, which is only known once it has had the
      // time to close.
      const message = `Could not check for a second lid: ${err instanceof Error ? err.message : String(err)}`;
      setTimeout(
        () => this.closed || this.warnAtMost(this.secondLidReadWarning, message, 'failed'),
        this.secondLidWindowMs,
      ).unref();
      return;
    }
    if (this.closed) return; // a read still under way at shutdown ends without a report
    for (const [phone, lids] of checks) {
      const queued = [...lids.keys()];
      const held = found[phone] ?? [];
      queued.forEach((newLid, i) => {
        if (!held.includes(newLid)) {
          // Its row holds another phone by now, or a conflicting display lookup marked it unreported. If this node
          // still holds this phone for it, the row is another node's or that lookup's: the next write of this phone to
          // land checks it again.
          const check = lids.get(newLid);
          if (check && this.lidToPhone.get(newLid) === phone && !this.secondLidOwed.has(newLid))
            this.oweSecondLid(newLid, { ...check, queued: false });
          return;
        }
        for (const previousLid of held) {
          // Itself, or a lid whose write landed later in this window and names this one previous.
          if (queued.indexOf(previousLid) >= i || !this.firstReport(phone, previousLid, newLid)) continue;
          this.reportSecondLid({ phone, previousLid, newLid, sessionId: lids.get(newLid)?.sessionId ?? null });
        }
      });
    }
  }

  /** Whether a pair is reported now: not reported within {@link SECOND_LID_REPORTED_MS} among the last pairs kept. */
  private firstReport(phone: string, a: string, b: string): boolean {
    const key = [phone, ...[a, b].sort()].join(':');
    const now = this.now();
    if (now - (this.secondLidReported.get(key) ?? -Infinity) < SECOND_LID_REPORTED_MS) return false;
    setNewest(this.secondLidReported, key, now, SECOND_LID_REPORTED_MAX);
    return true;
  }

  private reportSecondLid(report: SecondLidReport): void {
    const { phone, previousLid, newLid, sessionId } = report;
    this.logger.warn('A phone number was reported under a second privacy id', {
      sessionId: sessionId ?? undefined,
      phone,
      previousLid,
      newLid,
      action: 'second_lid_reported',
    });
    const listener = this.secondLidListener;
    // A listener that throws or rejects is logged and stops no other report.
    if (listener) {
      void Promise.resolve()
        .then(() => listener(report))
        .catch(err =>
          this.logger.warn(`Could not report a second lid: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
  }

  /** Log a failed write at most once per {@link LID_WRITE_WARN_MS}, counting the ones in between. */
  private warnWriteFailed(message: string): void {
    this.warnAtMost(this.writeWarning, message, 'failed');
  }

  /** Log at most once per {@link LID_WRITE_WARN_MS} for one gate, counting the lines held back in between. */
  private warnAtMost(gate: { at: number; held: number }, message: string, verb: string): void {
    const now = this.now();
    if (now - gate.at < LID_WRITE_WARN_MS) {
      gate.held++;
      return;
    }
    this.logger.warn(gate.held ? `${message} (${gate.held} more ${verb} since the last warning)` : message);
    gate.at = now;
    gate.held = 0;
  }

  /**
   * Hand a deleted session's rows to no session. Its id never comes back (a re-created session gets a
   * new one); {@link clear} also treats an owner missing from `sessions` as none, which covers a delete
   * that never got here. The rows stay: the table is shared. Never throws: the session is already gone.
   */
  async releaseSession(sessionId: string): Promise<void> {
    // A counted reporter preserves the current owner on a repeated phone report, so a released row
    // would stay ownerless. Drop every set even if the update fails, so the next report takes ownership.
    this.seenBy.clear();
    try {
      // updatedAt is kept: no mapping changed, and the preload ranks rows by it.
      await this.repo.update({ sessionId }, { sessionId: null, updatedAt: () => '"updatedAt"' });
    } catch (err) {
      this.logger.warn(`Could not release lid mappings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Repository fallback for a cache miss. Rows past the preload cap (or evicted by the LRU) are
   * still persisted, so a miss is warmed from the table: THIS lookup still returns undefined —
   * the sync read contract can't await, and callers fall back to engine re-resolution, but the
   * next one hits. A table miss IS remembered, so an unmapped lid stops re-querying on every
   * lookup ({@link absentFromTable}), but only when nothing learned that lid in the meantime;
   * a read error is swallowed (the table may not exist yet), the same posture as reload().
   * A lid with a failed-write mark is warmed too, with the row the write was to replace. The mark outranks that
   * entry in every reader: the synchronous views leave it out ({@link markedOut}), and the readers that authorize
   * judge it through {@link rowPhone}, also when they fall back to the mirror.
   */
  private warmFromTable(lid: string): void {
    if (!lid || this.pendingLookups.has(lid) || this.absentFromTable.has(lid) || this.markDropped(lid)) return;
    this.pendingLookups.add(lid);
    // Captured BEFORE the query: a write for this lid that has not reached the table yet means the
    // answer is already stale, whatever it says. The forward-map check below cannot see that case,
    // because `remember()` indexes synchronously and the LRU can evict the entry again before the
    // query answers, at which point the map looks exactly like "never learned".
    const writeInFlight = this.unsettledWrites.has(lid);
    void this.repo
      .findOne({ where: { lid } })
      .then(row => {
        // A write that was unsettled when the query ran, or started while it was in flight, is newer
        // than either answer: a row would be the phone it replaces, served as a hit after the write
        // commits, and an absence would block the warm-back once the LRU evicts the forward entry.
        // Neither is recorded, so the next miss reads the table again.
        if (writeInFlight || this.racedLookups.has(lid) || this.markDropped(lid)) return;
        // Last-write-wins: a mapping indexed while the lookup was in flight is newer.
        if (row && !this.lidToPhone.has(row.lid)) {
          this.index(row.lid, row.phone, row.sessionId, row.isReported);
          return;
        }
        if (!row && !this.lidToPhone.has(lid)) this.noteAbsent(lid);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingLookups.delete(lid);
        this.racedLookups.delete(lid);
      });
  }

  /** Update both in-memory indexes, dropping any stale reverse entry from a previous phone. */
  private index(lid: string, phone: string | null, sessionId: string | null, isReported = true): void {
    const previouslyReported = !this.unreported.has(lid);
    if (isReported) this.unreported.delete(lid);
    else this.unreported.add(lid);
    const prev = this.lidToPhone.get(lid);
    if (prev && prev !== phone) {
      this.unindex(lid, prev);
    }
    const seen = (isReported && previouslyReported && prev === phone && this.seenBy.get(lid)) || new Set<string>();
    if (isReported && sessionId) seen.add(sessionId);
    if (phone) this.seenBy.set(lid, seen);
    else this.seenBy.delete(lid);
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
      this.evict(oldest);
    }
  }

  /** Drop a lid's forward entry and what only the entry carried. */
  private evict(lid: string): void {
    const phone = this.lidToPhone.get(lid);
    this.lidToPhone.delete(lid);
    this.unreported.delete(lid);
    this.seenBy.delete(lid);
    this.failedWrites.delete(lid);
    const writing = this.unsettledWrites.get(lid);
    if (writing) {
      delete writing.latestReport;
      delete writing.latestOperation;
    }
    if (phone) this.unindex(lid, phone);
  }

  /**
   * Keep the phone a write of the lid failed to store ('' for a lookup) past its mirror entry. The oldest mark goes
   * past the bound, and nothing may then make its lid answer the row the write was to replace: the lid is recorded in
   * {@link droppedMarks}, and its mirror entry, which could be that row warmed back, goes too.
   */
  private keepMark(lid: string, phone: string): void {
    const dropped = setNewest(this.failedPhones, lid, phone, this.maxCachedLids || Infinity);
    if (dropped === undefined) return;
    this.recordDropped(dropped);
    if (this.lidToPhone.has(dropped)) this.evict(dropped);
    this.warnAtMost(
      this.markDropWarning,
      `Failed lid writes are remembered for ${this.maxCachedLids} lids at most (LID_MAPPING_CACHE_MAX): the oldest is ` +
        'forgotten, and its lid answers no phone until it is reported again or the mapping reloads',
      'dropped',
    );
  }

  /**
   * A report of the lid landed: one the record holds, or one already recovered (which moves to the newest end), answers
   * as a lid whose mark never went ({@link recovered}). The oldest goes past the bound, and the record holds it again.
   */
  private recover(lid: string): void {
    if (!this.recovered.delete(lid) && !this.markDropped(lid)) return;
    this.recovered.add(lid);
    if (this.recovered.size <= (this.maxCachedLids || Infinity)) return;
    this.recovered.delete(this.recovered.values().next().value as string);
    this.warnAtMost(
      this.recoveryDropWarning,
      `Lids reported again after their failed write was forgotten are remembered for ${this.maxCachedLids} ` +
        'lids at most (LID_MAPPING_CACHE_MAX): the oldest is forgotten again, and once it has no cache entry its lid ' +
        'answers no phone until it is reported again or the mapping reloads',
      'dropped',
    );
  }

  private recordDropped(lid: string): void {
    this.recovered.delete(lid); // a mark of its own went again
    const bit = markBit(lid);
    this.droppedMarks ??= new Uint8Array(DROPPED_MARK_BITS >> 3);
    this.droppedMarks[bit >> 3] |= 1 << (bit & 7);
  }

  /** Whether the bound may have dropped the failed-write mark of this lid since a report of it last landed. */
  private markDropped(lid: string): boolean {
    if (!this.droppedMarks || this.recovered.has(lid)) return false;
    const bit = markBit(lid);
    return (this.droppedMarks[bit >> 3] & (1 << (bit & 7))) !== 0;
  }

  /** Drop a lid from its phone's reverse entry, and the entry itself once no lid is left under it. */
  private unindex(lid: string, phone: string): void {
    const set = this.phoneToLids.get(phone);
    if (set?.delete(lid) && set.size === 0) this.phoneToLids.delete(phone);
  }
}
