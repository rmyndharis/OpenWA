import { Injectable, Optional } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { parseWaId, userPart } from '../../engine/identity/wa-id';

/**
 * Best-effort `@lid` -> phone resolution shared by every Client Mapping write path (docs/32 §5):
 * the auto-tag service, "Import from Chats" (including its group-member sub-path), and any future
 * caller of {@link ClientMappingService.resolveAndUpsert}. Centralised here so the fix for one
 * duplicate-identity bug (the same real contact ending up as one `@c.us` row from a 1:1 chat and a
 * separate `@lid` row from a group participant list) can't be half-applied to some callers and not
 * others.
 *
 * `EngineRegistry` and `LidMappingStoreService` both live in the `@Global()` EngineModule (see
 * session-lid-resolver.service.ts, whose read-through-cache-and-persist shape this mirrors) — this
 * is deliberately NOT that service, because SessionModule imports ClientMappingModule and Nest
 * modules must stay acyclic; reusing the same two low-level, module-cycle-free collaborators gets
 * the same shared, persisted lid<->phone table without a forwardRef().
 */
@Injectable()
export class ClientMappingIdentityService {
  constructor(
    private readonly engines: EngineRegistry,
    @Optional() private readonly lidMappingStore?: LidMappingStoreService,
  ) {}

  /**
   * Resolve a contact-kind jid to a phone number, or null when it can't be (group/other kinds, or
   * an `@lid` this account's engine can't map). A `@c.us`/`@s.whatsapp.net` jid resolves for free
   * (the phone IS the jid's user part); a `@lid` jid checks the shared cache first, then falls back
   * to one engine round trip and persists the result — so the first caller anywhere in the app to
   * see a given `@lid` pays the network cost once, and every later caller (a different group import,
   * the auto-tag service, a future resolve) hits the cache. Never throws.
   */
  async resolvePhone(sessionId: string, jid: string): Promise<string | null> {
    const parsed = parseWaId(jid);
    if (parsed.kind === 'user') return parsed.userPart;
    if (parsed.kind !== 'lid') return null;

    const lid = userPart(jid);
    const cached = this.lidMappingStore?.getCached(lid);
    if (cached !== undefined) return cached;

    let phone: string | null;
    try {
      const engine = this.engines.get(sessionId);
      phone = engine ? ((await engine.resolveContactPhone(jid)) ?? null) : null;
    } catch {
      phone = null;
    }
    void this.lidMappingStore?.remember(lid, phone, sessionId)?.catch(() => undefined);
    return phone;
  }
}
