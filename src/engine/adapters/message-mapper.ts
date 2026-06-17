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
  /** WIDs @mentioned in the message; whatsapp-web.js attaches this to every Message. */
  mentionedIds?: string[];
  /** Raw wwebjs payload; `notifyName` carries the sender's push name without an extra lookup. */
  _data?: { notifyName?: string };
}

/**
 * Build the synchronous base of an IncomingMessage from a raw wwebjs message.
 * Async enrichment (media, quoted message, saved-contact name) is layered on by
 * the adapter; this covers the fields available without an await.
 */
export function buildIncomingMessageBase(msg: RawMessageFields): IncomingMessage {
  // For an outgoing (fromMe) message `from` is the account's own JID and `to` is the conversation;
  // for an incoming message it's the reverse. So the chat is `to` when fromMe, else `from`.
  const chatId = msg.fromMe ? msg.to : msg.from;
  const incoming: IncomingMessage = {
    id: msg.id._serialized,
    from: msg.from,
    to: msg.to,
    chatId,
    body: msg.body,
    type: msg.type,
    timestamp: msg.timestamp,
    fromMe: msg.fromMe,
    isGroup: chatId.endsWith('@g.us'),
  };

  // In a group, `from` is the group JID, so `author` is the only way to know the real sender.
  if (msg.author) {
    incoming.author = msg.author;
  }

  if (msg.mentionedIds && msg.mentionedIds.length > 0) {
    incoming.mentionedIds = msg.mentionedIds;
  }

  // Push name is available synchronously on the raw payload — no contact lookup needed.
  const pushName = msg._data?.notifyName;
  if (pushName) {
    incoming.contact = { pushName };
  }

  return incoming;
}
