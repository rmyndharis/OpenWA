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
    case 'listMessage':
    case 'interactiveResponseMessage':
    case 'buttonsResponseMessage':
    case 'templateButtonReplyMessage':
    case 'listResponseMessage':
      // WhatsApp Business interactive shapes (OTP/verification codes, button/template prompts) and
      // the replies when a user taps one. They carry display text that {@link extractBaileysBody}
      // flattens into `body`, so they surface as `text` instead of being dropped as `unknown` with
      // an empty body (#562). Prompt messages also populate {@link IncomingMessage.buttons}; replies
      // populate {@link IncomingMessage.button}.
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
  /** A business list prompt's description (or title when description is absent). */
  listMessage?: { description?: string | null; title?: string | null } | null;
  /** A poll's question; the wire bumps the content key across versions, all carry `name`. */
  pollCreationMessage?: { name?: string | null } | null;
  pollCreationMessageV2?: { name?: string | null } | null;
  pollCreationMessageV3?: { name?: string | null } | null;
  /** A shared WhatsApp event; only its display name is surfaced as text. */
  eventMessage?: { name?: string | null } | null;
  /** The user tapping a business message button: which visible label they pressed. */
  buttonsResponseMessage?: { selectedDisplayText?: string | null } | null;
  templateButtonReplyMessage?: { selectedDisplayText?: string | null } | null;
  /** The user picking a row from a business list message. */
  listResponseMessage?: { title?: string | null } | null;
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
 * name, which button label the user tapped, a list row's title, and a shared contact card's
 * vCard(s). Multiple vCards from a `contactsArrayMessage` are newline-joined; RFC 6350 allows
 * concatenated vCards in one stream, so this is a single valid multi-card body, not string mangling.
 * Returns `''` when the message carries no extractable text. Pass the NORMALIZED content
 * (ephemeral/viewOnce/documentWithCaption wrappers already unwrapped), as the adapter does.
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
    content.listMessage?.description ??
    content.listMessage?.title ??
    content.pollCreationMessage?.name ??
    content.pollCreationMessageV2?.name ??
    content.pollCreationMessageV3?.name ??
    content.eventMessage?.name ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
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
 * The inbound message-content subset the button-reply extractor reads. Declared structurally, as
 * {@link BaileysBodyContent} is.
 */
export interface BaileysButtonReplyContent {
  buttonsResponseMessage?: {
    selectedButtonId?: string | null;
    selectedDisplayText?: string | null;
  } | null;
  templateButtonReplyMessage?: {
    selectedId?: string | null;
    selectedDisplayText?: string | null;
  } | null;
  listResponseMessage?: {
    title?: string | null;
    singleSelectReply?: { selectedRowId?: string | null } | null;
  } | null;
  interactiveResponseMessage?: {
    body?: { text?: string | null } | null;
    nativeFlowResponseMessage?: {
      name?: string | null;
      paramsJson?: string | null;
    } | null;
  } | null;
}

/**
 * Extract the stable id (and visible label) when the sender tapped a business button, template
 * quick-reply, list row, or native-flow control. Returns `undefined` when the content is not a
 * reply shape, or when WhatsApp omitted the id a caller would act on. Pass the NORMALIZED content,
 * as the adapter does: a reply in a disappearing chat nests under `ephemeralMessage`.
 */
