import { IncomingMessage, MessageContact, MessageType } from '../interfaces/whatsapp-engine.interface';

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

  // @mentioned WIDs, when present — used for command targeting (e.g. `/tr grant @user`).
  if (msg.mentionedIds && msg.mentionedIds.length > 0) {
    incoming.mentionedIds = msg.mentionedIds;
  }

  // Flag senders identified by a WhatsApp privacy id (`@lid`) so engine-neutral code can opt to
  // resolve a phone number without matching the engine-specific JID scheme itself (#263).
  const senderJid = msg.author ?? msg.from;
  if (senderJid.endsWith('@lid')) {
    incoming.isLidSender = true;
  }

  // Push name is available synchronously on the raw payload — no contact lookup needed.
  const pushName = msg._data?.notifyName;
  if (pushName) {
    incoming.contact = { pushName };
  }

  return incoming;
}

/**
 * The subset of whatsapp-web.js `Contact` properties we read synchronously (already on the resolved
 * contact, no network call). Declared explicitly so {@link mapContactFields} is unit-testable without a
 * full wwebjs `Contact`, and so the async getters stay out by construction.
 */
export interface RawContactFields {
  id?: { _serialized?: string };
  number?: string;
  name?: string;
  pushname?: string;
  shortName?: string;
  type?: string;
  isMyContact?: boolean;
  isWAContact?: boolean;
  isBusiness?: boolean;
  isEnterprise?: boolean;
  verifiedName?: string;
  verifiedLevel?: number;
  isBlocked?: boolean;
  labels?: string[];
}

/**
 * Map the synchronous fields of a wwebjs `Contact` to a {@link MessageContact}, copying only the values
 * that are set. No network calls, which on a per-message path would risk rate-limiting.
 *
 * With `full` false (the default) it returns just `name`/`pushName`, the long-standing payload. With
 * `full` true (operator opt-in via `WEBHOOK_CONTACT_DETAILS`) it returns the complete field set.
 */
export function mapContactFields(contact: RawContactFields, full = false): MessageContact {
  const out: MessageContact = {};
  if (contact.name) out.name = contact.name;
  if (contact.pushname) out.pushName = contact.pushname;
  if (!full) return out;
  const id = contact.id?._serialized;
  if (id) out.id = id;
  if (contact.number) out.number = contact.number;
  if (contact.shortName) out.shortName = contact.shortName;
  if (contact.type) out.type = contact.type;
  if (contact.isMyContact !== undefined) out.isMyContact = contact.isMyContact;
  if (contact.isWAContact !== undefined) out.isWAContact = contact.isWAContact;
  if (contact.isBusiness !== undefined) out.isBusiness = contact.isBusiness;
  if (contact.isEnterprise !== undefined) out.isEnterprise = contact.isEnterprise;
  if (contact.verifiedName) out.verifiedName = contact.verifiedName;
  if (contact.verifiedLevel !== undefined) out.verifiedLevel = contact.verifiedLevel;
  if (contact.isBlocked !== undefined) out.isBlocked = contact.isBlocked;
  if (contact.labels && contact.labels.length > 0) out.labels = contact.labels;
  return out;
}
