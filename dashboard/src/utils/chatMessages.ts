import type { ChatMessage, EngineHistoryMessage, MessageType } from '../services/api';

export type { EngineHistoryMessage };

// Message types whose history rows carry media. History is fetched WITHOUT media (footprint), so such
// a row arrives with no payload — surface it as the omitted placeholder (📎 Media) instead of an empty
// bubble. The DB copy of a recent message still wins in mergeChatMessages, so its real media is kept.
const HISTORY_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);

// Normalize an engine history message into the DB ChatMessage shape the thread renders. Historical
// messages have no live delivery state, so default to `read` (they are old/already-seen); real status
// for current-session messages still comes from the DB copy and live websocket acks.
export function mapEngineHistoryMessage(h: EngineHistoryMessage): ChatMessage {
  return {
    id: h.id,
    waMessageId: h.id,
    chatId: h.chatId,
    from: h.from,
    to: h.to,
    body: h.body ?? '',
    type: h.type as MessageType,
    direction: h.fromMe ? 'outgoing' : 'incoming',
    status: 'read',
    timestamp: h.timestamp,
    createdAt: new Date((h.timestamp ?? 0) * 1000).toISOString(),
    metadata: h.media
      ? { media: h.media }
      : HISTORY_MEDIA_TYPES.has(h.type)
        ? { media: { mimetype: '', omitted: true } }
        : undefined,
  };
}

const msgKey = (m: ChatMessage): string => m.waMessageId ?? m.id;
const msgTime = (m: ChatMessage): number =>
  typeof m.timestamp === 'number' ? m.timestamp : Math.floor(Date.parse(m.createdAt) / 1000) || 0;

// Merge persisted DB messages with engine history into one ascending thread. The engine fills the
// backfill (history from before the gateway captured anything); the DB copy wins on conflict so the
// real delivery status survives. Deduped by the wweb.js serialized id (engine `id` == DB `waMessageId`).
export function mergeChatMessages(db: ChatMessage[], history: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of history) byId.set(msgKey(m), m);
  for (const m of db) byId.set(msgKey(m), m); // DB overwrites the engine copy (authoritative status)
  return [...byId.values()].sort((a, b) => msgTime(a) - msgTime(b) || a.createdAt.localeCompare(b.createdAt));
}

// ChatMessageView extends ChatMessage with the view-only fields the chat page renders.
// Lifted from Chats.tsx so hooks/utils can share the same shape.
type MessageMedia = { mimetype: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };

export interface ChatMessageView extends ChatMessage {
  metadata?: {
    media?: MessageMedia;
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
    call?: { video: boolean; missed: boolean };
  };
}

// Delivery ticks only ADVANCE, never regress. Live websocket events (incl. a replayed message.sent on
// reconnect) and engine acks can arrive out of order, so a late/duplicate lower status must not visually
// downgrade a row already shown as delivered/read. Mirrors the backend transition rules:
// pending<sent<delivered<read advances by rank; `failed` only applies from pending/sent and is terminal.
const DELIVERY_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
export function mergeDeliveryStatus(
  current: ChatMessageView['status'] | undefined,
  incoming: ChatMessageView['status'] | undefined,
): ChatMessageView['status'] | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current === 'failed') return 'failed'; // terminal — nothing advances from failed
  if (incoming === 'failed') return current === 'pending' || current === 'sent' ? 'failed' : current;
  if (!(incoming in DELIVERY_RANK)) return current; // unknown status — ignore
  if (!(current in DELIVERY_RANK)) return incoming;
  return DELIVERY_RANK[incoming] >= DELIVERY_RANK[current] ? incoming : current;
}

/**
 * Append `incoming` to `list`. If an entry with the same identity exists, replace it in place.
 * Identity uses the same `waMessageId ?? id` key as mergeChatMessages — a DB row (id=UUID,
 * waMessageId=WA id) and a live WS message (id=WA id) for the same WhatsApp message must dedupe,
 * not double-add. On replace, the delivery status only advances (a replayed lower `sent` echo can't
 * downgrade a delivered/read row) and existing metadata is kept when the incoming copy carries none.
 * Returns a new array — does not mutate the input.
 */
export function mergeOrAppend(
  list: ChatMessageView[],
  incoming: ChatMessageView,
): ChatMessageView[] {
  const idx = list.findIndex(m => msgKey(m) === msgKey(incoming));
  if (idx === -1) return [...list, incoming];
  const existing = list[idx];
  const next = list.slice();
  next[idx] = {
    ...incoming,
    status: mergeDeliveryStatus(existing.status, incoming.status) ?? incoming.status,
    metadata: incoming.metadata ?? existing.metadata,
  };
  return next;
}

/**
 * Swap the entry whose id === `oldId` with `replacement`. No-op if not found.
 */
export function replaceMessageById(
  list: ChatMessageView[],
  oldId: string,
  replacement: ChatMessageView,
): ChatMessageView[] {
  const idx = list.findIndex(m => m.id === oldId);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = replacement;
  return next;
}

/**
 * Apply a partial patch to the entry whose id matches. No-op if not found.
 */
export function updateMessageById(
  list: ChatMessageView[],
  id: string,
  patch: Partial<ChatMessageView>,
): ChatMessageView[] {
  const idx = list.findIndex(m => m.id === id);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

/**
 * Filter out the entry with the matching id. No-op if not found.
 */
export function removeMessageById(
  list: ChatMessageView[],
  id: string,
): ChatMessageView[] {
  if (!list.some(m => m.id === id)) return list;
  return list.filter(m => m.id !== id);
}