export function extractBaileysButtonReply(
  content: BaileysButtonReplyContent,
  contentType: string | undefined,
): IncomingMessage['button'] {
  if (contentType === 'buttonsResponseMessage') {
    const id = content.buttonsResponseMessage?.selectedButtonId;
    if (!id) {
      return undefined;
    }
    return {
      id,
      text: content.buttonsResponseMessage?.selectedDisplayText ?? undefined,
    };
  }

  if (contentType === 'templateButtonReplyMessage') {
    const id = content.templateButtonReplyMessage?.selectedId;
    if (!id) {
      return undefined;
    }
    return {
      id,
      text: content.templateButtonReplyMessage?.selectedDisplayText ?? undefined,
    };
  }

  if (contentType === 'listResponseMessage') {
    const id = content.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (!id) {
      return undefined;
    }
    return {
      id,
      text: content.listResponseMessage?.title ?? undefined,
    };
  }

  if (contentType === 'interactiveResponseMessage') {
    const flow = content.interactiveResponseMessage?.nativeFlowResponseMessage;
    // Replies must carry a stable id: a display-text-only params payload is not actionable.
    const fromParams = parseNativeFlowButtonParams(flow?.paramsJson, { requireId: true });
    if (fromParams) {
      return fromParams;
    }
    // Some clients echo only the body text without a native-flow params payload; without an id the
    // reply is not actionable, so leave `button` unset and keep the text in `body`.
    return undefined;
  }

  return undefined;
}

/**
 * One hydrated template button as WhatsApp sends it. `index` is the proto field
 * (`proto.IHydratedTemplateButton.index`); URL/call CTAs are parsed so they can be dropped, not
 * published as clickable ids.
 */
interface BaileysHydratedTemplateButton {
  index?: number | null;
  quickReplyButton?: { id?: string | null; displayText?: string | null } | null;
  urlButton?: { url?: string | null; displayText?: string | null } | null;
  callButton?: { phoneNumber?: string | null; displayText?: string | null } | null;
}

/**
 * The inbound message-content subset the prompt-buttons extractor reads. Declared structurally, as
 * {@link BaileysBodyContent} is.
 */
export interface BaileysButtonsPromptContent {
  buttonsMessage?: {
    buttons?: Array<{
      buttonId?: string | null;
      buttonText?: { displayText?: string | null } | null;
      /**
       * Present on a NATIVE_FLOW button. Only `name` is read, to decide whether the button can be
       * answered at all; the params of a classic button's reply come from `buttonId`/`buttonText`
       * beside it, not from this block.
       */
      nativeFlowInfo?: { name?: string | null } | null;
    } | null> | null;
  } | null;
  interactiveMessage?: {
    nativeFlowMessage?: {
      buttons?: Array<{
        name?: string | null;
        buttonParamsJson?: string | null;
      } | null> | null;
    } | null;
  } | null;
  templateMessage?: {
    hydratedTemplate?: {
      hydratedButtons?: Array<BaileysHydratedTemplateButton | null> | null;
    } | null;
    hydratedFourRowTemplate?: {
      hydratedButtons?: Array<BaileysHydratedTemplateButton | null> | null;
    } | null;
  } | null;
  listMessage?: {
    sections?: Array<{
      rows?: Array<{
        rowId?: string | null;
        title?: string | null;
      } | null> | null;
    } | null> | null;
  } | null;
}

/**
 * WhatsApp's own ceilings are 3 reply buttons or 10 list rows. A slightly higher shared cap
 * covers every prompt arm (including native-flow) without letting a malformed `listMessage` with
 * thousands of rows reach persisted `metadata`, webhooks, WS clients, or `GET /messages`.
 */
export const BUTTONS_MAX_ENTRIES = 20;
/** Length cap applied to both `id` and `text` so a single choice cannot bloat a row. */
export const BUTTON_TEXT_MAX_LENGTH = 256;

/** Native-flow button `name`s that can be answered with a structured reply. CTA names are dropped. */
const CLICKABLE_NATIVE_FLOW_NAMES = new Set(['quick_reply', 'button_click']);

/**
 * One clickable choice, carrying the proto index a template reply must echo. Not published on
 * {@link IncomingMessage.buttons}: callers send `id` (and optional `text`) and the click path
 * looks the index up.
 */
export interface BaileysClickableChoice {
  id: string;
  text: string;
  /**
   * `proto.IHydratedTemplateButton.index` when the prompt declares one, otherwise the choice's
   * position. Undefined only for a hydrated template that numbers some of its buttons and not this
   * one: the reply then omits `selectedIndex` rather than inventing a number that belongs to a
   * different button. Every other prompt shape numbers by position, so it is always set there.
   */
  index?: number;
}

