import { Injectable, Optional } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';

/**
 * Resolves a privacy-id sender (`@lid`) to a phone number for inline attachment on incoming
 * messages (#263).
 *
 * Split out of SessionService because it is a self-contained read-through cache over the engine: it
 * has no lifecycle state, cannot fail the message path, and its only collaborators are the engine
 * registry and the shared lid<->phone table. Keeping it here means the eviction policy and the
 * fire-and-forget persistence are testable without standing up the whole session lifecycle.
 */
@Injectable()
export class SessionLidResolver {
  /**
   * Bounded cache keyed `${sessionId}:${lid}`. Caches misses (null) too, so a chatty unmapped sender
   * isn't re-queried on every message (which also reduces engine rate-limit pressure). Best-effort
   * feature, so staleness is acceptable.
   */
  private readonly cache = new Map<string, string | null>();
  private static readonly CACHE_MAX = 5000;

  constructor(
    private readonly engines: EngineRegistry,
    // Shared lid<->phone table (global). Used to persist an inbound @lid sender's resolved phone so
    // an inbound-only migrated contact's `@lid` and `@c.us` rows bridge in the read-path (#583 R3 Ph2).
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
  ) {}

  /**
   * Best-effort resolution, cached per session (incl. misses). Never throws — returns null on any
   * failure or when the engine isn't available. Gated by the caller on `RESOLVE_LID_TO_PHONE`.
   */
  async resolveSenderPhone(sessionId: string, contactId: string): Promise<string | null> {
    const key = `${sessionId}:${contactId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let phone: string | null;
    try {
      phone = (await this.engines.get(sessionId)?.resolveContactPhone(contactId)) ?? null;
    } catch {
      phone = null;
    }
    // Bounded FIFO eviction: Map preserves insertion order, so the first key is the oldest.
    if (this.cache.size >= SessionLidResolver.CACHE_MAX) {
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
    this.cache.set(key, phone);
    // Persist a real @lid -> phone resolution so the read-path can bridge this contact's `@lid` and
    // `@c.us` rows even when the operator never sent to them (#583 R3 Phase 2). Reuses the resolution
    // above — no extra network call — and is fire-and-forget so dispatch never blocks/fails on it.
    if (phone) {
      void this.lidMappingStore?.remember(userPart(contactId), phone, sessionId)?.catch(() => {});
    }
    return phone;
  }
}
