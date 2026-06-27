import type { ChatMessage, EngineHistoryMessage, MessageType } from '../services/api';

export type { EngineHistoryMessage };

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
    metadata: h.media ? { media: h.media } : undefined,
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
type MessageMedia = { mimetype: string; filename?: string; data?: string };

export interface ChatMessageView extends ChatMessage {
  metadata?: {
    media?: MessageMedia;
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
  };
}

/**
 * Append `incoming` to `list`. If an entry with the same identity exists, replace it in place.
 * Identity uses the same `waMessageId ?? id` key as mergeChatMessages — a DB row (id=UUID,
 * waMessageId=WA id) and a live WS message (id=WA id) for the same WhatsApp message must dedupe,
 * not double-add. Returns a new array — does not mutate the input.
 */
export function mergeOrAppend(
  list: ChatMessageView[],
  incoming: ChatMessageView,
): ChatMessageView[] {
  const idx = list.findIndex(m => msgKey(m) === msgKey(incoming));
  if (idx === -1) return [...list, incoming];
  const next = list.slice();
  next[idx] = incoming;
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
