import type { GroupMetadata } from '@whiskeysockets/baileys';
import { MAX_TIMER_MS, resolveNonNegativeIntEnv } from '../../config/configuration';

/** How long a group's participant list is reused before Baileys reads it again; 0 switches the cache off. */
const DEFAULT_GROUP_METADATA_CACHE_TTL_MS = 5 * 60_000;

/** BAILEYS_GROUP_METADATA_CACHE_TTL_MS, read per session so a restart picks up a change. */
export function groupMetadataCacheTtlMs(): number {
  return resolveNonNegativeIntEnv(process.env.BAILEYS_GROUP_METADATA_CACHE_TTL_MS, DEFAULT_GROUP_METADATA_CACHE_TTL_MS);
}

/** The cached copy of one group's metadata and when it was read. */
interface CachedGroup {
  metadata: GroupMetadata;
  storedAt: number;
}

/**
 * The cache behind Baileys' `cachedGroupMetadata` option, one per session.
 *
 * Without it every group send makes its own query for the group's participant list, which for a busy
 * account is one extra round trip (and one more chance at a throttle) per message, each parsing the
 * whole member list. With it the list is reused for up to `ttlMs`.
 *
 * A stale list costs a delay, not a message: a member added since is left out of the sender-key
 * distribution until its client asks for a retry, which Baileys answers. The entry is dropped on the
 * events that change membership or group settings, the whole cache on every connection change (the
 * events missed while offline never arrive), and it expires on its own after `ttlMs`.
 */
export class GroupMetadataCache {
  private readonly entries = new Map<string, CachedGroup>();
  /**
   * Reads under way, so concurrent sends to one group share a single query. A read that an invalidation
   * or a clear overtook is dropped from here: its answer still reaches the callers that joined it, but
   * it is not kept and no later read waits on it.
   */
  private readonly inFlight = new Map<string, Promise<GroupMetadata>>();
  /** The pending timer that drops expired entries; armed while the cache holds any. */
  private expiryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now,
  ) {}

  /** A TTL of 0 switches the cache off: Baileys then queries on its own, as it does without one. */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The group's metadata if it was read within the TTL; a hit is marked most recently used. */
  peek(jid: string): GroupMetadata | undefined {
    const cached = this.entries.get(jid);
    if (!cached) return undefined;
    if (this.now() - cached.storedAt >= this.ttlMs) {
      this.entries.delete(jid);
      return undefined;
    }
    this.entries.delete(jid);
    this.entries.set(jid, cached);
    return cached.metadata;
  }

  /**
   * The group's metadata from the cache, or from `fetch` (the query Baileys would have made) when it
   * holds none, remembering the answer. Undefined when the cache is off.
   */
  read(jid: string, fetch: () => Promise<GroupMetadata>): Promise<GroupMetadata | undefined> {
    if (!this.enabled) return Promise.resolve(undefined);
    const hit = this.peek(jid);
    if (hit) return Promise.resolve(hit);
    const joined = this.inFlight.get(jid);
    if (joined) return joined;
    // Gives up the group's slot and says whether this read still held it: an invalidation or a clear takes it away.
    const settle = (): boolean => {
      const held = this.inFlight.get(jid) === pending;
      if (held) this.inFlight.delete(jid);
      return held;
    };
    const pending: Promise<GroupMetadata> = fetch().then(
      metadata => {
        if (settle()) this.store(jid, metadata);
        return metadata;
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    );
    this.inFlight.set(jid, pending);
    return pending;
  }

  /** Forget one group: its membership or settings changed, so the next send reads it again. */
  invalidate(jid: string | null | undefined): void {
    if (!jid) return;
    this.entries.delete(jid);
    this.inFlight.delete(jid);
  }

  /** Forget everything, for a connection change or a teardown. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  /**
   * Apply a `groups.update` batch: every group it names is read again on the next send. A partial entry
   * is a real change to some field. A whole-metadata entry (the result of the all-groups listing, which
   * Baileys also emits through this event, on every dirty-groups notice as well as on GET /groups) comes
   * from a different query than a send uses, and may name participants in another id form or leave out
   * the addressing mode and the disappearing timer, so it never becomes the cached copy. The cost is one
   * single-group query per cached group after such a listing.
   */
  applyUpdates(updates: ReadonlyArray<Partial<GroupMetadata>> | undefined): void {
    for (const update of updates ?? []) this.invalidate(update?.id);
  }

  private store(jid: string, metadata: GroupMetadata): void {
    this.entries.delete(jid);
    this.entries.set(jid, { metadata, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const [oldest] = this.entries.keys();
      this.entries.delete(oldest);
    }
    this.scheduleExpiry();
  }

  /**
   * Expiry is otherwise checked only when a group is read, so a group nobody sends to again would keep
   * its participant list for as long as the socket lives. One timer drops what has expired, and runs
   * again only while the cache still holds entries.
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer) return;
    const dropExpired = (): void => {
      this.expiryTimer = undefined;
      const now = this.now();
      for (const [jid, cached] of this.entries) {
        if (now - cached.storedAt >= this.ttlMs) this.entries.delete(jid);
      }
      if (this.entries.size > 0) this.scheduleExpiry();
    };
    this.expiryTimer = setTimeout(dropExpired, Math.min(this.ttlMs, MAX_TIMER_MS));
    this.expiryTimer.unref();
  }
}
