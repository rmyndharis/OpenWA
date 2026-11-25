import { MessageMedia, MessageTypes, type Client, type Message } from 'whatsapp-web.js';
import {
  CustomLinkPreview,
  IncomingMessage,
  LocationInput,
  ContactCard,
  DeliveryStatus,
  MediaInput,
  MessageContact,
  MessageReaction,
  MessageReceiptParticipant,
  MessageReceipts,
  MessageResult,
  PollInput,
  Quotable,
} from '../interfaces/whatsapp-engine.interface';
import { MessageWithReactions, SerializedWid, readWid } from '../types/whatsapp-web-js.types';
import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import {
  SERIALIZED_MESSAGE_ID,
  chatKind,
  parseWaId,
  rememberChatOfPage,
  toNeutralJid,
  toParticipantWid,
  userPart,
} from '../identity/wa-id';
import {
  chatHistoryMediaBudgetBytes,
  coerceDeclaredSize,
  inboundMediaMaxBytes,
  ingestMediaBudgetBytes,
  isMediaDownloadEnabled,
} from './inbound-media-cap';
import { buildIncomingMessageBase, mapContactFields, wwebjsBody } from './message-mapper';
import { buildVCard } from './vcard';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EnginePageReloadingError } from '../../common/errors/engine-page-reloading.error';
import { EngineNotSentError, markNothingSent, markOutcomeUnknown } from '../../common/errors/engine-not-sent.error';
import { RecipientLookupUnansweredError } from '../../common/errors/engine-page.error';
import {
  type WwebjsEngineHost,
  navigationsSeen,
  requireClient,
  throwIfNavigatedSince,
  withPageWrite,
} from './wwebjs-host';
import { type EvaluatePage, type PinAnswer, pinInPage, settleWriteStatus } from './wwebjs-page-writes';
import { isNavigationError, isProtocolTimeout, toCapturedPageError } from './wwebjs-lifecycle';
import { recoverGroupChatById } from './wwebjs-chats';
import { isNotice, isUnlistedContentless } from './wwebjs-message-events';
import { noteVideoLoadTimeout } from './wwebjs-video-load-timeout';

/** Upper bound on the per-session resolved-recipient LRU cache ({@link WwebjsMessaging}). */
export const RESOLVED_SEND_IDS_MAX = 5000;

/**
 * Map a whatsapp-web.js MessageAck integer to the neutral DeliveryStatus.
 * wwebjs: -1 ERROR, 0 PENDING, 1 SERVER (sent), 2 DEVICE (delivered), 3 READ, 4 PLAYED.
 * PLAYED collapses to `read` (preserving prior behaviour, which treated ack>=3 as read).
 */
export function wwebjsAckToDeliveryStatus(ack: number): DeliveryStatus {
  if (ack < 0) return 'failed';
  if (ack >= 3) return 'read';
  if (ack === 2) return 'delivered';
  if (ack === 1) return 'sent';
  return 'pending';
}

/**
 * Extract call detail from a whatsapp-web.js `call_log` message, or `undefined` for any other type.
 * The public Message wrapper doesn't expose call fields, so we read them off the raw `_data`. An
 * incoming call (`!fromMe`) with no recorded `callDuration` was never answered → missed; an outgoing
 * call is never "missed". Used by getChatHistory, where `call_log` entries actually appear.
 */
export function extractWwebjsCall(msg: Message): { video: boolean; missed: boolean } | undefined {
  if ((msg.type as string) !== 'call_log') return undefined;
  const d = (msg as unknown as { _data?: { isVideoCall?: boolean; callDuration?: number } })._data ?? {};
  return { video: Boolean(d.isVideoCall), missed: !msg.fromMe && !d.callDuration };
}

/**
 * The `media` envelope for a message whose blob is not downloaded: keeps the sender-declared metadata
 * so the `media` field stays present (n8n/dashboard contract) while carrying the `omitted` marker
 * instead of base64. Used when downloads are disabled, the size pre-gate trips, the aggregate history
 * budget is spent, or the download fails/times out.
 */
export function declaredOnlyMedia(msg: Message): IncomingMessage['media'] {
  const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
  return {
    mimetype: data?.mimetype ?? '',
    filename: data?.filename || undefined,
    omitted: true,
    sizeBytes: coerceDeclaredSize(data?.size),
  };
}

/** The media size the sender declared; 0 when unknown, which does not pre-gate the download. */
export function declaredMediaSize(msg: Message): number {
  return coerceDeclaredSize((msg as unknown as { _data?: { size?: unknown } })._data?.size);
}

/**
 * Whether the adapter's capInboundMediaFor, with no override, downloads this message's media: its
 * pre-gates, read as the message arrives so the download can be given room first.
 */
export function plannedInboundDownload(msg: Message): boolean {
  return Boolean(msg.hasMedia) && isMediaDownloadEnabled() && declaredMediaSize(msg) <= inboundMediaMaxBytes();
}

/** A media download as {@link downloadMediaInPage} returns it: `data` is empty when the payload was over the cap. */
export interface PageMediaDownload {
  mimetype: string;
  filename?: string;
  data: string;
  /** Decrypted byte length, measured in the page. */
  sizeBytes: number;
}

/**
 * Page-side `Message#downloadMedia()` (whatsapp-web.js 1.34.7) with two changes. It passes `mimetype`
 * to `downloadAndMaybeDecrypt()`, which current WhatsApp Web builds require (upstream issue #201908),
 * and it checks the decrypted length against `maxBytes`. The size the sender declares is not the size
 * WhatsApp serves, and upstream base64-encodes and ships whatever it decrypts, so an understated
 * `fileLength` brought an arbitrarily large string over the protocol into Node. An over-cap payload
 * comes back with its size and no data. `undefined` and `null` keep upstream's meaning: no usable
 * media. whatsapp-web.js 1.34.8 reads the blob from WhatsApp Web's own cache instead
 * (`WWebJS.resolveMediaBlob`); this keeps the decrypt, which is what lets it measure before encoding.
 */
export async function downloadMediaInPage(args: {
  msgId: string;
  maxBytes: number;
}): Promise<PageMediaDownload | null | undefined> {
  type PageMsg = Record<string, unknown> & {
    mimetype: string;
    filename?: string;
    mediaData?: { mediaStage: string };
    downloadMedia: (opts: object) => Promise<unknown>;
  };
  const w = window as unknown as {
    require(m: 'WAWebCollections'): {
      Msg: {
        get: (id: string) => PageMsg | undefined;
        getMessagesById: (ids: string[]) => Promise<{ messages?: PageMsg[] } | undefined>;
      };
    };
    require(m: 'WAWebDownloadManager'): {
      downloadManager: { downloadAndMaybeDecrypt: (opts: object) => Promise<ArrayBuffer> };
    };
    WWebJS: { arrayBufferToBase64Async: (buffer: ArrayBuffer) => Promise<string> };
  };
  const collection = w.require('WAWebCollections').Msg;
  const msg = collection.get(args.msgId) || (await collection.getMessagesById([args.msgId]))?.messages?.[0];
  // REUPLOADING: the media expired and the phone is re-uploading it; it cannot be downloaded now.
  if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
  if (msg.mediaData.mediaStage !== 'RESOLVED') {
    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
  }
  if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') return undefined;
  try {
    const noopQpl = {
      addAnnotations() {
        return this;
      },
      addPoint() {
        return this;
      },
    };
    const decrypted = await w.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
      directPath: msg.directPath,
      encFilehash: msg.encFilehash,
      filehash: msg.filehash,
      mediaKey: msg.mediaKey,
      mediaKeyTimestamp: msg.mediaKeyTimestamp,
      type: msg.type,
      mimetype: msg.mimetype,
      signal: new AbortController().signal,
      downloadQpl: noopQpl,
    });
    const meta = { mimetype: msg.mimetype, filename: msg.filename, sizeBytes: decrypted.byteLength };
    if (meta.sizeBytes > args.maxBytes) return { ...meta, data: '' };
    return { ...meta, data: await w.WWebJS.arrayBufferToBase64Async(decrypted) };
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) return undefined;
    // WhatsApp Web's rejection classes are minified, and puppeteer rebuilds a page exception from the class
    // name alone (`t: t`). Name the rejection here, with the build it came from, from whatever it carries:
    // a name and message, the class and a status, or a bare string.
    const thrown = e as
      { name?: string; message?: string; status?: number; constructor?: { name?: string } } | string | null | undefined;
    const part = (value: string | number | null | undefined): string =>
      value === undefined || value === null ? '' : String(value);
    let summary: string;
    if (thrown instanceof Object) {
      const name = part(thrown.name) || (thrown.constructor === Object ? '' : part(thrown.constructor?.name));
      const reason = part(thrown.message) || (thrown.status === undefined ? '' : `status ${part(thrown.status)}`);
      summary = name && reason ? `${name}: ${reason}` : name || reason;
    } else {
      summary = part(thrown);
    }
    const build = (window as unknown as { Debug?: { VERSION?: unknown } }).Debug?.VERSION;
    throw new Error(`${summary || 'unknown rejection'} (WhatsApp Web ${String(build)})`, {
      cause: e,
    });
  }
}

/** Download a message's media through {@link downloadMediaInPage}, on the page that delivered it. */
export async function downloadCappedMedia(
  msg: Message,
  maxBytes: number,
): Promise<PageMediaDownload | null | undefined> {
  const { pupPage } = (
    msg as unknown as {
      client: { pupPage: { evaluate: <T, A>(fn: (arg: A) => Promise<T>, arg: A) => Promise<T> } };
    }
  ).client;
  return pupPage.evaluate(downloadMediaInPage, { msgId: readWid(msg.id) ?? '', maxBytes });
}

