import { DeliveryStatus, IncomingMessage, MessageType } from '../interfaces/whatsapp-engine.interface';
import { chatKind } from '../identity/wa-id';

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
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      // Native polls; WhatsApp bumps the content key across versions, all map to the same neutral type.
      return 'poll';
    case 'interactiveMessage':
    case 'buttonsMessage':
    case 'templateMessage':
    case 'interactiveResponseMessage':
      // WhatsApp Business interactive shapes (OTP/verification codes, button/template prompts). They
      // carry display text that {@link extractBaileysBody} flattens into `body`, so they surface as
      // `text` instead of being dropped as `unknown` with an empty body (#562).
      return 'text';
    case 'placeholderMessage':
      // Meta masks high-security business messages (enterprise OTPs, banking alerts) on linked/
      // companion devices — which Baileys is — delivering a bodyless `placeholderMessage` (its only
      // PlaceholderType is MASK_LINKED_DEVICES). The text is withheld by design and never arrives on
      // this device (a resend cannot recover it), so surface it as its own `masked` type rather than
      // an indistinguishable `unknown` empty bubble, so clients can explain it (#574).
      return 'masked';
    default:
      return 'unknown';
  }
}

/**
 * The inbound message-content subset the body extractor reads. Declared structurally (not
 * `proto.IMessage`) so body extraction is unit-testable with plain objects and stays decoupled from
 * the Baileys proto shape — mirroring the rationale for {@link BaileysIncomingFields}.
 */
export interface BaileysBodyContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null } | null;
  interactiveMessage?: { body?: { text?: string | null } | null } | null;
  buttonsMessage?: { contentText?: string | null } | null;
  templateMessage?: {
    hydratedTemplate?: { hydratedContentText?: string | null } | null;
    hydratedFourRowTemplate?: { hydratedContentText?: string | null } | null;
  } | null;
  interactiveResponseMessage?: { body?: { text?: string | null } | null } | null;
}

/**
 * Extract the display text of an inbound Baileys message: plain text first, then a media caption,
 * then the WhatsApp Business interactive shapes (interactive / buttons / template / interactive-
 * response) whose text was previously dropped — the OTP/verification text businesses send via these
 * shapes (#562). Returns `''` when the message carries no extractable text. Pass the NORMALIZED
 * content (ephemeral/viewOnce/documentWithCaption wrappers already unwrapped), as the adapter does.
 */
export function extractBaileysBody(content: BaileysBodyContent): string {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.interactiveMessage?.body?.text ??
    content.buttonsMessage?.contentText ??
    content.templateMessage?.hydratedTemplate?.hydratedContentText ??
    content.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ??
    content.interactiveResponseMessage?.body?.text ??
    ''
  );
}

/**
 * The inbound message-content subset the location extractor reads. Declared structurally (not
 * `proto.IMessage`) for the same reason as {@link BaileysBodyContent}. The live variant carries
 * only the two coordinates on purpose: `proto.Message.ILiveLocationMessage` has no `name`/`address`
 * — only `ILocationMessage` does — which is why those two are sourced from the static variant.
 */
export interface BaileysLocationContent {
  locationMessage?: {
    degreesLatitude?: number | null;
    degreesLongitude?: number | null;
    name?: string | null;
    address?: string | null;
  } | null;
  liveLocationMessage?: { degreesLatitude?: number | null; degreesLongitude?: number | null } | null;
}

/**
 * Extract the coordinates of a location message, static or live. Returns `undefined` for any other
 * content type, and for a location content type whose sub-message is absent. Pass the NORMALIZED
 * content (an ephemeral/disappearing-chat location nests under the wrapper, so the raw
 * `content.locationMessage` is undefined and the coordinates would be silently dropped).
 */
export function extractBaileysLocation(
  content: BaileysLocationContent,
  contentType: string | undefined,
): IncomingMessage['location'] {
  if (contentType !== 'locationMessage' && contentType !== 'liveLocationMessage') {
    return undefined;
  }
  const lm = content.locationMessage ?? content.liveLocationMessage;
  if (!lm) {
    return undefined;
  }
  const staticLm = content.locationMessage; // only ILocationMessage has name/address
  return {
    latitude: lm.degreesLatitude ?? 0,
    longitude: lm.degreesLongitude ?? 0,
    description: staticLm?.name ?? undefined,
    address: staticLm?.address ?? undefined,
  };
}

/**
 * A content sub-message that may carry a `contextInfo` — the quote, the disappearing-messages timer
 * and the mention list all ride there, on whichever sub-message the payload happens to be.
 * `quotedMessage` is `unknown` rather than `Record<string, unknown>`: `proto.IContextInfo.quotedMessage`
 * is `proto.IMessage | null`, an interface with no index signature, so it is not assignable to a
 * record type.
 */
interface BaileysContextCarrier {
  contextInfo?: {
    stanzaId?: string | null;
    quotedMessage?: unknown;
    expiration?: number | null;
    mentionedJid?: string[] | null;
  } | null;
}

