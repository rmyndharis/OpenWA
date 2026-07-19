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
 * Merge two metadata bags field-by-field. The incoming copy wins per field only when it actually
 * carries a value — a live `message.sent` echo is built as `{media, quotedMessage, call}` with
 * undefined leaves, and a wholesale `incoming ?? existing` swap would wipe the optimistic bubble's
 * quote/call. Media has one extra rule: an incoming marker WITHOUT the payload (the engine's
 * own-send echo and the media-less history fetch both emit `{media: {omitted: true}}` with no
 * `data`) must not clobber an existing copy holding the real base64 — the optimistic send bubble is
 * the only copy with the payload until a refetch, and the cache is staleTime: Infinity.
 */
function mergeMessageMetadata(
  existing: ChatMessageView['metadata'],
  incoming: ChatMessageView['metadata'],
): ChatMessageView['metadata'] {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const media = (() => {
    if (!incoming.media) return existing.media;
    if (!existing.media) return incoming.media;
    if (existing.media.data && !incoming.media.data) return existing.media;
    return incoming.media;
  })();
  const merged: NonNullable<ChatMessageView['metadata']> = {};
  if (media) merged.media = media;
  const quotedMessage = incoming.quotedMessage ?? existing.quotedMessage;
  if (quotedMessage) merged.quotedMessage = quotedMessage;
  const reactions = incoming.reactions ?? existing.reactions;
  if (reactions) merged.reactions = reactions;
  const call = incoming.call ?? existing.call;
  if (call) merged.call = call;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Append `incoming` to `list`. If an entry with the same identity exists, replace it in place.
 * Identity uses the same `waMessageId ?? id` key as mergeChatMessages — a DB row (id=UUID,
 * waMessageId=WA id) and a live WS message (id=WA id) for the same WhatsApp message must dedupe,
 * not double-add. On replace, the delivery status only advances (a replayed lower `sent` echo can't
 * downgrade a delivered/read row) and metadata is merged per field (a payload-less echo can't erase
 * the existing media/quote — see mergeMessageMetadata).
 * Returns a new array — does not mutate the input.
 */
export function mergeOrAppend(list: ChatMessageView[], incoming: ChatMessageView): ChatMessageView[] {
  const idx = list.findIndex(m => msgKey(m) === msgKey(incoming));
  if (idx === -1) return [...list, incoming];
  const existing = list[idx];
  const next = list.slice();
  next[idx] = {
    ...incoming,
    status: mergeDeliveryStatus(existing.status, incoming.status) ?? incoming.status,
    metadata: mergeMessageMetadata(existing.metadata, incoming.metadata),
  };
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
export function removeMessageById(list: ChatMessageView[], id: string): ChatMessageView[] {
  if (!list.some(m => m.id === id)) return list;
  return list.filter(m => m.id !== id);
}

/**
 * Locate the message a `message.revoked` event refers to. Returns -1 if it isn't cached.
 *
 * The event carries two candidate ids: `id`, and `revokedId` — the ORIGINAL deleted message, which
 * whatsapp-web.js resolves separately because its revoke event can carry an id of its own that never
 * matches a stored row. Baileys sets the two identically, and wwebjs leaves `revokedId` undefined
 * when the original isn't in its local store.
 *
 * Both candidates are tried rather than preferring `revokedId` (the `revokedId ?? id` shape the
 * backend uses to key its own UPDATE): matching either id is a superset that stays correct whichever
 * of the two the cached row was stored under, so it cannot regress the Baileys path. Each candidate
 * is checked against both the DB row id and `waMessageId` — a live WS message and its persisted copy
 * are keyed differently. `revokedId` is guarded because an undefined one would otherwise match a row
 * whose `waMessageId` is also undefined.
 */
export function findRevokedIndex(list: ChatMessageView[], event: { id: string; revokedId?: string }): number {
  const matches = (m: ChatMessageView, candidate: string): boolean => m.id === candidate || m.waMessageId === candidate;
  return list.findIndex(m => matches(m, event.id) || (event.revokedId !== undefined && matches(m, event.revokedId)));
}

/**
 * Replace the displayed body of a cached WhatsApp message after a `message.edited` event. Persisted
 * rows use a local UUID in `id` and the WhatsApp identity in `waMessageId`; live rows often use the
 * WhatsApp identity for both, so both candidates are required. Returns the original array on a miss.
 */
export function applyMessageEdit(
  list: ChatMessageView[],
  event: { messageId: string; body: string },
): ChatMessageView[] {
  if (!event.messageId) return list;
  const idx = list.findIndex(m => m.id === event.messageId || m.waMessageId === event.messageId);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = { ...next[idx], body: event.body };
  return next;
}
