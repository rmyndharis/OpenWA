import { DeliveryStatus, IncomingMessage, MessageType } from '../interfaces/whatsapp-engine.interface';

/**
 * Map a Baileys message content-type token (from `getContentType`) to the engine-neutral
 * {@link MessageType}. `audioMessage` splits on the `ptt` flag into `voice` vs `audio`,
 * mirroring the wwjs `ptt -> voice` mapping. Anything unmapped becomes `unknown`.
 *
 * Note: Baileys surfaces phone calls through the dedicated `call` socket event (a `WACallEvent`),
 * never as a message content type returned by `getContentType`, so `call`-typed messages are
 * intentionally not produced on this engine — unlike the wwjs adapter, which sources call detail
 * from the gated `getChatHistory` path.
 */
export function mapBaileysMessageType(contentType: string | undefined, isPtt = false): MessageType {
  switch (contentType) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return isPtt ? 'voice' : 'audio';
    case 'documentMessage':
    case 'documentWithCaptionMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'contact';
    default:
      return 'unknown';
  }
}

/**
 * Map a Baileys delivery status (`proto.WebMessageInfo.Status`, numeric) to the engine-neutral
 * {@link DeliveryStatus}. Returns `null` for an absent/unknown status so the adapter skips emitting
 * an ack. PLAYED collapses to `read`, matching the wwjs adapter.
 */
export function mapBaileysStatus(status: number | null | undefined): DeliveryStatus | null {
  switch (status) {
    case 0:
      return 'failed'; // ERROR
    case 1:
      return 'pending'; // PENDING
    case 2:
      return 'sent'; // SERVER_ACK
    case 3:
      return 'delivered'; // DELIVERY_ACK
    case 4:
      return 'read'; // READ
    case 5:
      return 'read'; // PLAYED
    default:
      return null;
  }
}

/**
 * The subset of a Baileys `WAMessage` the adapter reads (after proto extraction) to build the
 * base of an {@link IncomingMessage}. Declared explicitly so the neutral-shape logic is
 * unit-testable without constructing a full proto message — mirrors wwjs `RawMessageFields`.
 */
export interface BaileysIncomingFields {
  id: string;
  /** The chat JID (`key.remoteJid`): a contact, a `@g.us` group, or `status@broadcast`. */
  remoteJid: string;
  fromMe: boolean;
  /** Group sender (`key.participant`); `remoteJid` is the group JID for group messages. */
  participant?: string;
  body: string;
  /** Result of `getContentType(msg.message)`. */
  contentType: string | undefined;
  /** `audioMessage.ptt === true` — distinguishes a voice note from an audio file. */
  isPtt?: boolean;
  timestamp: number;
  pushName?: string;
  /** The account's own normalized JID, for from/to on outgoing messages. */
  selfJid?: string;
  /** Pre-extracted media: mimetype + base64 data (+ optional filename). Populated by the adapter. */
  media?: IncomingMessage['media'];
  /** Pre-extracted location. Populated by the adapter for `locationMessage`. */
  location?: IncomingMessage['location'];
  /** Pre-extracted quoted message context. Populated by the adapter when `contextInfo` is present. */
  quotedMessage?: IncomingMessage['quotedMessage'];
  /** Ephemeral/disappearing-messages timer from `contextInfo.expiration` on the Baileys message. */
  ephemeralDuration?: number;
  /** @mentioned engine JIDs from `contextInfo.mentionedJid`; normalized and surfaced as `mentionedIds`. */
  mentionedJids?: string[];
}

/**
 * Build a neutral {@link IncomingMessage} from extracted Baileys fields. The chat is always
 * `remoteJid` (Baileys reports the conversation directly); `fromMe` only flips from/to. The group
 * sender lives in `participant` (exposed as `author`), matching the wwjs convention where `from`
 * is the group JID.
 */
export function buildIncomingMessageFromBaileys(
  fields: BaileysIncomingFields,
  // Canonicalizes the emitted JIDs (from/to/chatId/author) to the neutral @c.us convention. Defaults
  // to identity so the pure-shape behaviour (and its tests) is unchanged; the adapter supplies the
  // session-store-backed normalizer that resolves @lid / @s.whatsapp.net.
  normalizeJid: (jid: string) => string = jid => jid,
): IncomingMessage {
  const rawChatId = fields.remoteJid;
  const isGroup = rawChatId.endsWith('@g.us');
  const isStatusBroadcast = rawChatId === 'status@broadcast';
  const chatId = normalizeJid(rawChatId);
  const self = normalizeJid(fields.selfJid ?? '');

  const incoming: IncomingMessage = {
    id: fields.id,
    from: fields.fromMe ? self : chatId,
    to: fields.fromMe ? chatId : self,
    chatId,
    body: fields.body,
    type: mapBaileysMessageType(fields.contentType, fields.isPtt),
    timestamp: fields.timestamp,
    fromMe: fields.fromMe,
    isGroup,
    isStatusBroadcast,
  };

  if (isGroup && fields.participant) {
    incoming.author = normalizeJid(fields.participant);
  }

  // The lid check uses the RAW sender (participant in a group, else the chat JID) before normalization.
  const senderJid = fields.participant ?? rawChatId;
  if (senderJid.endsWith('@lid')) {
    incoming.isLidSender = true;
  }

  if (fields.pushName) {
    incoming.contact = { pushName: fields.pushName };
  }

  if (fields.media) {
    incoming.media = fields.media;
  }

  if (fields.location) {
    incoming.location = fields.location;
  }

  if (fields.quotedMessage) {
    incoming.quotedMessage = fields.quotedMessage;
  }

  // Ephemeral/disappearing-messages timer, when the chat has one set.
  if (fields.ephemeralDuration && fields.ephemeralDuration > 0) {
    incoming.ephemeralDuration = fields.ephemeralDuration;
  }

  // @mentioned WIDs, normalized to the neutral convention — parity with the wwjs adapter
  // (message-mapper.ts:90), consumed by command targeting and the `mentions` webhook filter.
  if (fields.mentionedJids && fields.mentionedJids.length > 0) {
    incoming.mentionedIds = fields.mentionedJids.map(normalizeJid);
  }

  return incoming;
}