/**
 * Extract the choices offered by an inbound business prompt (buttons / native-flow quick replies /
 * template hydrated quick-replies / list rows). URL/call CTAs and other native-flow names are
 * omitted: they are not clickable, and publishing them in the same array `ClickButtonDto.buttonId`
 * points at would make every webhook consumer treat a URL as a button id. Returns `undefined` when
 * the content is not a prompt shape or carries no usable choices. Pass the NORMALIZED content, as
 * the adapter does.
 */
export function extractBaileysButtons(
  content: BaileysButtonsPromptContent,
  contentType: string | undefined,
): IncomingMessage['buttons'] {
  const choices = extractBaileysClickableButtons(content, contentType);
  return choices?.map(({ id, text }) => ({ id, text }));
}

const BUTTON_PROMPT_CONTENT_TYPES = new Set(['buttonsMessage', 'templateMessage', 'listMessage', 'interactiveMessage']);

export type BaileysButtonClickError = 'not_a_prompt' | 'unknown_button';

/**
 * The Baileys `sendMessage` content a button-click send relays, plus the resolved visible label.
 * Declared structurally so it stays unit-testable without importing WAProto.
 */
export interface BaileysButtonClickPayload {
  id: string;
  text: string;
  /**
   * Index into template hydrated buttons when the prompt is a template; otherwise the choice's
   * position. Absent for a choice a numbered template left unnumbered, see {@link BaileysClickableChoice}.
   */
  index?: number;
  /** `AnyMessageContent` fragment: `{buttonReply,type}` or `{listReply}`. */
  content: Record<string, unknown>;
}

/**
 * Resolve a click against a stored business prompt: validate the content type and button id, fill
 * in the display text when the caller omitted it, and build the `sendMessage` content WhatsApp
 * expects for that prompt shape. CTA url/call entries are not clickable, only quick-reply style
 * choices and list rows. When several choices share an id, a caller-supplied `text` disambiguates
 * (a list reusing `rowId` across sections).
 */
export function resolveBaileysButtonClick(
  content: BaileysButtonsPromptContent,
  contentType: string | undefined,
  buttonId: string,
  text?: string,
): { ok: true; payload: BaileysButtonClickPayload } | { ok: false; error: BaileysButtonClickError } {
  if (!contentType || !BUTTON_PROMPT_CONTENT_TYPES.has(contentType)) {
    return { ok: false, error: 'not_a_prompt' };
  }

  const choices = extractBaileysClickableButtons(content, contentType);
  if (!choices || choices.length === 0) {
    return { ok: false, error: 'not_a_prompt' };
  }

  const trimmedId = buttonId.trim();
  const trimmedText = text?.trim();
  // Prefer an (id, text) match so a list that reuses a rowId across sections answers with the
  // row whose title the caller sent, not the first duplicate. Fall back to the first id match
  // when text is omitted.
  let matchIndex = trimmedText
    ? choices.findIndex(choice => choice.id === trimmedId && choice.text === trimmedText)
    : -1;
  if (matchIndex < 0) {
    matchIndex = choices.findIndex(choice => choice.id === trimmedId);
  }
  if (matchIndex < 0) {
    return { ok: false, error: 'unknown_button' };
  }

  const match = choices[matchIndex];
  const resolvedText = (trimmedText || match.text || trimmedId).trim();
  const selectedIndex = match.index;
  const payload: BaileysButtonClickPayload = {
    id: trimmedId,
    text: resolvedText,
    index: selectedIndex,
    content: toBaileysButtonClickContent(contentType, trimmedId, resolvedText, selectedIndex),
  };
  return { ok: true, payload };
}

/**
 * Choices that can be answered with a structured reply. URL/call CTAs and other native-flow names
 * are excluded: the WhatsApp client opens CTAs locally and there is no reply shape to fake.
 * {@link extractBaileysButtons} is a projection of this list, so the published `buttons[]` and the
 * click allowlist cannot disagree.
 */
