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
export function mapBaileysMessageType(
  contentType: string | undefined,
  isPtt = false,
  isCatalogShare = false,
): MessageType {
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
    case 'orderMessage':
      return 'order';
    case 'productMessage':
      // A shared product card — or, with the `catalog` arm set instead of `product`, a share of the
      // whole catalog (there is no `catalogMessage` content type). A catalog share carries no
      // product id, so it stays `unknown` rather than a `product` with nothing to act on; its title
      // still reaches `body` via {@link extractBaileysBody}.
      return isCatalogShare ? 'unknown' : 'product';
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
  /** A poll's question; the wire bumps the content key across versions, all carry `name`. */
  pollCreationMessage?: { name?: string | null } | null;
  pollCreationMessageV2?: { name?: string | null } | null;
  pollCreationMessageV3?: { name?: string | null } | null;
  /** A shared WhatsApp event; only its display name is surfaced as text. */
  eventMessage?: { name?: string | null } | null;
  /** The user tapping a business message button: which visible label they pressed. */
  buttonsResponseMessage?: { selectedDisplayText?: string | null } | null;
  templateButtonReplyMessage?: { selectedDisplayText?: string | null } | null;
  /** A single shared contact card. */
  contactMessage?: { vcard?: string | null } | null;
  /** Several contact cards shared together; each carries its own vCard. */
  contactsArrayMessage?: { contacts?: Array<{ vcard?: string | null }> | null } | null;
  /** A placed order: the customer's note, else the order's own title. */
  orderMessage?: { message?: string | null; orderTitle?: string | null } | null;
  /** A shared product card: the accompanying text, else the product's — or the catalog's — title. */
  productMessage?: {
    body?: string | null;
    product?: { title?: string | null } | null;
    catalog?: { title?: string | null } | null;
  } | null;
}

/**
 * Extract the display text of an inbound Baileys message: plain text first, then a media caption,
 * then the WhatsApp Business interactive shapes (interactive / buttons / template / interactive-
 * response) whose text was previously dropped — the OTP/verification text businesses send via these
 * shapes (#562), then the text-shaped non-conversation content whose display text whatsapp-web.js
 * already exposes as `body` and Baileys used to drop silently: a poll's question, a shared event's
 * name, which button label the user tapped, and a shared contact card's vCard(s). Multiple vCards
 * from a `contactsArrayMessage` are newline-joined; RFC 6350 allows concatenated vCards in one
 * stream, so this is a single valid multi-card body, not string mangling. Returns `''` when the
 * message carries no extractable text. Pass the NORMALIZED content (ephemeral/viewOnce/
 * documentWithCaption wrappers already unwrapped), as the adapter does.
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
    content.pollCreationMessage?.name ??
    content.pollCreationMessageV2?.name ??
    content.pollCreationMessageV3?.name ??
    content.eventMessage?.name ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    content.contactMessage?.vcard ??
    extractContactsArrayVcards(content.contactsArrayMessage) ??
    content.orderMessage?.message ??
    content.orderMessage?.orderTitle ??
    content.productMessage?.body ??
    content.productMessage?.product?.title ??
    content.productMessage?.catalog?.title ??
    ''
  );
}

/**
 * Joins the vCards of a `contactsArrayMessage` into one string, in the order they were shared.
 * Returns `undefined` (not `''`) when there are no vCards to join, so it composes with `??` in
 * {@link extractBaileysBody} the same way every other optional-field lookup there does.
 */
function extractContactsArrayVcards(
  contactsArrayMessage: BaileysBodyContent['contactsArrayMessage'],
): string | undefined {
  const vcards = (contactsArrayMessage?.contacts ?? [])
    .map(contact => contact.vcard)
    .filter((vcard): vcard is string => !!vcard);

  return vcards.length > 0 ? vcards.join('\n') : undefined;
}

/**
 * The inbound message-content subset the commerce extractor reads. Declared structurally, as
 * {@link BaileysBodyContent} is.
 */
export interface BaileysCommerceContent {
  orderMessage?: { orderId?: string | null; token?: string | null } | null;
  productMessage?: {
    businessOwnerJid?: string | null;
    product?: { productId?: string | null; title?: string | null; description?: string | null } | null;
    /** Set instead of `product` when the whole catalog was shared — see {@link isBaileysCatalogShare}. */
    catalog?: { title?: string | null } | null;
  } | null;
}

/** Both commerce shapes an inbound message can carry; each arm is set only for its content type. */
export interface BaileysCommerce {
  order?: IncomingMessage['order'];
  product?: IncomingMessage['product'];
}

/**
 * Extract the ids a commerce message carries: an order's `orderId`/`token` (the correlation handle
 * for its line items) and a shared product's `productId` (what the catalog routes take). Both are
 * dropped by the generic path, which sees only an empty body.
 *
 * An order or product without its id yields nothing: a client cannot act on either, and an entry
 * with an empty id would look actionable while failing at the API. Pass the NORMALIZED content, as
 * the adapter does — a commerce message in a disappearing chat nests under `ephemeralMessage`.
 */
export function extractBaileysCommerce(
  content: BaileysCommerceContent,
  contentType: string | undefined,
): BaileysCommerce {
  if (contentType === 'orderMessage') {
    const orderId = content.orderMessage?.orderId;
    if (!orderId) {
      return {};
    }
    return { order: { orderId, token: content.orderMessage?.token ?? undefined } };
  }

  if (contentType === 'productMessage') {
    const snapshot = content.productMessage?.product;
    return snapshot?.productId
      ? {
          product: {
            productId: snapshot.productId,
            title: snapshot.title ?? undefined,
            description: snapshot.description ?? undefined,
            businessOwnerJid: content.productMessage?.businessOwnerJid ?? undefined,
          },
        }
      : {};
  }

  return {};
}

/**
 * A catalog share arrives as a `productMessage` too, carrying the `catalog` arm instead of
 * `product` (there is no `catalogMessage` content type). It names a whole catalog and carries no
 * product id, so it must not surface as a `product` with no product — see
 * {@link mapBaileysMessageType}.
 */
export function isBaileysCatalogShare(content: BaileysCommerceContent): boolean {
  return !content.productMessage?.product?.productId && content.productMessage?.catalog != null;
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
    // The quote's body comes from the SAME extractor as the live message, so a quoted contact card,
    // poll or interactive shape carries its text instead of an empty string — matching wwjs, whose
    // quote is a full Message and therefore shows the same body it would show unquoted.
    const qm = contextInfo.quotedMessage as BaileysBodyContent;
    context.quotedMessage = { id: contextInfo.stanzaId, body: extractBaileysBody(qm) };
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
  /** Pre-extracted commerce ids. Populated by the adapter for `orderMessage` / `productMessage`. */
  order?: IncomingMessage['order'];
  product?: IncomingMessage['product'];
  /** A `productMessage` that shares the whole catalog rather than one product — see `isBaileysCatalogShare`. */
  isCatalogShare?: boolean;
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
    type: mapBaileysMessageType(fields.contentType, fields.isPtt, fields.isCatalogShare),
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

  if (fields.order) {
    incoming.order = fields.order;
  }

  if (fields.product) {
    // The catalog owner goes through the same normalizer as every other JID on the payload, so an
    // order/product never emits `@s.whatsapp.net` or `@lid` next to `@c.us` fields in one object.
    const { businessOwnerJid } = fields.product;
    incoming.product = businessOwnerJid
      ? { ...fields.product, businessOwnerJid: normalizeJid(businessOwnerJid) }
      : fields.product;
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