/**
 * Whether a MediaInput's string `data` is an http(s) URL (to be fetched through the SSRF-guarded
 * loadRemoteMedia) rather than base64. Case-insensitive, matching the Baileys adapter — a mixed-case
 * scheme like `HTTPS://` must still route through the guarded fetch, not be treated as base64.
 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Fetch remote media for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. The byte cap (node-fetch `size`) and `AbortSignal` timeout
 * bound memory use and hang time. `unsafeMime` is left at its default (false) to preserve the
 * existing MIME-detection behavior.
 */
export async function loadRemoteMedia(url: string, sessionProxyUrl: string | undefined): Promise<MessageMedia> {
  // Fetch through the SSRF-guarded path: it validates the host, pins a direct or SOCKS connection to
  // the vetted IP (so a DNS rebind can't redirect it to an internal target between check and connect;
  // an HTTP/HTTPS session proxy resolves the name itself, so nothing is pinned there), caps bytes,
  // and refuses redirects. We then build the MessageMedia from the returned bytes — NOT via
  // MessageMedia.fromUrl, whose bundled node-fetch performs its own unpinned DNS re-resolution.
  // `sessionProxyUrl` routes the fetch through this session's egress proxy (#1626); the browser's
  // own requests already ride Chromium's --proxy-server, this one is made by the gateway itself.
  const { data, mimetype } = await loadRemoteMediaBuffer(url, sessionProxyUrl);
  // The pathname keeps its percent-encoding, and the recipient would see `Laporan%20Bulanan.pdf`. A
  // malformed escape keeps the raw name, and a decoded slash is replaced so the label stays one name.
  let filename = new URL(url).pathname.split('/').pop() || undefined;
  try {
    filename = filename && decodeURIComponent(filename).replace(/[/\\]/g, '_');
  } catch {
    // URIError: keep the raw basename.
  }
  return new MessageMedia(mimetype || 'application/octet-stream', data.toString('base64'), filename);
}

/**
 * True when a send error is WhatsApp Web's "recipient needs a LID we don't have" failure, a bare
 * Error its own bundle raises when sending to a `@c.us` for a contact WhatsApp has migrated to
 * `@lid`. Matched on WhatsApp Web's error text — there is no structured code; revisit if WhatsApp
 * Web changes it.
 */
export function isNoLidForUserError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No LID for user');
}

/**
 * True when a send error is the page's "I could not resolve the quoted id" failure, raised only
 * because {@link WwebjsMessaging.quoteOptions} opts out of `ignoreQuoteErrors` (Injected/Utils.js:
 * 197-198). Matched on the text like {@link isNoLidForUserError} — there is no structured code, and
 * puppeteer prefixes its own `Evaluation failed:`, so this is a substring test rather than equality.
 */
export function isQuoteUnresolvedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Could not get the quoted message');
}

/** What fluent-ffmpeg throws when the ffmpeg of this host cannot run: not found, not startable, killed, no webp muxer. */
const FFMPEG_UNUSABLE =
  /^(?:Cannot find ffmpeg$|spawn .+ E[A-Z]+$|ffmpeg was killed with signal |Output formats? .+ not available$)/;
/** What fluent-ffmpeg throws when ffmpeg ran and refused: it exited with an error, or the declared type is no format it reads. */
const FFMPEG_REFUSED = /^(?:ffmpeg exited with code \d+|Input formats? .+ not available$)/;
/** ffmpeg's own words when its build takes none of the options whatsapp-web.js passes, or cannot open its output. */
const FFMPEG_OWN_OPTIONS =
  /Unrecognized option|Error splitting the argument list|Unknown encoder|Error opening output file/;

/**
 * Build a MessageMedia from a MediaInput (URL → fetched, base64/Buffer → wrapped).
 *
 * `trustDeclaredType: false` keeps the fetched response's content-type for a remote URL. Use it
 * wherever the mimetype is an INSTRUCTION rather than a label: whatsapp-web.js decides how to
 * convert a sticker from it, and `Util.formatImageToWebpSticker` returns the media untouched when it
 * already says webp. A caller that declares `image/webp` over bytes that are not webp would then
 * have raw bytes shipped as a sticker. The response describes bytes the caller never saw, so for
 * that one decision it is the better source. The declared filename still wins either way — that is
 * a label, and nothing branches on it.
 */
export async function toMessageMedia(
  media: MediaInput,
  sessionProxyUrl: string | undefined,
  opts?: { trustDeclaredType?: boolean; fallbackType?: string },
): Promise<MessageMedia> {
  if (typeof media.data === 'string' && isHttpUrl(media.data)) {
    const fetched = await loadRemoteMedia(media.data, sessionProxyUrl);
    // `loadRemoteMedia` derives both fields from the response (content-type, URL basename) because
    // that is all it has. The caller usually knows better, so let an explicit `mimetype`/`filename`
    // win — matching `resolveMediaBuffer` on the Baileys adapter, which already prefers the caller's.
    // `application/octet-stream` is the DTO's own placeholder, not a statement about the bytes.
    if (opts?.trustDeclaredType !== false && media.mimetype && media.mimetype !== 'application/octet-stream') {
      fetched.mimetype = media.mimetype;
    }
    // Sticker path (trustDeclaredType:false): a specific fetched image/video MIME stays authoritative,
    // but a generic/empty fetched MIME carries no information, and the caller's declared
    // image/* or video/* would otherwise be discarded — whatsapp-web.js then rejects the format
    // before running the sticker conversion. Fall back ONLY in that one shape: remote URL +
    // trustDeclaredType:false + generic fetched type + convertible declared type. Canonicalize the
    // value handed downstream (lowercased, params stripped) so a mixed-case declared type is
    // normalized exactly once. A declared image/webp IS accepted here when the fetched response
    // carries no usable MIME — the caller is asserting what the bytes actually are, so trusting it
    // only in the generic-fetched shape can't bypass the sticker conversion the way globally
    // trusting a declared WebP over a specific fetched type would. Arbitrary application/* is
    // rejected (e.g. the DTO's own octet-stream placeholder, or application/pdf).
    const normalizeMediaType = (value?: string): string => (value ?? '').split(';', 1)[0].trim().toLowerCase();
    const fetchedType = normalizeMediaType(fetched.mimetype);
    const declaredType = normalizeMediaType(media.mimetype);
    const fetchedTypeIsGeneric =
      !fetchedType || fetchedType === 'application/octet-stream' || fetchedType === 'binary/octet-stream';
    const declaredTypeIsConvertible = declaredType.startsWith('image/') || declaredType.startsWith('video/');
    if (opts?.trustDeclaredType === false && fetchedTypeIsGeneric && declaredTypeIsConvertible) {
      fetched.mimetype = declaredType;
    }
    // An image, video or audio route already says what kind of media it carries. When neither the
    // caller nor the host says more (the placeholder over an empty or generic response, the S3
    // default for an object uploaded without a type), WA Web would classify the bytes from that
    // generic type and deliver a photo as a document, so the route's default type stands in.
    const declaredTypeIsUnknown = !declaredType || declaredType === 'application/octet-stream';
    if (opts?.fallbackType && fetchedTypeIsGeneric && declaredTypeIsUnknown) {
      fetched.mimetype = opts.fallbackType;
    }
    if (media.filename) {
      fetched.filename = media.filename;
    }
    return fetched;
  }
  const data = typeof media.data === 'string' ? media.data : media.data.toString('base64');
  return new MessageMedia(media.mimetype, data, media.filename);
}

/**
 * Build the `MessageResult` for a send from whatever whatsapp-web.js hands back.
 *
 * `client.sendMessage()` can RESOLVE with `undefined` instead of throwing, and it collapses two
 * opposite outcomes into that one value (the end of `Client.sendMessage`): the chat could not be resolved so nothing
 * was sent (`if (!chat) return null` in `Client.sendMessage`), or the message went out and only its id could
 * not be read back (`Msg.get` miss, `WWebJS.sendMessage` in `Injected/Utils.js`). Nothing here can tell those apart, so an
 * absent message is reported as a failed send: a false negative is visible and retryable, while
 * claiming delivery for a message that never left is not recoverable. wwebjs's own typings hide the
 * case entirely — `index.d.ts` declares `Promise<Message>`, so `strict` never flagged these reads.
 *
 * A `Message` instance is different: wwebjs only builds one from a real message model, so its presence
 * proves the send happened. An id it cannot read there means "sent, id unknown" and carries the empty
 * sentinel `forwardMessage` already returns — which `saveOutgoingMessage` stores as NULL rather than a
 * fabricated id that a later ack could mis-match.
 */
export function toMessageResult(msg: Message | undefined): MessageResult {
  if (!msg) {
    throw new Error(
      'the engine returned no message for this send, so it may not have been delivered — check the chat before retrying',
    );
  }
  const id = msg.id as unknown as SerializedWid | undefined;
  return { id: readWid(id) ?? '', timestamp: msg.timestamp };
}

