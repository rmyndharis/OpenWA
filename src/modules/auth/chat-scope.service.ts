import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { ApiKey } from './entities/api-key.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ContactDirectory } from '../../engine/identity/jid-candidates';
import {
  ChatScope,
  ChatScopeDirectory,
  buildChatScope,
  buildExpandedChatScope,
  chatIdAllowed,
  filterByChatScope,
  isChatScopeRestricted,
} from '../../common/security/chat-scope';

/**
 * Compiles an API key's `allowedChats` into an enforceable {@link ChatScope} and answers membership,
 * wiring the lid<->phone table so a phone entry matches its `@lid` form and vice versa.
 *
 * Provided by the global AuthModule so both the ApiKeyGuard (single requested id) and the list
 * endpoints (whole result set) share one definition of "inside the fence". The table is read
 * persistently rather than from the evictable in-memory mirror, so the answer is deterministic. A
 * missing store degrades to exact-dialect matching only, which fails CLOSED for an unmapped `@lid`.
 */
@Injectable()
export class ChatScopeService {
  constructor(
    // Exported by the global EngineModule. Optional so the auth surface still boots in a unit test
    // (or a stripped build) without the engine: the fence then matches dialects exactly.
    @Optional()
    private readonly lidStore?: LidMappingStoreService,
  ) {}

  /** True when the key carries a non-empty allowlist and is therefore fenced. */
  isRestricted(apiKey?: Pick<ApiKey, 'allowedChats'> | null): boolean {
    return isChatScopeRestricted(apiKey?.allowedChats);
  }

  /**
   * Refuse a restricted key that names no chat on a route whose chat is an optional `?chatId=`. The
   * guard fences the chat id when it is present; this closes the case where it is missing or blank,
   * which the route would otherwise read as "every chat".
   */
  requireChat(apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined, chatId: string | undefined): void {
    if (this.isRestricted(apiKey) && !chatId?.trim()) {
      throw new ForbiddenException('chatId is required for a key restricted to selected chats');
    }
  }

  /** The literal scope for a key (no lookups), or `null` when unrestricted. */
  scopeFor(apiKey?: Pick<ApiKey, 'allowedChats'> | null): ChatScope | null {
    return buildChatScope(apiKey?.allowedChats ?? null);
  }

  /**
   * Whether a single requested `chatId` is inside the key's fence. Expands the REQUESTED id once
   * through the lid table (at most two lookups) instead of expanding the whole allowlist.
   */
  allows(apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined, chatId: string): Promise<boolean> {
    return chatIdAllowed(this.scopeFor(apiKey), chatId, this.singleDirectory());
  }

  /** The allowlist expanded once with the lid table (batched), for filtering a whole list. */
  scopeForFilter(apiKey?: Pick<ApiKey, 'allowedChats'> | null): Promise<ChatScope | null> {
    return buildExpandedChatScope(apiKey?.allowedChats ?? null, this.batchDirectory());
  }

  /**
   * The expanded allowlist as a plain id array, for surfaces that filter at the query level
   * (search's SQL `IN`), or `undefined` when the key is unrestricted. Same expansion as
   * {@link scopeForFilter}: both stored dialects of every entry, lid twins included.
   */
  async idsForFilter(apiKey?: Pick<ApiKey, 'allowedChats'> | null): Promise<string[] | undefined> {
    const scope = await this.scopeForFilter(apiKey);
    return scope ? [...scope.allowed] : undefined;
  }

  /** The subset of `items` whose chat id is inside the key's fence (unrestricted ⇒ unchanged). */
  async filter<T>(
    apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined,
    items: readonly T[],
    chatIdOf: (item: T) => string | null | undefined,
  ): Promise<T[]> {
    return filterByChatScope(await this.scopeForFilter(apiKey), items, chatIdOf);
  }

  private singleDirectory(): ContactDirectory | undefined {
    const store = this.lidStore;
    if (!store) return undefined;
    return {
      resolveLid: userPart => store.findPhoneForLid(userPart),
      lidsForPhone: phone => store.findLidsForPhone(phone),
    };
  }

  private batchDirectory(): ChatScopeDirectory | undefined {
    const store = this.lidStore;
    if (!store) return undefined;
    return {
      phonesForLids: lids => store.phonesForLidsPersisted(lids),
      lidsForPhones: phones => store.lidsForPhonesPersisted(phones),
    };
  }
}
