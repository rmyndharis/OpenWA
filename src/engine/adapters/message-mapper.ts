import { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

/**
 * The subset of whatsapp-web.js `Message` fields we read synchronously to build
 * the base of an {@link IncomingMessage}. Declared explicitly so the mapping is
 * unit-testable without constructing a full wwebjs `Message`.
 */
export interface RawMessageFields {
  id: { _serialized: string };
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe: boolean;
  /** Set on group messages: the participant WID that actually sent the message. */
  author?: string;
  /** Raw wwebjs payload; `notifyName` carries the sender's push name without an extra lookup. */
  _data?: { notifyName?: string };
}

/**
 * Build the synchronous base of an IncomingMessage from a raw wwebjs message.
 * Async enrichment (media, quoted message, saved-contact name) is layered on by
 * the adapter; this covers the fields available without an await.
 */
export function buildIncomingMessageBase(msg: RawMessageFields): IncomingMessage {
  const incoming: IncomingMessage = {
    id: msg.id._serialized,
    from: msg.from,
    to: msg.to,
    chatId: msg.from,
    body: msg.body,
    type: msg.type,
    timestamp: msg.timestamp,
    fromMe: msg.fromMe,
    isGroup: msg.from.endsWith('@g.us'),
  };

  // In a group, `from` is the group JID, so `author` is the only way to know the real sender.
  if (msg.author) {
    incoming.author = msg.author;
  }

  // Push name is available synchronously on the raw payload — no contact lookup needed.
  const pushName = msg._data?.notifyName;
  if (pushName) {
    incoming.contact = { pushName };
  }

  return incoming;
}