/**
 * The mentions as WhatsApp Web's strict id parser takes them: one neutral id per entry. The send DTOs accept an
 * individual id in any spelling (padding, upper case, the `s.whatsapp.net` dialect, a `:device` suffix) and hand it
 * on as typed, and a `message:sending` plugin may rewrite the list after validation. The Baileys adapter folds them
 * at its boundary and so does this one. A lid stays a lid. Only strings inside a list are folded: anything else a
 * plugin returns, an entry that is not a string or a list that is not an array, reaches the library as it would have,
 * rather than becoming a TypeError here.
 */
function neutralMentions(mentions: string[]): string[] {
  if (!Array.isArray(mentions)) return mentions;
  return mentions.map(mention => (typeof mention === 'string' ? toParticipantWid(mention) : mention));
}

/**
 * whatsapp-web.js drops some sends to a channel or a status/broadcast list before it touches the page
 * (`Client.js` sendMessage returns null): a reply, a location or a contact card to any of them, and a
 * poll or a sticker to a status or broadcast list. `toMessageResult` can only read that null as a send
 * that may have gone out, a 500 the send breaker counts, so refuse it up front with a 501. The
 * recipient tests are the library's own, so the two cannot drift. A plain 501, not
 * EngineNotSupportedError: the send methods are supported, and that class marks a whole method
 * unavailable in the capability matrix.
 */
function ensureSendable(chatId: string, shape: 'reply' | 'location' | 'contact card' | 'poll' | 'sticker'): void {
  const channel = /@\w*newsletter\b/.test(chatId);
  if (/@\w*broadcast\b/.test(chatId) || (channel && shape !== 'poll' && shape !== 'sticker')) {
    const to = channel ? 'a channel' : 'a status or broadcast list';
    throw markNothingSent(
      new NotImplementedException(`whatsapp-web.js cannot send a ${shape} to ${to}; nothing was sent.`),
    );
  }
}

/**
 * What a send answers 409 when WhatsApp Web reloaded its page after a first attempt had run. The attempt may have
 * left the page, so unlike the reload refusal of a request that sent nothing, it does not say to send it again.
 */
export const PAGE_RELOADED_DURING_SEND_MESSAGE =
  'WhatsApp Web reloaded its page while the message was being sent, and it may or may not have been sent. ' +
  'Check the chat before sending it again.';

/**
 * A not-ready refusal as a send answers it once an attempt has run. The reload refusal carries a `code` and
 * `retryAfterSeconds` that tell a client to ask again, which is right only for a request that sent nothing, so here
 * it becomes a plain not-ready 409 that says the message may have been sent. Any other refusal is returned as it is.
 */
function afterAttempt<T>(error: T): T | EngineNotReadyError {
  return error instanceof EnginePageReloadingError ? new EngineNotReadyError(PAGE_RELOADED_DURING_SEND_MESSAGE) : error;
}

/**
 * Throw `answer` as the plain not-ready 409 of an attempt that a page reload cut short, and return for any other
 * failure. The attempt may have left the page, so the answer says the outcome is unknown instead of telling the
 * client to ask again (markOutcomeUnknown: a keyed send keeps its `Idempotency-Key`, a paced one its admission), and
 * as a 4xx it does not feed the send breaker, which a reload says nothing about. `since` is {@link navigationsSeen}
 * where the attempt started. A failure counts as the reload as `rethrowIfNavigation` (./wwebjs-host) reads it: the
 * navigation text, or any other failure of a call a navigation was stamped during, but not a dead page, an error this
 * application built or a failure captured inside the page.
 */
export function throwIfCutByReload(host: WwebjsEngineHost, error: unknown, since: number, answer: string): void {
  if (isNavigationError(error, navigationsSeen(host) !== since) && !host.isPageTransportError(error)) {
    throw markOutcomeUnknown(new EngineNotReadyError(answer));
  }
}

/**
 * Messaging operations extracted from WhatsAppWebJsAdapter: the send paths (with the @c.us -> @lid
 * resolution cache), reactions, history, delete and edit. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly.
 */
export class WwebjsMessaging {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle; see {@link requireClient} for a teardown that lands in between. */
  private client(): Client {
    return requireClient(this.host);
  }

  /**
   * The readiness check of a send before anything was handed to the page: its 409 proves nothing was sent, so a
   * keyed send frees its `Idempotency-Key`. Not for a check after a send attempt, which may have left the page.
   */
  private ensureReadyToSend(): void {
    try {
      this.host.ensureReady();
    } catch (error) {
      throw markNothingSent(error);
    }
  }

  /**
   * The readiness check after a send attempt has run: its 409 does not prove the first attempt stayed off the wire,
   * so it carries markOutcomeUnknown, and a paced send keeps its admission as a keyed send keeps its `Idempotency-Key`.
   * A page that is reloading answers what {@link afterAttempt} makes of its refusal.
   */
  private ensureReadyAfterAttempt(): void {
    try {
      this.host.ensureReady();
    } catch (error) {
      throw markOutcomeUnknown(afterAttempt(error));
    }
  }

  /** The reads of this delegate: {@link withPageWrite} says what a dead page and an expired timeout answer. */
  private withPage<T>(context: string, op: () => Promise<T>): Promise<T> {
    return withPageWrite(this.host, context, op);
  }

  /**
   * A read that runs before a reply or forward has sent anything. When the page died under it, or the
   * session went away meanwhile, nothing was sent: report the death, then answer the not-ready 409 a
   * send gets everywhere else, not the plain page error the send breaker counts. Any other failure
   * rethrows unchanged. Not for the send itself, whose failure leaves the outcome unknown.
   */
  private async readBeforeSend<T>(context: string, read: () => Promise<T>): Promise<T> {
    const since = navigationsSeen(this.host);
    try {
      return await read();
    } catch (error) {
      this.host.reportIfPageTransportError(error, context);
      this.ensureReadyToSend();
      // A reload that cut the read short, by what the failure says or by a navigation stamped while it ran, is the
      // retryable 409 every other call gets for it, and nothing was sent.
      if (isNavigationError(error, navigationsSeen(this.host) !== since) && !this.host.isPageTransportError(error))
        throw markNothingSent(new EnginePageReloadingError());
      if (isProtocolTimeout(error))
        throw new EngineNotSentError(`WhatsApp Web did not answer the ${context} read in time`);
      throw error;
    }
  }

  // Cache of resolved individual recipients: `<phone>@c.us` -> the id `sendMessage` accepts (a
  // `<lid>@lid` for a migrated contact, or the confirmed `@c.us` for a non-migrated one). `getNumberId`
  // is a rate-limited WhatsApp Web existence probe that also throws intermittently, so caching every
  // confirmed resolution keeps ordinary sends from re-probing on each message (#580). A `@lid` is
  // stable; a stale entry (a contact that migrates mid-session) self-heals via the retry in
  // `sendResolved`.
  // LRU-bounded at RESOLVED_SEND_IDS_MAX entries so a long-lived session addressing fresh numbers
  // cannot grow memory without bound; evicting an entry also drops it from `unreportedLids`.
  private readonly resolvedSendIds = new Map<string, string>();
  // The `<phone>@c.us` keys of the cache above whose `@lid` the mapping store has not taken (its write failed):
  // the next send reports the pair again, so a failed write costs one more write, not a fresh probe.
  private readonly unreportedLids = new Set<string>();

  /**
   * Resolve an individual (`@c.us`) recipient to the id whatsapp-web.js will accept. WhatsApp has
   * migrated some contacts to privacy-id addressing, for which `sendMessage` throws `No LID for user`
   * on the phone WID but accepts the `@lid` that `getNumberId` returns (#573). Any server-confirmed
   * resolution (a distinct `@lid` OR a confirmed non-migrated `@c.us`) is cached, since it is stable
   * and re-probing costs a rate-limited round-trip (#580); a `null`/thrown lookup is NOT cached so an
   * unregistered or transiently-flaky contact keeps being retried. Groups/channels and already-`@lid`
   * targets are returned unchanged, and any resolution failure falls back to the original id so a send
   * is never blocked on it.
   */
  async resolveSendId(chatId: string): Promise<string> {
    return (await this.lookupSendId(chatId)).id;
  }

  /**
   * {@link resolveSendId} together with whether the lookup answered. A `getNumberId` that threw says nothing
   * about the recipient: the id is then the unresolved one, and `failure` is what the lookup threw.
   */
  private async lookupSendId(recipient: string): Promise<{ id: string; answered: boolean; failure?: unknown }> {
    // Every spelling of a phone id (the `s.whatsapp.net` dialect, upper case, a `:device` suffix) names one recipient,
    // resolved and cached in its neutral `<phone>@c.us` form, as the Baileys engine classifies its sends.
    if (parseWaId(recipient).kind !== 'user') {
      return { id: recipient, answered: true };
    }
    const chatId = toNeutralJid(recipient);
    const cached = this.resolvedSendIds.get(chatId);
    if (cached) {
      // Touch recency so active recipients stay in the cache.
      this.resolvedSendIds.delete(chatId);
      this.resolvedSendIds.set(chatId, cached);
      if (this.unreportedLids.delete(chatId)) this.reportLid(chatId, cached);
      return { id: cached, answered: true };
    }
    try {
      const wid = await this.host.getNumberId(chatId);
      if (wid) {
        this.rememberResolvedSendId(chatId, wid);
        if (wid.endsWith('@lid')) this.reportLid(chatId, wid);
        return { id: wid, answered: true };
      }
      return { id: chatId, answered: true };
    } catch (failure) {
      return { id: chatId, answered: false, failure };
    }
  }