export function extractBaileysClickableButtons(
  content: BaileysButtonsPromptContent,
  contentType: string | undefined,
): BaileysClickableChoice[] | undefined {
  if (contentType === 'buttonsMessage') {
    return collectChoices(
      (content.buttonsMessage?.buttons ?? []).map((button, position) => {
        const text = button?.buttonText?.displayText?.trim();
        if (!text) return undefined;
        // A button in this envelope can still be a native-flow CTA (open a URL, dial a number), and
        // those cannot be answered with a reply. Keyed off the presence of nativeFlowInfo rather
        // than the type enum, which reaches us as a number or as its string name depending on how
        // the message was decoded, and which a CTA may omit entirely.
        const flow = button?.nativeFlowInfo;
        if (flow && !CLICKABLE_NATIVE_FLOW_NAMES.has(flow.name ?? '')) {
          return undefined;
        }
        const id = button?.buttonId?.trim() || text;
        return { id, text, index: position };
      }),
    );
  }

  if (contentType === 'interactiveMessage') {
    return collectChoices(
      (content.interactiveMessage?.nativeFlowMessage?.buttons ?? []).map((button, position) => {
        const name = button?.name ?? 'quick_reply';
        if (!CLICKABLE_NATIVE_FLOW_NAMES.has(name)) {
          return undefined;
        }
        const parsed = parseNativeFlowButtonParams(button?.buttonParamsJson);
        if (!parsed) return undefined;
        const label = (parsed.text ?? parsed.id).trim();
        if (!label) return undefined;
        return { id: parsed.id.trim() || label, text: label, index: position };
      }),
    );
  }

  if (contentType === 'templateMessage') {
    const hydrated =
      content.templateMessage?.hydratedTemplate?.hydratedButtons ??
      content.templateMessage?.hydratedFourRowTemplate?.hydratedButtons ??
      [];
    // One index namespace per prompt. `selectedIndex` goes back to the business bot verbatim, and a
    // hydrated template numbers its buttons itself, so the array position is only a stand-in for a
    // template that carries no numbering at all. Falling back per entry mixed the two inside one
    // prompt, where a position can collide with another button's declared index and answer the bot
    // with a number belonging to a different choice.
    //
    // An entry the template left unnumbered is still offered, with no index of its own: the field
    // has explicit presence on the wire, so the reply carries the id and the label and simply omits
    // `selectedIndex`. Dropping the choice instead would hide a button the user can see and tap in
    // WhatsApp, and refuse it through the click route, which is a worse answer than one honest
    // reply that names itself by id. The unnumbered case includes a template whose only numbered
    // button is a url or call CTA, which is never offered here in the first place.
    const numbered = hydrated.some(entry => typeof entry?.index === 'number');
    return collectChoices(
      hydrated.map((entry, position) => {
        const quick = entry?.quickReplyButton;
        if (!quick?.displayText?.trim()) return undefined;
        const label = quick.displayText.trim();
        const protoIndex = numbered ? entry?.index : position;
        return {
          id: quick.id?.trim() || label,
          text: label,
          index: typeof protoIndex === 'number' ? protoIndex : undefined,
        };
      }),
    );
  }

  if (contentType === 'listMessage') {
    const rows = (content.listMessage?.sections ?? []).flatMap(section => section?.rows ?? []);
    return collectChoices(
      rows.map((row, position) => {
        const text = row?.title?.trim();
        if (!text) return undefined;
        return { id: row?.rowId?.trim() || text, text, index: position };
      }),
    );
  }

  return undefined;
}

function collectChoices(entries: Array<BaileysClickableChoice | undefined>): BaileysClickableChoice[] | undefined {
  const choices: BaileysClickableChoice[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    // The id goes back to the business bot verbatim on a click, so it is never rewritten: an id past
    // the cap is dropped (WhatsApp caps row ids far below it), while a long label is only trimmed.
    const id = entry.id;
    const text = entry.text.slice(0, BUTTON_TEXT_MAX_LENGTH);
    if (!id || id.length > BUTTON_TEXT_MAX_LENGTH || !text) continue;
    choices.push({ id, text, index: entry.index });
    if (choices.length >= BUTTONS_MAX_ENTRIES) break;
  }
  return choices.length > 0 ? choices : undefined;
}

