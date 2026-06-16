import { IncomingMessage, MessageType } from '../interfaces/whatsapp-engine.interface';

/**
 * Map a whatsapp-web.js `MessageTypes` token to the engine-neutral {@link MessageType}, so no
 * consumer outside the adapter sees wwebjs-specific type strings. Notably `chat` -> `text` (aligning
 * incoming with the neutral types outgoing sends already use) and `ptt` -> `voice`. Anything not
 * mapped becomes `unknown`.
 */
export function mapWwebjsMessageType(raw: string): MessageType {
  switch (raw) {
    case 'chat':
      return 'text';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'ptt':
      return 'voice';
    case 'document':
      return 'document';
    case 'sticker':
      return 'sticker';
    case 'location':
      return 'location';
    case 'vcard':
    case 'multi_vcard':
      return 'contact';
    case 'revoked':
      return 'revoked';
    default:
      return 'unknown';
  }
}

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
  // For an outgoing (fromMe) message `from` is the account's own JID and `to` is the conversation;
  // for an incoming message it's the reverse. So the chat is `to` when fromMe, else `from`.
  const chatId = msg.fromMe ? msg.to : msg.from;
  const incoming: IncomingMessage = {
    id: msg.id._serialized,
    from: msg.from,
    to: msg.to,
    chatId,
    body: msg.body,
    type: mapWwebjsMessageType(msg.type),
    timestamp: msg.timestamp,
    fromMe: msg.fromMe,
    isGroup: chatId.endsWith('@g.us'),
    // Flag status/story broadcasts here (the engine-specific `status@broadcast` pseudo-JID stays in
    // the adapter) so engine-neutral code can skip them without matching the literal.
    isStatusBroadcast: msg.to === 'status@broadcast' || chatId === 'status@broadcast',
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
