import { Injectable, Optional } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import { LidNotMappedError } from '../../common/errors/lid-not-mapped.error';

/**
 * Resolves a privacy-id sender (`@lid`) to a phone number for inline attachment on incoming
 * messages (#263).
 *
 * Split out of SessionService because it is a self-contained read-through cache over the engine: it
 * invalidates session entries when their engine retires and cannot fail the message path. Its only
 * collaborators are the engine registry and the shared lid<->phone table. Keeping it here means the eviction policy and the
 * fire-and-forget persistence are testable without standing up the whole session lifecycle.
 */
@Injectable()
export class SessionLidResolver {
  /**
   * Bounded cache keyed `${sessionId}:${lid}`. Caches misses (null) too, for a while ({@link recheckAt}), so
   * a chatty unmapped sender isn't re-queried on every message (which also reduces engine rate-limit
   * pressure). Best-effort feature, so staleness is acceptable.
   */
  private readonly cache = new Map<string, string | null>();
  private static readonly CACHE_MAX = 5000;
  /**
   * When an unmapped-lid lookup may be retried, per key, on {@link now}. A rejection is not cached above (it
   * is not an answer), but a sender whose lid no store maps rejects on every message, and each retry costs
   * the engine a table query and a key-store read. Kept in memory only and never persisted.
   */
  private readonly retryAfter = new Map<string, number>();
  private static readonly RETRY_AFTER_MS = 60_000;
  /** Lookups under way, per key, so messages that arrive together from one sender share a single one. */
  private readonly inFlight = new Map<string, Promise<string | null>>();
  /**
   * When a cached answer is looked up again, per key, on {@link now}. A contact can change or hide its number,
   * and the lid table can refuse a negative while another linked session owns the phone. At most one lookup
   * and one write per key per interval.
   */
  private readonly recheckAt = new Map<string, number>();
  private static readonly RECHECK_MS = 5 * 60_000;
  /** Monotonic clock in ms, so a wall clock set back does not stretch a wait (a seam for tests). */
  private readonly now = (): number => performance.now();

  constructor(
    private readonly engines: EngineRegistry,
    // Shared lid<->phone table (global). Used to persist an inbound @lid sender's resolved phone so
    // an inbound-only migrated contact's `@lid` and `@c.us` rows bridge in the read-path (#583 R3 Ph2).
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
  ) {
    engines.onRetire(id => {
      for (const map of [this.cache, this.retryAfter, this.inFlight, this.recheckAt]) {
        for (const key of map.keys()) if (key.startsWith(`${id}:`)) map.delete(key);
      }
    });
  }

  /**
   * Best-effort resolution, cached per session (incl. misses). Never throws — returns null on any
   * failure or when the engine isn't available. Gated by the caller on `RESOLVE_LID_TO_PHONE`.
   */
  async resolveSenderPhone(sessionId: string, contactId: string): Promise<string | null> {
    const key = `${sessionId}:${contactId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if ((this.recheckAt.get(key) ?? Infinity) > this.now()) return cached;
      this.forget(key);
    }
    if ((this.retryAfter.get(key) ?? 0) > this.now()) {
      return null;
    }
    // Neither the cache nor the hold above is set until a lookup lands, so a burst of messages from a
    // new sender, as a reconnect delivers, would otherwise start one engine lookup per message.
    let lookup = this.inFlight.get(key);
    if (!lookup) {
      lookup = this.lookup(sessionId, contactId, key).finally(() => {
        if (this.inFlight.get(key) === lookup) this.inFlight.delete(key);
      });
      this.inFlight.set(key, lookup);
    }
    return lookup;
  }

  /** One engine lookup for a sender, with its caching and persistence. */
  private async lookup(sessionId: string, contactId: string, key: string): Promise<string | null> {
    let phone: string | null;
    const engine = this.engines.get(sessionId);
    let failure: unknown;
    // `resolved` marks a definitive engine answer: a rejection or a missing engine is a transient
    // unknown, NOT "this contact has no phone", and must never overwrite a stored mapping (#1058).
    // Engines reject rather than answer null when they cannot decide (a Baileys lid no cache, table
    // or key store maps), so only a real "no phone" reaches the null write below.
    let resolved = false;
    try {
      if (engine) {
        phone = (await engine.resolveContactPhone(contactId)) ?? null;
        resolved = true;
      } else {
        phone = null;
      }
    } catch (err) {
      phone = null;
      failure = err;
    }
    if (engine && !this.engines.isLive(sessionId, engine)) return null;
    // Only an unmapped lid waits: any other rejection (a dead page, a rate limit) is retried on the
    // sender's next message, since the engine may answer as soon as it recovers.
    if (failure instanceof LidNotMappedError) {
      this.retryAfter.delete(key); // re-inserted at the newest end, so the FIFO bound drops the oldest
      if (this.retryAfter.size >= SessionLidResolver.CACHE_MAX) {
        this.retryAfter.delete(this.retryAfter.keys().next().value!);
      }
      this.retryAfter.set(key, this.now() + SessionLidResolver.RETRY_AFTER_MS);
    }
    // Only a definitive answer is cached: a transient null would otherwise stick for the process life.
    if (resolved) {
      this.retryAfter.delete(key);
      // Bounded FIFO eviction: Map preserves insertion order, so the first key is the oldest.
      if (this.cache.size >= SessionLidResolver.CACHE_MAX) {
        for (const oldest of this.cache.keys()) {
          this.forget(oldest);
          break;
        }
      }
      this.cache.set(key, phone);
      this.recheckAt.set(key, this.now() + SessionLidResolver.RECHECK_MS);
    }
    // Persist the resolution so the read-path can bridge this contact's `@lid` and `@c.us` rows even
    // when the operator never sent to them (#583 R3 Phase 2). A definitive null is persisted too, so
    // a phone that later becomes hidden overwrites its stale mapping instead of being served forever
    // (#1058). Reuses the resolution above — no extra network call — and is fire-and-forget so
    // dispatch never blocks/fails on it. The store keeps a phone another session stored, since that
    // account may still see the number.
    if (engine && (phone || resolved)) {
      this.persist(key, sessionId, contactId, phone, engine);
    }
    return phone;
  }

  /**
   * Report an answer to the lid table. One whose write failed is dropped from the cache, so the sender's
   * next message is looked up again and reports what the engine answers then: replaying this answer could
   * write it over a newer phone the table has learned since, and a negative that never lands would leave a
   * number the contact hid mapped until a restart (#1058).
   */
  private persist(
    key: string,
    sessionId: string,
    contactId: string,
    phone: string | null,
    engine: IWhatsAppEngine,
  ): void {
    const stored =
      phone && engine.contactPhoneLookupPersistence === 'seed'
        ? this.lidMappingStore?.rememberIfUnknown(userPart(contactId), phone, sessionId)
        : this.lidMappingStore?.remember(userPart(contactId), phone, sessionId);
    void stored
      ?.then(stored => {
        if (stored === false && this.engines.isLive(sessionId, engine)) this.forget(key);
      })
      .catch(() => {});
  }

  /** Drop a cached answer, and when it was due to be looked up again. */
  private forget(key: string): void {
    this.cache.delete(key);
    this.recheckAt.delete(key);
  }
}
