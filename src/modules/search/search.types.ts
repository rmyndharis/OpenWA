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
  /** Registry/route use this; 503 when not ok. */
  health(): Promise<SearchHealth>;
}

export interface SearchHealth {
  ok: boolean;
  detail?: string;
}

export interface SearchQuery {
  q: string;
  /** Scoped by SearchService from the caller's API-key allowedSessions (not user-supplied). */
  sessionIds?: string[];
  sessionId?: string;
  chatId?: string;
  direction?: MessageDirection;
  type?: MessageType | MessageType[];
  from?: string;
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