  /**
   * `result`, naming the phone id the send was handed (`handedTo`, see sendResolved) when it is not the one the
   * caller wrote: WhatsApp holds the recipient under other digits (see MessageResult.resolvedChatId). Read from
   * the send itself, not from the lookup memory, which another send to the same number may have changed since.
   * A send handed the contact's `@lid` names no phone, and its pair is reported under the id the caller wrote
   * (see reportLid), so it names nothing. Only a phone id is ever resolved to another phone id.
   */
  private resolvedResult(chatId: string, handedTo: string | undefined, result: MessageResult): MessageResult {
    if (!handedTo || parseWaId(handedTo).kind !== 'user') return result;
    const resolvedChatId = toNeutralJid(handedTo);
    return resolvedChatId === toNeutralJid(chatId) ? result : { ...result, resolvedChatId };
  }

  private rememberResolvedSendId(chatId: string, wid: string): void {
    this.resolvedSendIds.delete(chatId);
    this.resolvedSendIds.set(chatId, wid);
    while (this.resolvedSendIds.size > RESOLVED_SEND_IDS_MAX) {
      const oldest = this.resolvedSendIds.keys().next().value;
      if (oldest === undefined) break;
      this.resolvedSendIds.delete(oldest);
      this.unreportedLids.delete(oldest);
    }
  }

  /**
   * The answer to a `No LID for user` send whose re-resolution did not answer. The gateway learned nothing
   * about the recipient, so it is not reported unreachable: a reload that cut the lookup short is the
   * not-ready 409 of a send after an attempt ({@link afterAttempt}), and anything else is what it was,
   * WhatsApp Web refusing the send in the page. That is an engine error with an unproven outcome (500), so
   * a keyed send keeps its key taken, but one the send breaker does not count: it says nothing about the
   * account.
   */
  private unansweredLookup(chatId: string, sendError: Error, failure: unknown): Error {
    if (failure instanceof EngineNotReadyError) return markOutcomeUnknown(afterAttempt(failure));
    this.host.logger.warn('Could not re-resolve a recipient after "No LID for user": the lookup did not answer', {
      sessionId: this.host.config.sessionId,
      chatId,
      error: failure instanceof Error ? failure.message : String(failure),
    });
    return new RecipientLookupUnansweredError(
      { name: sendError.name || 'Error', message: sendError.message },
      sendError,
    );
  }

  /**
   * Persist a learned phone -> lid so the message read-path (resolveJidCandidates) can bridge this contact's
   * `@c.us` and `@lid` rows on a pure whatsapp-web.js deployment (#583 R3). Fire-and-forget: resolution (and
   * the send) must never block/fail on the write. A write the store reports failed (it resolves false, or
   * rejects) is marked for the next send, unless a newer resolution has replaced this one meanwhile.
   */
  private reportLid(chatId: string, wid: string): void {
    const failed = (): void => {
      if (this.resolvedSendIds.get(chatId) === wid) this.unreportedLids.add(chatId);
    };
    void this.host.config.lidMappingStore
      ?.remember(userPart(wid), userPart(chatId), this.host.config.sessionId)
      ?.then(stored => {
        if (stored === false) failed();
      }, failed);
  }

  /**
   * The send options that attach a quote, or nothing at all when the caller asked for none.
   *
   * `ignoreQuoteErrors` defaults to TRUE in the library (documented and applied in
   * `Client.sendMessage`): with it left alone an id whatsapp-web.js cannot resolve sends the message ANYWAY,
   * unquoted, and reports success. A caller who asked for a reply and received a loose message has
   * no signal that anything went wrong, so this opts out and lets the failure surface.
   *
   * A second, narrower drop is NOT covered by that flag: if the message resolves but `canReplyMsg`
   * is false, `quotedMsgOptions` stays empty and the send proceeds unquoted (Injected/Utils.js:
   * 187-195). That one is upstream behaviour we cannot switch off from here.
   */
  private quoteOptions(quotedMessageId?: string): { quotedMessageId?: string; ignoreQuoteErrors?: boolean } {
    return quotedMessageId ? { quotedMessageId, ignoreQuoteErrors: false } : {};
  }