/**
 * Map a resolved click onto Baileys' `sendMessage` helpers (`buttonReply` / `listReply`). Native-flow
 * `interactiveMessage` has no helper; it uses the template `buttonReply` shape, which is unverified
 * against a live business native-flow prompt and must not be advertised as `interactiveResponseMessage`.
 */
export function toBaileysButtonClickContent(
  contentType: string,
  buttonId: string,
  text: string,
  index: number | undefined,
): Record<string, unknown> {
  switch (contentType) {
    case 'buttonsMessage':
      return {
        buttonReply: { displayText: text, id: buttonId, index },
        type: 'plain',
      };
    case 'listMessage':
      return {
        listReply: {
          title: text,
          listType: 1, // SINGLE_SELECT
          singleSelectReply: { selectedRowId: buttonId },
        },
      };
    case 'templateMessage':
      return {
        buttonReply: { displayText: text, id: buttonId, index },
        type: 'template',
      };
    case 'interactiveMessage':
    default:
      // Unverified: Baileys has InteractiveResponseMessage.nativeFlowResponseMessage, but we have
      // not confirmed the server accepts it (or this template stand-in) when *sending* a reply to a
      // native-flow prompt. Keep the template helper so the send still inherits ephemeral/store/echo.
      return {
        buttonReply: { displayText: text, id: buttonId, index },
        type: 'template',
      };
  }
}

/**
 * Reads `id` / `button_id` (and optional display text) out of a native-flow `paramsJson` /
 * `buttonParamsJson` string. Returns `undefined` when the JSON is absent, malformed, or carries
 * neither an id nor a visible label. Pass `requireId: true` for reply parsing so a display-text-only
 * payload does not become a synthetic id.
 */
function parseNativeFlowButtonParams(
  paramsJson: string | null | undefined,
  opts?: { requireId?: boolean },
): IncomingMessage['button'] {
  if (!paramsJson) {
    return undefined;
  }
  try {
    const params = JSON.parse(paramsJson) as Record<string, unknown>;
    const text = pickNonEmptyString(params, ['display_text', 'displayText', 'title']);
    const id = pickNonEmptyString(params, ['id', 'button_id', 'buttonId']);
    if (id) {
      return { id, text: text ?? undefined };
    }
    if (opts?.requireId) {
      return undefined;
    }
    // Prompt buttons sometimes carry only the visible label in paramsJson.
    if (text) {
      return { id: text, text };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function pickNonEmptyString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
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
  // Interactive replies carry `contextInfo` on their own sub-message (the original prompt they
  // answer), so the quote/mentions/timer extractors must look there too.
  buttonsResponseMessage?: BaileysContextCarrier | null;
  templateButtonReplyMessage?: BaileysContextCarrier | null;
  listResponseMessage?: BaileysContextCarrier | null;
  interactiveResponseMessage?: BaileysContextCarrier | null;
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
    content.locationMessage ??
    content.buttonsResponseMessage ??
    content.templateButtonReplyMessage ??
    content.listResponseMessage ??
    content.interactiveResponseMessage;
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
  /** Pre-extracted button/list reply. Populated by the adapter when the user tapped a control. */
  button?: IncomingMessage['button'];
  /** Pre-extracted prompt choices. Populated by the adapter for business button/list prompts. */
  buttons?: IncomingMessage['buttons'];
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
    // Native-flow replies sometimes put the visible label only in paramsJson (surfaced on `button`),
    // not in `interactiveResponseMessage.body`, so prefer an explicit body, else the button label.
    body: fields.body || fields.button?.text || '',
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

  if (fields.button) {
    incoming.button = fields.button;
  }

  if (fields.buttons) {
    incoming.buttons = fields.buttons;
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