/**
 * The inbound message-content subset the context extractor reads: every sub-message that can carry a
 * `contextInfo`, plus the extended-text styling fields. Declared structurally, as {@link BaileysBodyContent} is.
 */
export interface BaileysContextContent {
  extendedTextMessage?: (BaileysContextCarrier & { backgroundArgb?: number | null; font?: number | null }) | null;
  imageMessage?: BaileysContextCarrier | null;
  videoMessage?: BaileysContextCarrier | null;
  audioMessage?: BaileysContextCarrier | null;
  documentMessage?: BaileysContextCarrier | null;
  stickerMessage?: BaileysContextCarrier | null;
  locationMessage?: BaileysContextCarrier | null;
}

/** Everything the context region of an inbound message yields — not just the quote. */
export interface BaileysMessageContext {
  /** The quoted (replied-to) message, when `contextInfo` carries both a quote and its stanza id. */
  quotedMessage?: IncomingMessage['quotedMessage'];
  /** Disappearing-messages timer from `contextInfo.expiration`. */
  ephemeralDuration?: number;
  /** @mentioned JIDs from `contextInfo.mentionedJid`. */
  mentionedJids?: string[];
  /** Styling of an extended-text (status) message: proto `backgroundArgb` (fixed32 ARGB). */
  backgroundArgb?: number;
  /** Styling of an extended-text (status) message: proto `font` (WhatsApp font index). */
  font?: number;
}

/**
 * Extract the quoted message, the disappearing-messages timer, the mention list and the extended-text
 * styling from an inbound message's content. Pass the NORMALIZED content: a live disappearing message
 * arrives wrapped in `ephemeralMessage` (also viewOnce / documentWithCaption), whose inner content
 * carries the `contextInfo`. The raw wrapper exposes none at top level, so both the quote and the
 * timer (`contextInfo.expiration`) would be missed if the raw content were passed here.
 */
export function extractBaileysContext(content: BaileysContextContent): BaileysMessageContext {
  const subForContext =
    content.extendedTextMessage ??
    content.imageMessage ??
    content.videoMessage ??
    content.audioMessage ??
    content.documentMessage ??
    content.stickerMessage ??
    content.locationMessage;
  // A text status's styling rides on the extended-text content (proto backgroundArgb/font) —
  // surface it so the store/viewer can render the story the way it was posted.
  const extText = content.extendedTextMessage;
  const contextInfo = subForContext?.contextInfo;

  const context: BaileysMessageContext = {
    ephemeralDuration: contextInfo?.expiration ?? undefined,
    mentionedJids: contextInfo?.mentionedJid ?? undefined,
    backgroundArgb: typeof extText?.backgroundArgb === 'number' ? extText.backgroundArgb : undefined,
    font: typeof extText?.font === 'number' ? extText.font : undefined,
  };

  if (contextInfo?.quotedMessage && contextInfo.stanzaId) {
    const qm = contextInfo.quotedMessage as {
      conversation?: string | null;
      extendedTextMessage?: { text?: string | null } | null;
      imageMessage?: { caption?: string | null } | null;
      videoMessage?: { caption?: string | null } | null;
      documentMessage?: { caption?: string | null } | null;
    };
    const qBody =
      qm.conversation ??
      qm.extendedTextMessage?.text ??
      qm.imageMessage?.caption ??
      qm.videoMessage?.caption ??
      qm.documentMessage?.caption ??
      '';
    context.quotedMessage = { id: contextInfo.stanzaId, body: qBody };
  }

  return context;
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
  /** Styling of an extended-text (status) message: proto `backgroundArgb` (fixed32 ARGB). */
  backgroundArgb?: number;
  /** Styling of an extended-text (status) message: proto `font` (WhatsApp font index). */
  font?: number;
}

/**
 * Build a neutral {@link IncomingMessage} from extracted Baileys fields. The chat is always
 * `remoteJid` (Baileys reports the conversation directly); `fromMe` only flips from/to. The group
 * sender — and likewise the poster of a status broadcast — lives in `participant` (exposed as
 * `author`), matching the wwjs convention where `from` is the group JID / broadcast channel.
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
    kind: chatKind(chatId),
    isStatusBroadcast,
  };

  // The sender behind a group message — or the poster behind a status broadcast — lives in
  // `participant` (exposed as `author`), matching the wwjs convention where `from` is the group JID
  // (or the shared status@broadcast channel). Without the status arm, buildIncomingStatus can only
  // resolve the poster to the pseudo-JID itself and drops every Baileys status.
  if ((isGroup || isStatusBroadcast) && fields.participant) {
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

  // Extended-text (status) styling: proto ARGB → the #RRGGBB the API/outbound DTOs speak.
  if (fields.backgroundArgb !== undefined && Number.isFinite(fields.backgroundArgb)) {
    incoming.backgroundColor = `#${(fields.backgroundArgb & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (fields.font !== undefined) {
    incoming.font = fields.font;
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