  /**
   * Resolve `chatId` and run `send` against the resolved id. If the send fails with `No LID for user`
   * — the signature of a contact whose cached/resolved id is stale (typically a `@c.us` for a contact
   * that has since migrated to `@lid`) — drop the mapping, re-resolve once, and retry only if the
   * fresh id differs, so a genuinely unreachable recipient surfaces its error instead of looping.
   *
   * When re-resolution cannot help, the recipient is unreachable rather than stale, and the raw
   * `No LID for user` is replaced with {@link RecipientUnreachableError} (400). The bare page-side
   * Error carries no status and no recipient, so letting it through produced an opaque 500 for what
   * is really a caller-visible fact the gateway already established: `getNumberId` returned null.
   * A re-resolution that threw established nothing, so it gets no such verdict and no retry: see
   * {@link unansweredLookup}.
   *
   * The answers given once the first attempt failed with `No LID for user` (a not-ready 409, the unreachable
   * recipient, a quote the retry cannot resolve) carry markOutcomeUnknown: the page can throw after the message is
   * on the wire, so none of them proves the message stayed off it. An answer given before that attempt still
   * carries markNothingSent. An attempt that a page reload cut short, the first or the retry, answers
   * {@link PAGE_RELOADED_DURING_SEND_MESSAGE} the same way (see {@link throwIfCutByReload}).
   *
   * `quotedMessageId` gets the same treatment for the same reason. Opting out of `ignoreQuoteErrors`
   * makes an id the page cannot resolve throw, but it throws a bare Error, and two things follow from
   * that: the caller receives a 500 for an id THEY supplied, where the Baileys adapter answers 404
   * (`requireStored`) for the identical request; and `countsTowardSendBreaker` classifies anything
   * that is not an HttpException as an account-standing failure, so a caller retrying a stale id
   * would trip the send breaker on a fault that is purely their own. Mapping it to
   * {@link MessageNotFoundError} (404) settles both — the status matches Baileys and the published
   * `docs/06` table, and the breaker exempts it as a 4xx.
   */
  private async sendResolved<T>(
    chatId: string,
    send: (to: string) => Promise<T>,
    quotedMessageId?: string,
    handed?: { to?: string },
  ): Promise<T> {
    if (quotedMessageId) ensureSendable(chatId, 'reply');
    const to = await this.resolveSendId(chatId);
    // The lookup is an await a teardown can land in, and resolveSendId answers a failed lookup with the
    // unresolved id. The reply and forward legs send through the Message's own client, which the host's
    // readiness check on getClient never sees, so a send must not leave for a closing page from here.
    this.ensureReadyToSend();
    const since = navigationsSeen(this.host);
    if (handed) handed.to = to;
    try {
      return await send(to);
    } catch (err) {
      // A transport-level failure means the page/browser is gone — report it as a death signal.
      // No-op for ordinary send errors; the retry/throw behavior below is unchanged.
      this.host.reportIfPageTransportError(err, 'sendMessage');
      // A reload that cut the attempt comes first: the page it opened holds neither the quoted message nor the id
      // mapping, so what failed on it is not the quote or the stale id it reads as, and the message may be out.
      throwIfCutByReload(this.host, err, since, PAGE_RELOADED_DURING_SEND_MESSAGE);
      // Before the LID branch: an unresolvable quote is neither stale-id nor transport, and
      // re-resolving the recipient would not make the quoted message appear. The page refuses it before
      // it builds the message, and this is the first attempt, so nothing was sent.
      if (quotedMessageId && isQuoteUnresolvedError(err)) {
        throw markNothingSent(new MessageNotFoundError(quotedMessageId));
      }
      if (parseWaId(chatId).kind !== 'user' || !isNoLidForUserError(err)) {
        throw toCapturedPageError(err);
      }
      this.resolvedSendIds.delete(toNeutralJid(chatId));
      this.unreportedLids.delete(toNeutralJid(chatId));
      const lookup = await this.lookupSendId(chatId);
      const fresh = lookup.id;
      // Same gap as above, and before the comparison: a lookup that failed because the session went away
      // answers the unresolved id, which would read as an unreachable recipient.
      this.ensureReadyAfterAttempt();
      if (!lookup.answered) {
        throw this.unansweredLookup(chatId, err as Error, lookup.failure);
      }
      if (fresh === to) {
        throw markOutcomeUnknown(new RecipientUnreachableError(chatId));
      }
      // The first send threw, but wwjs can throw after the message is already on the wire — so this
      // retry may produce a duplicate. Log it: without this the second copy is invisible.
      this.host.logger.warn('Send retried against a re-resolved id after "No LID for user"; may duplicate', {
        chatId,
        staleId: to,
        freshId: fresh,
      });
      const retrySince = navigationsSeen(this.host);
      if (handed) handed.to = fresh;
      try {
        return await send(fresh);
      } catch (retryErr) {
        // The page can die during the retry as well; report it exactly as the first attempt does.
        this.host.reportIfPageTransportError(retryErr, 'sendMessage');
        throwIfCutByReload(this.host, retryErr, retrySince, PAGE_RELOADED_DURING_SEND_MESSAGE);
        // Same remap as the first attempt. Re-resolving the RECIPIENT says nothing about the quoted
        // message, so a send that reaches the page on the fresh id and only then fails on the quote
        // is the same caller fault — without this it would be a 500 on the retry where the identical
        // failure on the first attempt was a 404.
        if (quotedMessageId && isQuoteUnresolvedError(retryErr)) {
          throw markOutcomeUnknown(new MessageNotFoundError(quotedMessageId));
        }
        // The re-resolved id is no better than the stale one — same unreachable recipient, and the
        // raw error would 500 exactly as the first one did.
        if (isNoLidForUserError(retryErr)) {
          throw markOutcomeUnknown(new RecipientUnreachableError(chatId));
        }
        throw toCapturedPageError(retryErr);
      }
    }
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    options?: { linkPreview?: boolean; customPreview?: CustomLinkPreview } & Quotable,
  ): Promise<MessageResult> {
    this.ensureReadyToSend();
    // wwebjs takes the neutral `<phone>@c.us` / `<lid>@lid` WIDs as mentionedJidList, so each mention is folded to
    // that form (neutralMentions). Omit the options object entirely when none are given to keep today's send behavior.
    //
    // Only an explicit `false` is forwarded. whatsapp-web.js reads the flag as
    // `linkPreview === false ? undefined : true` (in Client.sendMessage), so passing `true` is identical to
    // passing nothing — sending it anyway would add an options object to every plain send for no
    // change in behaviour.
    // whatsapp-web.js takes a BOOLEAN only (index.d.ts) — there is no way to hand it title,
    // description or a thumbnail. Silently dropping the caller's preview would send a message that
    // looks nothing like what they asked for, so it refuses instead.
    if (options?.customPreview) {
      throw markNothingSent(new EngineNotSupportedError('sendTextMessage(customPreview)'));
    }
    const sendOptions: {
      mentions?: string[];
      linkPreview?: boolean;
      quotedMessageId?: string;
      ignoreQuoteErrors?: boolean;
    } = this.quoteOptions(options?.quotedMessageId);
    if (mentions?.length) sendOptions.mentions = neutralMentions(mentions);
    if (options?.linkPreview === false) sendOptions.linkPreview = false;

    const handed: { to?: string } = {};
    const msg = await this.sendResolved(
      chatId,
      to =>
        Object.keys(sendOptions).length
          ? this.client().sendMessage(to, text, sendOptions)
          : this.client().sendMessage(to, text),
      options?.quotedMessageId,
      handed,
    );
    return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, undefined, 'image/jpeg');
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, undefined, 'video/mp4');
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, media.ptt ? { sendAudioAsVoice: true } : undefined, 'audio/mpeg');
  }

  /**
   * Without `sendMediaAsDocument` whatsapp-web.js lets WA Web classify the attachment from its declared
   * mimetype (`Injected/Utils.js` `processMediaData` -> `prepRawMedia`), so an `image/*`, `video/*` or
   * `audio/*` payload posted here reached the recipient as a photo/video/audio bubble — re-encoded and
   * stripped of its filename — instead of a document (#989). Baileys has always forced it via the
   * explicit `document:` content key, so the two engines disagreed on the same request.
   *
   * The flag is withheld for `status@broadcast` and broadcast lists: whatsapp-web.js refuses every
   * `@broadcast` recipient outright once it is set (`Client.js` returns `null`, which `toMessageResult`
   * surfaces as a failed send), so setting it there would turn a working send into an error rather than
   * improve it. Those recipients keep the classification they have today.
   */
  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const kind = chatKind(chatId);
    const asDocument = kind !== 'status' && kind !== 'broadcast';
    return this.sendMediaMessage(chatId, media, asDocument ? { sendMediaAsDocument: true } : undefined);
  }

  private async sendMediaMessage(
    chatId: string,
    media: MediaInput,
    extraOptions?: { sendAudioAsVoice?: boolean; sendMediaAsDocument?: boolean },
    fallbackType?: string,
  ): Promise<MessageResult> {
    this.ensureReadyToSend();
    this.host.ensureNotChannelRecipient(chatId);

    // Build the media once (a remote URL is fetched here); sendResolved may retry the send itself.
    const messageMedia = await toMessageMedia(media, this.host.config.proxy?.url, { fallbackType });
    // A nameless document reaches WA Web as `new File([blob], undefined)` and is labelled literally
    // "undefined". Only documents render a filename, so default just this path — as Baileys does.
    if (extraOptions?.sendMediaAsDocument && !messageMedia.filename) {
      messageMedia.filename = 'file';
    }
    const handed: { to?: string } = {};
    const msg = await this.sendResolved(
      chatId,
      to =>
        this.client().sendMessage(to, messageMedia, {
          caption: media.caption,
          ...(media.mentions?.length ? { mentions: neutralMentions(media.mentions) } : {}),
          // sendAudioAsVoice only for audio, sendMediaAsDocument only for documents;
          // {...undefined} contributes no keys.
          ...extraOptions,
          ...this.quoteOptions(media.quotedMessageId),
        }),
      media.quotedMessageId,
      handed,
    ).catch((error: unknown) => {
      noteVideoLoadTimeout(this.host, error, messageMedia.mimetype);
      throw error;
    });

    return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    ensureSendable(chatId, 'location');
    // Import Location class dynamically from whatsapp-web.js
    const module = await import('whatsapp-web.js');
    const Location = module.Location || module.default?.Location;

    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const handed: { to?: string } = {};
    const msg = await this.sendResolved(
      chatId,
      to => this.client().sendMessage(to, loc, this.quoteOptions(location.quotedMessageId)),
      location.quotedMessageId,
      handed,
    );
    return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReadyToSend();
    ensureSendable(chatId, 'contact card');
    // Shared builder sanitizes name/number (strips CR/LF, digits-only waid) so a crafted contact
    // can't inject extra vCard fields — the previous inline build interpolated raw values.
    const vcard = buildVCard(contact);

    const handed: { to?: string } = {};
    const msg = await this.sendResolved(
      chatId,
      to =>
        this.client().sendMessage(to, vcard, {
          parseVCards: true,
          ...this.quoteOptions(contact.quotedMessageId),
        }),
      contact.quotedMessageId,
      handed,
    );
    return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    // Sticker has its own send path (sendMediaAsSticker), not the sendMediaMessage funnel, but it
    // hits the same channel crash: for a channel wwjs drops the sticker form and runs processMediaData
    // with sendToChannel, which still ends at msg.avParams() (in `WWebJS.sendMessage`). Guard it too (#673).
    this.host.ensureNotChannelRecipient(chatId);
    ensureSendable(chatId, 'sticker');
    // Keep the fetched content-type for a remote URL: here the mimetype selects the conversion, and
    // whatsapp-web.js returns the media unconverted once it reads as webp (Util.formatImageToWebpSticker).
    const messageMedia = await toMessageMedia(media, this.host.config.proxy?.url, { trustDeclaredType: false });
    // whatsapp-web.js converts only a type it reads as an image or a video, and throws a bare 'Invalid media format'
    // for anything else before the page send (Util.formatToWebpSticker): a 500 the send breaker counted. Same test as
    // the library's, refused as the 400 Baileys gives.
    const type = messageMedia.mimetype ?? '';
    if (!type.includes('image') && !type.includes('video')) {
      throw markNothingSent(
        new BadRequestException(
          `A sticker must be an image or a video whatsapp-web.js can convert. Received '${type}'.`,
        ),
      );
    }

    // The library converts a video with the ffmpeg of this host, inside sendMessage and before it calls the page.
    // It exports nothing to run that apart from the send, so a failure of it is told by what it throws. A retry
    // after "No LID for user" follows an attempt that reached the page, so it proves nothing about the message.
    let attempts = 0;
    const handed: { to?: string } = {};
    const msg = await this.sendResolved(
      chatId,
      to => {
        const retry = attempts++ > 0;
        return this.client()
          .sendMessage(to, messageMedia, {
            sendMediaAsSticker: true,
            ...this.quoteOptions(media.quotedMessageId),
            // Same options bag every other media send uses, so the library tags a sticker exactly as it
            // tags an image. Omitted when empty to leave an untagged sticker call unchanged.
            ...(media.mentions?.length ? { mentions: neutralMentions(media.mentions) } : {}),
          })
          .catch((error: unknown) => {
            const conversion = this.videoStickerConversionFailure(error);
            if (!conversion) throw error;
            throw retry ? markOutcomeUnknown(conversion) : markNothingSent(conversion);
          });
      },
      media.quotedMessageId,
      handed,
    );
    return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
  }

  /**
   * What a failed ffmpeg conversion of a video sticker answers, or `undefined` for an error that is not one. The
   * conversion runs before whatsapp-web.js calls the page, so its failure says nothing about the account or the message
   * and must not count toward the send breaker. ffmpeg refusing the video (corrupt, an unsupported codec, a declared
   * type it has no format for) is the caller's 400. A host with no ffmpeg, one that cannot start it, or one whose build
   * takes none of the options the library passes (an ffmpeg that no longer reads `-vsync`) is a 503, and the reason
   * goes to the log. The match is on the text of fluent-ffmpeg and of ffmpeg, so a host fault worded differently
   * answers 400 until its words are added here.
   */
  private videoStickerConversionFailure(error: unknown): Error | undefined {
    // Read the message by shape: an error that Node's own child_process raised can come from another realm.
    const message = (error as { message?: unknown } | null | undefined)?.message;
    if (typeof message !== 'string') return undefined;
    const refused = FFMPEG_REFUSED.test(message);
    if (!refused && !FFMPEG_UNUSABLE.test(message)) return undefined;
    if (refused && !FFMPEG_OWN_OPTIONS.test(message)) {
      return new BadRequestException(`The video could not be converted to a sticker: ${message.slice(0, 300)}`);
    }
    this.host.logger.warn('ffmpeg could not convert a video sticker on this host', {
      sessionId: this.host.config.sessionId,
      reason: message.slice(0, 500),
    });
    return new EngineNotSentError(
      'The ffmpeg of this host could not convert the video to a sticker, so nothing was sent. The reason is in the ' +
        'gateway log; a video sticker needs a working ffmpeg on the host.',
    );
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    ensureSendable(chatId, 'poll');
    // Import Poll dynamically like Location; the .default fallback covers builds where the
    // classes land on module.default (a plain `module.Poll` would be undefined there and
    // `new Poll` fails with "not a constructor").
    const module = await import('whatsapp-web.js');
    const Poll = module.Poll || module.default?.Poll;

    // wwebjs's typings mark `messageSecret` as required, but at runtime it is optional (it is
    // only used as a custom poll id), so cast to the constructor's options type to pass just
    // allowMultipleAnswers.
    type PollSendOptions = ConstructorParameters<typeof Poll>[2];
    const pollOptions = { allowMultipleAnswers: poll.allowMultipleAnswers === true } as PollSendOptions;
    const handed: { to?: string } = {};
    const msg = await this.sendResolved(
      chatId,
      to =>
        this.client().sendMessage(
          to,
          new Poll(poll.name, poll.options, pollOptions),
          this.quoteOptions(poll.quotedMessageId),
        ),
      poll.quotedMessageId,
      handed,
    );
    return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    this.ensureReadyToSend();
    ensureSendable(chatId, 'reply');
    try {
      // Find the message to quote
      const quotedMsg = await this.readBeforeSend('replyToMessage', () =>
        this.findInFetchWindow(chatId, quotedMsgId, () => this.ensureReadyToSend()),
      ).catch((error: unknown) => {
        if (error instanceof MessageNotFoundError) markNothingSent(error);
        throw error;
      });

      // Reply's send leg hits the same `No LID for user` path as a normal send for a migrated contact,
      // so route it through sendResolved (resolve @c.us->@lid, cache, self-heal). reply(content, chatId)
      // accepts an explicit target (#583 R1).
      // reply(content, chatId, options) takes the same options bag as sendMessage, so a quoted send
      // tags participants exactly as a plain one does. The options argument is omitted entirely when
      // no tags were asked for, keeping an ordinary reply's call shape untouched (same rule as the
      // send path).
      const handed: { to?: string } = {};
      const msg = await this.sendResolved(
        chatId,
        to =>
          mentions?.length
            ? quotedMsg.reply(text, to, { mentions: neutralMentions(mentions) })
            : quotedMsg.reply(text, to),
        undefined,
        handed,
      );
      return this.resolvedResult(chatId, handed.to, toMessageResult(msg));
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'replyToMessage');
      throw error;
    }
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReadyToSend();
    try {
      const msgToForward = await this.readBeforeSend('forwardMessage', () =>
        this.findInFetchWindow(fromChatId, messageId, () => this.ensureReadyToSend()),
      ).catch((error: unknown) => {
        if (error instanceof MessageNotFoundError) markNothingSent(error);
        throw error;
      });

      // The forward's send leg fails with `No LID for user` for a LID-migrated destination, so resolve
      // it (and self-heal a stale mapping) via sendResolved. Capture the id actually sent to so the
      // id-recovery below reads back from the SAME (resolved) chat, not the raw @c.us (#583 R1).
      // The ids already in that chat are read first, on every attempt, so the recovery below can tell
      // the forwarded copy from an earlier send with the same whole-second timestamp. Only messages
      // WhatsApp Web already holds are read, so this never pages the chat's history in ahead of the
      // send. A read that merely fails never blocks the forward; it only leaves the copy unidentified.
      // The newest timestamp it saw is kept too: a concurrent call on the destination chat can page
      // older history in before the second read, and those messages are older than every one loaded.
      let resolvedTo = toChatId;
      let before = undefined as { ids: Set<string>; newest: number } | undefined;
      let attempted = false;
      await this.sendResolved(toChatId, async to => {
        resolvedTo = to;
        before = undefined;
        try {
          const snapshot = await this.loadedOwnMessages(to);
          before = {
            ids: new Set(snapshot.map(m => toMessageResult(m).id)),
            newest: snapshot.reduce((newest, m) => Math.max(newest, m.timestamp), 0),
          };
        } catch (error) {
          // A page that died under the read is not a read that merely failed. Chromium stopped from
          // outside rejects this call before any death listener runs, so report it for the check below,
          // but only once the page itself reads gone: a live page whose exception merely says "connection
          // closed" is a read that failed, and the forward goes on.
          await this.host.reportOnceGone?.(error, 'forwardMessage');
          this.host.logger.warn(`Could not read the destination chat before forwarding: ${String(error)}`);
        }
        // The read above is a page round trip a teardown can land in. Its failure only leaves the copy
        // unidentified, unless it shows the page is gone, which this check then refuses. Before the first
        // attempt nothing was forwarded, so that refusal frees a keyed send's key; a retry's may follow a copy.
        if (attempted) this.ensureReadyAfterAttempt();
        else this.ensureReadyToSend();
        attempted = true;
        return msgToForward.forward(to);
      });

      // whatsapp-web.js's forward() returns void, so BEST-EFFORT recover the REAL id of the sent copy by
      // reading it back from the destination chat: the one outgoing message that was not there before
      // the forward, or, when several appeared, the only one marked forwarded. The delivery-ack matcher
      // keys on this id, so a synthetic one would leave the forward stuck at SENT; Baileys already
      // returns the real id. The forward already succeeded here, so recovery must NEVER fail the operation.
      // When the copy can't be identified (no snapshot, or no single candidate, as with two forwards
      // to the same chat at once) we return an explicit-unknown id (empty): message.service then
      // leaves the row's waMessageId unset so no ack can mis-match it. A wrong id is worse: persisting
      // it merges the forward's row into the other message's.
      try {
        if (before) {
          const known = before;
          const fresh = (await this.loadedOwnMessages(resolvedTo)).filter(m => {
            const id = toMessageResult(m).id;
            return id !== '' && !known.ids.has(id) && m.timestamp >= known.newest;
          });
          const forwarded = fresh.filter(m => m.isForwarded);
          const sent = fresh.length === 1 ? fresh[0] : forwarded.length === 1 ? forwarded[0] : undefined;
          if (sent) {
            return this.resolvedResult(toChatId, resolvedTo, toMessageResult(sent));
          }
        }
      } catch (error) {
        // Still surface a dead page even though the send itself succeeded (detection only; the
        // forward's best-effort recovery contract is unchanged).
        this.host.reportIfPageTransportError(error, 'forwardMessage');
        this.host.logger.warn(`Forward succeeded but recovering the sent message id failed: ${String(error)}`);
      }
      return this.resolvedResult(toChatId, resolvedTo, { id: '', timestamp: Math.floor(Date.now() / 1000) });
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'forwardMessage');
      throw error;
    }
  }

  /**
   * The messages this account sent to a chat that WhatsApp Web already holds, forwarded copy included
   * once the send returns. No `limit`: with one, whatsapp-web.js loads earlier history until it has
   * that many, which in a chat this account rarely writes to walks the whole history.
   */
  private async loadedOwnMessages(chatId: string): Promise<Message[]> {
    const chat = await this.client()
      .getChatById(chatId)
      .catch(error => recoverGroupChatById(this.host, 'forwardMessage', chatId, error));
    return (await chat?.fetchMessages({ fromMe: true })) ?? [];
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.host.ensureReady();
    await withPageWrite(this.host, 'reactToMessage', async () => {
      // NOTE: do NOT resolve chatId to @lid here — whatsapp-web.js reacts using the found message's own
      // id, not this chatId, so LID-resolving the lookup gives no send benefit and would miss a message
      // stored under the pre-migration @c.us chat (#583).
      const message = await this.findInFetchWindow(chatId, messageId);
      await (message as MessageWithReactions).react(emoji);
    });
    this.host.logger.debug('Reacted to message', { messageId, emoji: emoji || '(removed)' });
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.host.ensureReady();
    const reactions = await this.withPage('getMessageReactions', async () => {
      const message = await this.findInFetchWindow(chatId, messageId);
      const msgWithReactions = message as MessageWithReactions;
      return msgWithReactions.hasReaction ? msgWithReactions.getReactions() : [];
    });
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  /**
   * Who received, read and played a message this account sent. The message is resolved by its full id from
   * everything WhatsApp Web holds, not from the 100-message window the writes search, so an older message
   * still answers. The chat fence only checks `chatId`, so the message must sit in that chat: one from
   * another chat is a 404, checked before the direction so the answer says nothing about that chat.
   */
  async getMessageReceipts(chatId: string, messageId: string): Promise<MessageReceipts> {
    this.host.ensureReady();
    // getMessageById throws an unnamed page error (a 500) for anything but a full serialized id, so any other
    // shape is answered here, without a page call: no message has one.
    if (!SERIALIZED_MESSAGE_ID.test(messageId)) throw new MessageNotFoundError(messageId, chatId);
    const info = await this.withPage('getMessageReceipts', async () => {
      const message = await this.client().getMessageById(messageId);
      if (!message || !(await this.isInChat(message, chatId))) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      // getInfo answers null for a received message, which would read as nobody having seen it.
      if (!message.fromMe) {
        throw new EngineRefusedError(
          `message ${messageId} was not sent by this account; only its own messages carry receipts`,
        );
      }
      // getInfo reads through the page of the client that resolved the message: a teardown since is the 409.
      this.host.ensureReady();
      return message.getInfo();
    });
    // Past the checks above, getInfo answers null only for a message WhatsApp Web no longer holds.
    if (!info) throw new MessageNotFoundError(messageId, chatId);

    const mapReceipts = (list?: Array<{ id: SerializedWid | string; t: number }>): MessageReceiptParticipant[] => {
      if (!Array.isArray(list)) return [];
      return list.map(item => ({
        participant: toNeutralJid(readWid(item.id) || ''),
        timestamp: Number(item.t || 0),
      }));
    };

    return {
      delivery: mapReceipts(info.delivery),
      deliveryRemaining: typeof info.deliveryRemaining === 'number' ? info.deliveryRemaining : undefined,
      read: mapReceipts(info.read),
      readRemaining: typeof info.readRemaining === 'number' ? info.readRemaining : undefined,
      played: mapReceipts(info.played),
      playedRemaining: typeof info.playedRemaining === 'number' ? info.playedRemaining : undefined,
    };
  }

  /**
   * Whether a message sits in the named chat: `to` for one this account sent, else `from`, as
   * buildIncomingMessageBase reads it. A 1:1 chat WhatsApp Web keeps under its `@lid` can be named by the
   * contact's `@c.us`, so a name that differs is resolved through the chat WhatsApp Web opens for it.
   */
  private async isInChat(message: Message, chatId: string): Promise<boolean> {
    const own = message.fromMe ? message.to : message.from;
    // A message that names no chat belongs to none; without this, a missing chat on both sides would compare equal.
    if (!own) return false;
    if (toNeutralJid(own) === toNeutralJid(chatId)) return true;
    const chat = await this.client()
      .getChatById(chatId)
      .catch(error => recoverGroupChatById(this.host, 'getMessageReceipts', chatId, error));
    return chat?.id._serialized === own;
  }

  async getChatHistory(
    chatId: string,
    limit: number = 50,
    includeMedia: boolean = false,
    mediaMaxBytes?: number,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    this.host.ensureReady();
    // Chat.fetchMessages only caps the page when `limit > 0` (Chat.js), so a 0/negative/NaN limit fails
    // OPEN and returns every loaded message. Substitute the default, as getChannelMessages does.
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 50;
    let chatWid: string | undefined;
    const messages = await this.withPage('getChatHistory', async () => {
      const chat = await this.client()
        .getChatById(chatId)
        .catch(error => recoverGroupChatById(this.host, 'getChatHistory', chatId, error));
      // Unknown chat: getChatById resolves undefined rather than throwing. A chat this account cannot
      // see has no history to return, so yield an empty page instead of dereferencing undefined (a
      // TypeError that would surface as a 500).
      if (!chat) {
        return [];
      }
      chatWid = readWid(chat.id);
      return chat.fetchMessages({ limit: safeLimit });
    });
    const results: IncomingMessage[] = [];
    // The chat can be asked for by phone number and held by WhatsApp Web under the lid: say which, for the
    // caller that matches the page to stored rows.
    if (chatWid) rememberChatOfPage(results, chatWid);
    // Aggregate base64 budget across the whole pass: the per-message cap bounds ONE blob, but without
    // an aggregate bound a 100-message history could stack ~100 × 50 MiB into one response. Once the
    // running total crosses the budget, later media messages get the declared-only `omitted` marker —
    // no download — while everything already inlined stays inline (a small history is byte-identical
    // to before). `signal` (client disconnect) stops the loop between messages; partials are returned.
    // The 25 MiB default is sized for ONE HTTP response and is too tight for a caller that ingests
    // into a store instead (mediaMaxBytes — the status seed): two ~10 MiB videos are ~28 MiB of
    // base64 and would strip every later status. Such a caller gets a budget derived from its own
    // per-item cap rather than an exemption — unbounded here would mean a 50-item seed could stack
    // ~650 MiB of base64 on the heap at connect time. The cap is clamped to MEDIA_DOWNLOAD_MAX_BYTES
    // first, as capInboundMediaFor clamps each item, so an override above it cannot inflate the budget.
    let mediaBudget = !includeMedia
      ? Number.POSITIVE_INFINITY
      : mediaMaxBytes === undefined
        ? chatHistoryMediaBudgetBytes()
        : ingestMediaBudgetBytes(Math.min(mediaMaxBytes, inboundMediaMaxBytes()));
    // Sender contacts resolved so far, keyed like Message.getContact() (`author || from`). Each lookup
    // is a page round trip and a history page repeats the same few senders, so resolve each once; a
    // failed lookup is remembered as undefined rather than retried for every later message.
    const senderContacts = new Map<string, MessageContact | undefined>();
    for (const msg of messages) {
      if (signal?.aborted) {
        break;
      }
      // Drop system notices and unlisted contentless entries before any page lookup (contact, quote, media).
      if (isNotice(msg, this.host.logger) || isUnlistedContentless(msg, this.host.logger)) {
        continue;
      }
      // Reuse the shared mapper so history messages carry the same author/contact
      // enrichment as live incoming messages (#223). The mapper defaults chatId to
      // msg.from, which is wrong here (history includes fromMe messages whose `from`
      // is our own number), so override it to the requested chat and recompute the
      // chatId-derived flags (isGroup, isStatusBroadcast, kind) from the real chat.
      const out = buildIncomingMessageBase(msg);
      if (msg.type === MessageTypes.REVOKED) {
        // WhatsApp Web lists a deleted message under the id of the delete notice, not the id the message
        // had, so a consumer holding the original could not match the two. The notice names the original
        // in `protocolMessageKey`; report that id, and keep the entry's own when the key is absent.
        const originalKey = (msg as unknown as { protocolMessageKey?: SerializedWid | string }).protocolMessageKey;
        const originalId = readWid(originalKey);
        if (originalId) {
          out.id = originalId;
        }
      }
      out.chatId = chatId;
      out.isGroup = chatId.endsWith('@g.us');
      out.isStatusBroadcast = chatId === 'status@broadcast';
      out.kind = chatKind(chatId);
      // buildIncomingMessageBase only fills `contact` from the raw payload's synchronous
      // notifyName, which is frequently absent on a history-fetched message object (unlike a
      // freshly delivered one). Without this, a group participant not in the account's own
      // contacts (author-only, no saved name) shows no sender label at all in the chat view,
      // even though the live `message` event handler resolves one via getContact() for the
      // exact same message. Mirror that here so history and live rendering agree.
      const senderId = msg.author || msg.from;
      if (!senderContacts.has(senderId)) {
        let resolved: MessageContact | undefined;
        try {
          const contact = await msg.getContact();
          if (contact) resolved = mapContactFields(contact, process.env.WEBHOOK_CONTACT_DETAILS === 'true');
        } catch (error) {
          if (this.host.isPageTransportError(error)) {
            this.host.reportIfPageTransportError(error, 'getChatHistory');
            throw new EngineTransportError('Transport died during getChatHistory');
          }
          this.host.logger.warn(
            `Failed to resolve contact for history message ${msg.id._serialized}: ${String(error)}`,
          );
        }
        senderContacts.set(senderId, resolved);
      }
      const merged = { ...out.contact, ...senderContacts.get(senderId) };
      if (Object.keys(merged).length > 0) {
        out.contact = merged;
      }
      const call = extractWwebjsCall(msg);
      if (call) out.call = call;
      // Mirror the live handler's location + quoted-message enrichment so history renders identically —
      // buildIncomingMessageBase sets type='location' but no coordinates, and never resolves quotes.
      if (msg.type === MessageTypes.LOCATION && msg.location) {
        out.location = {
          latitude: Number(msg.location.latitude),
          longitude: Number(msg.location.longitude),
          description: msg.location.description || undefined,
          address: msg.location.address || undefined,
          url: msg.location.url || undefined,
        };
      }
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          out.quotedMessage = { id: quoted.id._serialized, body: wwebjsBody(quoted) };
        } catch (error) {
          if (this.host.isPageTransportError(error)) {
            this.host.reportIfPageTransportError(error, 'getChatHistory');
            throw new EngineTransportError('Transport died during getChatHistory');
          }
          this.host.logger.warn(`Failed to resolve quoted message for ${msg.id._serialized}: ${String(error)}`);
        }
      }
      if (includeMedia && msg.hasMedia) {
        if (mediaBudget <= 0) {
          out.media = declaredOnlyMedia(msg);
        } else {
          try {
            // Same pre-gate + limiter as live media: a large historical blob shouldn't bloat the
            // response/heap. Callers (the status seed) can tighten the cap below the global default.
            const capped = await this.host.capInboundMediaFor(msg, mediaMaxBytes);
            if (capped) {
              out.media = capped;
              // Only an inlined payload spends budget; an omitted marker carries no base64.
              if (capped.data) {
                mediaBudget -= capped.data.length;
              }
            }
          } catch (error) {
            if (this.host.isPageTransportError(error)) {
              this.host.reportIfPageTransportError(error, 'getChatHistory');
              throw new EngineTransportError('Transport died during getChatHistory');
            }
            this.host.logger.warn(`Failed to download media for ${msg.id._serialized}: ${String(error)}`);
          }
        }
      }
      results.push(out);
    }
    return results;
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<string | void> {
    this.host.ensureReady();
    // NOTE: do NOT resolve chatId to @lid here — delete operates on the found message's own key, not
    // this chatId, so LID-resolving the lookup gives no benefit and would miss a message stored under
    // the pre-migration @c.us chat (#583).
    // The message is found by its serialized id or by the bare key id, but its row is keyed by the serialized one,
    // which is what the caller needs to clear the stored copy.
    const deleted = await withPageWrite(this.host, 'deleteMessage', async () => {
      const chat = await this.client()
        .getChatById(chatId)
        .catch(error => recoverGroupChatById(this.host, 'deleteMessage', chatId, error));
      if (!chat) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      const messages = await chat.fetchMessages({ limit: 100 });
      const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
      if (!message) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      this.host.ensureReady();
      await message.delete(forEveryone);
      return readWid(message.id);
    });
    this.host.logger.debug('Deleted message', { chatId, messageId, forEveryone });
    return deleted;
  }

  async editMessage(chatId: string, messageId: string, body: string, mentions?: string[]): Promise<MessageResult> {
    this.host.ensureReady();
    // Same lookup window as react/delete: fetchMessages sees only the 100 most recent messages.
    // NOTE: do NOT resolve chatId to @lid here - edit operates on the found message's own key, not
    // this chatId, so LID-resolving the lookup would miss a message stored under the pre-migration
    // @c.us chat (#583).
    const edited = await withPageWrite(this.host, 'editMessage', async () => {
      const chat = await this.client()
        .getChatById(chatId)
        .catch(error => recoverGroupChatById(this.host, 'editMessage', chatId, error));
      if (!chat) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      const messages = await chat.fetchMessages({ limit: 100 });
      const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
      if (!message) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      this.host.ensureReady();
      // An edit REPLACES the content, so tags are re-applied rather than preserved: omitting mentions
      // drops whatever the original carried. Options omitted entirely when none were asked for.
      return mentions?.length ? message.edit(body, { mentions: neutralMentions(mentions) }) : message.edit(body);
    });
    if (!edited) {
      // wwebjs RESOLVES null (instead of throwing) when the page-side edit is refused — only the
      // account's own text messages are editable; surface the refusal, not a phantom success.
      throw new EngineRefusedError(
        `the edit of message ${messageId} was rejected — only the account's own text messages can be edited`,
      );
    }
    this.host.logger.debug('Edited message', { chatId, messageId });
    return toMessageResult(edited);
  }

  /**
   * Locate a message in the 100-message fetch window shared by react/delete/edit — and now pin.
   * Deliberately NOT applied to the existing call sites: they differ in whether they tolerate an
   * unknown chat, and rewriting them is not this change's business.
   *
   * As with those sites, chatId is NOT lid-resolved: the pin acts on the found message's own key,
   * so resolving would only risk missing a message stored under the pre-migration @c.us chat.
   *
   * Readiness is checked again before the message is returned: it acts through the client that read it, so
   * a teardown that landed in the lookup would otherwise reach a closing page.
   */
  private async findInFetchWindow(
    chatId: string,
    messageId: string,
    ensureReady: () => void = () => this.host.ensureReady(),
  ): Promise<Message> {
    const chat = await this.client()
      .getChatById(chatId)
      .catch(error => recoverGroupChatById(this.host, 'findInFetchWindow', chatId, error));
    // getChatById RESOLVES undefined for an unknown chat rather than throwing, which is the same
    // client-facing outcome as a message outside the window — a 404, not a TypeError-driven 500.
    if (!chat) throw new MessageNotFoundError(messageId, chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) throw new MessageNotFoundError(messageId, chatId);
    ensureReady();
    return message;
  }

  async votePoll(chatId: string, pollMessageId: string, options: string[]): Promise<void> {
    this.host.ensureReady();
    // Same 100-message window as pin/react/delete, so a poll older than that is unreachable and
    // reported as not-found rather than as a failed vote.
    try {
      await withPageWrite(this.host, 'votePoll', async () => {
        const message = await this.findInFetchWindow(chatId, pollMessageId);
        // vote() matches option TEXTS exactly and silently drops the ones that match nothing. When
        // none match it sends an empty selection, the same as `options: []`, which CLEARS the vote
        // while the route answered 200. Refuse that case with the poll's real options so a typo or a
        // differently-cased text is reported instead of erasing the account's vote. An explicit `[]`
        // is still a deliberate clear. A message with no pollOptions is not a poll; vote() below
        // rejects it with its own error.
        const pollOptions = (message as unknown as { pollOptions?: Array<{ name?: unknown }> }).pollOptions;
        if (options.length > 0 && Array.isArray(pollOptions)) {
          const names = pollOptions.map(o => o?.name).filter((n): n is string => typeof n === 'string');
          if (!options.some(option => names.includes(option))) {
            throw new BadRequestException({
              statusCode: 400,
              error: 'Bad Request',
              message: `None of the options match poll ${pollMessageId}; options must be the exact texts: ${names
                .map(n => JSON.stringify(n))
                .join(', ')}`,
              code: 'POLL_OPTION_NOT_FOUND',
              validOptions: names,
            });
          }
        }
        await (message as unknown as { vote(selected: string[]): Promise<void> }).vote(options);
      });
    } catch (error) {
      // vote() throws a BARE STRING (not an Error) when the target is not a poll creation message
      // (Message.js). Left alone that surfaces as an opaque 500; it is a client mistake, so
      // map it to a 400. Anything that is a real Error is a genuine engine fault and propagates.
      if (typeof error === 'string') {
        throw new BadRequestException(`Message ${pollMessageId} is not a poll: ${error}`);
      }
      throw error;
    }
    this.host.logger.debug('Voted on poll', { chatId, pollMessageId, options: options.length });
  }

  /**
   * Pin or unpin a message in the 100-message window, through the page's own sender (see {@link pinInPage}): the
   * library's `pin` and `unpin` call it with positional arguments, which only the builds before the sender took an
   * options object answer. A build whose sender still takes them is the library's own call, as it always was.
   */
  private pinThroughPage(op: 'pinMessage' | 'unpinMessage', chatId: string, messageId: string, durationSeconds = 0) {
    const pin = op === 'pinMessage';
    return withPageWrite(this.host, op, async (): Promise<PinAnswer> => {
      const since = navigationsSeen(this.host);
      const message = await this.findInFetchWindow(chatId, messageId);
      const { pupPage } = this.client() as unknown as { pupPage: EvaluatePage };
      const answer = await pupPage.evaluate(pinInPage, message.id._serialized, pin, durationSeconds);
      // A document a reload has just opened has no sender either: that is the retryable 409, not a build without one.
      if (answer === 'missing') throwIfNavigatedSince(this.host, since);
      if (answer !== 'legacy') return answer;
      return pin ? message.pin(durationSeconds) : message.unpin();
    });
  }

  /**
   * Settle a pin or an unpin that the page answered with a status and not a verdict: the read it makes in front of the
   * send was answered with one (a rate limit, a timeout or a server error is the retryable 503, any other status a
   * refusal), or it refused a chat with a contact the account blocked before it sent anything. Returns for any other
   * answer.
   */
  private settlePinStatus(op: 'pin' | 'unpin', messageId: string, answer: PinAnswer): void {
    if (typeof answer !== 'object') return;
    settleWriteStatus(
      answer.status,
      {
        request: `the ${op} of message ${messageId}`,
        nothing: 'changed nothing',
        refused: (status, local) =>
          `the ${op} of message ${messageId} was rejected (${
            local ? 'the chat is with a contact this account blocked, nothing was sent' : `WhatsApp answered ${status}`
          })`,
      },
      answer.local,
    );
  }

  async pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void> {
    this.host.ensureReady();
    // The sender answers false for every refusal: a message it cannot resolve, a duration it has no option for, or a
    // send WhatsApp did not take. Surface that as a refusal instead of reporting a pin that never happened.
    const pinned = await this.pinThroughPage('pinMessage', chatId, messageId, durationSeconds);
    // Nothing was sent: the build has no sender this adapter can call.
    if (pinned === 'missing') throw new EngineNotSupportedError('pinMessage(no compatible pin sender on this build)');
    this.settlePinStatus('pin', messageId, pinned);
    if (pinned !== true) {
      throw new EngineRefusedError(
        `the pin of message ${messageId} was rejected — in a group only admins may pin, and the duration must be 24h, 7d or 30d`,
      );
    }
    this.host.logger.debug('Pinned message', { chatId, messageId, durationSeconds });
  }

  async starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    this.host.ensureReady();
    // Both resolve void, and the page-side helper silently does nothing when canStarMsg() refuses
    // the message (Message.js). There is no signal to map, so a star that WhatsApp declined
    // is indistinguishable from one it accepted — documented rather than faked into a refusal.
    await withPageWrite(this.host, 'starMessage', async () => {
      const message = await this.findInFetchWindow(chatId, messageId);
      await (star ? message.star() : message.unstar());
    });
    this.host.logger.debug(star ? 'Starred message' : 'Unstarred message', { chatId, messageId });
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    this.host.ensureReady();
    // A false answer means WhatsApp did not take the unpin (e.g. not an admin).
    const unpinned = await this.pinThroughPage('unpinMessage', chatId, messageId);
    if (unpinned === 'missing')
      throw new EngineNotSupportedError('unpinMessage(no compatible pin sender on this build)');
    this.settlePinStatus('unpin', messageId, unpinned);
    if (unpinned !== true) {
      throw new EngineRefusedError(`the unpin of message ${messageId} was rejected — in a group only admins may unpin`);
    }
    this.host.logger.debug('Unpinned message', { chatId, messageId });
  }
}
