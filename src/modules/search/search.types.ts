import type { MessageType } from '../../engine/interfaces/whatsapp-engine.interface';
import type { MessageDirection } from '../message/entities/message.entity';

/** A pluggable search backend. Indexing is intentionally NOT part of this interface —
 *  each provider owns how its index stays current (DB-level for built-in, hook-driven for plugins). */
export interface SearchProvider {
  /** Stable id, e.g. 'builtin-fts'. */
  readonly id: string;
  /** Human label for dashboard/config. */
  readonly label: string;
  search(query: SearchQuery): Promise<SearchResults>;
  /** Provider liveness. Not yet consumed by the route, the registry or /health. */
  health(): Promise<SearchHealth>;
}

export interface SearchHealth {
  ok: boolean;
  detail?: string;
}

/**
 * How `q` matches a message body. `word` matches whole words (the built-in provider's original
 * behavior); `contains` matches any substring of three or more characters, ignoring case and accents.
 * A plugin provider receives the field and may treat it as its backend allows.
 */
export type SearchMatch = 'word' | 'contains';

export interface SearchQuery {
  q: string;
  /** Absent means `word`, so callers that predate the field keep their results. */
  match?: SearchMatch;
  /** Scoped by SearchService from the caller's API-key allowedSessions (not user-supplied). */
  sessionIds?: string[];
  /** Host-set, lid-expanded chat scope: undefined is unrestricted, [] denies every chat. */
  chatIds?: string[];
  sessionId?: string;
  chatId?: string;
  /**
   * Host-set: every stored form of `chatId` (both user dialects and the lids mapped to the phone), so the
   * built-in filter finds the chat the message list does. Not part of the plugin provider contract: it is
   * stripped before a plugin sees the query.
   */
  chatIdAliases?: string[];
  direction?: MessageDirection;
  type?: MessageType | MessageType[];
  from?: string;
  /** Host-set, like `chatIdAliases`: every stored form of `from`, matched against the sender and the author. */
  fromAliases?: string[];
  dateFrom?: number; // epoch ms
  dateTo?: number; // epoch ms
  limit?: number;
  offset?: number;
}

export interface SearchResults {
  hits: SearchHit[];
  /** Bounded exact count for pagination. */
  total: number;
  tookMs: number;
  /** Which provider answered (id). */
  provider: string;
}

export interface SearchHit {
  messageId: string;
  waMessageId: string;
  sessionId: string;
  chatId: string;
  body: string;
  /** Provider-generated excerpt with `<mark>` highlight markers; safe when rendered as text (the
   *  dashboard renders it as text, never as HTML — do not `dangerouslySetInnerHTML`). */
  snippet: string;
  timestamp: number;
  type: MessageType;
  direction: MessageDirection;
  from: string;
  score?: number;
}
