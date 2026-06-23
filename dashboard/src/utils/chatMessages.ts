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
