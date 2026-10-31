import { queryLidPhone } from './baileys-identity-query';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAMessageKey,
  WASocket,
} from '@whiskeysockets/baileys';
import { generateSafeLinkPreview } from './safe-link-preview';
import {
  CallLinkType,
  CustomLinkPreview,
  ChatState,
  ContactCard,
  EngineEventCallbacks,
  IncomingMessage,
  LocationInput,
  MediaInput,
  MessageResult,
  MessageType,
  PollInput,
  Product,
  Quotable,
} from '../interfaces/whatsapp-engine.interface';
import { refusedStatusCode, toEngineParticipants } from './baileys-groups';
import { findSelfParticipant } from './baileys-group-mapper';
import { buildVCard } from './vcard';
import {
  baileysChatJid,
  isBaileysCatalogShare,
  mapBaileysMessageType,
  resolveBaileysButtonClick,
  setBaileysText,
  storedKeyInChatPersisted,
} from './baileys-message-mapper';
import { LINK_PREVIEW_THUMBNAIL_MAX_BYTES, loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { type createLogger } from '../../common/services/logger.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';
import { EngineNotSentError, markNothingSent } from '../../common/errors/engine-not-sent.error';
import { parseWaId, userPart } from '../identity/wa-id';
import { BAILEYS_QUERY_BUDGET_MS, confirmedWrite, withQueryDeadline } from './baileys-query-deadline';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { describeAudio } from './baileys-audio-probe';

/**
 * Messaging-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysMessagingHost {
  /** This session's egress proxy URL (snapshotted at session start), or undefined when direct. */
  sessionProxyUrl(): string | undefined;
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  /** The live socket, or null once a stop or logout has torn it down. */
  getSocketOrNull(): WASocket | null;
  readonly logger: ReturnType<typeof createLogger>;
  toNeutralJid(jid: string): string;
  toEngineJid(jid: string): string;
  findPersistedLidPhone?(jid: string): Promise<string | null>;
  normalizedSelfJid(): string;
  /** The chat's cached disappearing-messages timer (#473), or undefined when none is known. */
  getEphemeralExpiration(chatId: string): number | undefined;
  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  toUnixSeconds(ts: number | string | { toNumber(): number } | null | undefined): number;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  loadLib(): Promise<typeof BaileysLib>;
  /** Persist a just-sent message to the store; undefined when no store is configured. */
  putStoredMessage(msg: WAMessage): Promise<void> | undefined;
  /** Make a just-sent message the chat's last-message preview and sort time (its echo is skipped). */
  recordMessage(msg: WAMessage, type?: MessageType): void;
  /** Replace the chat preview's text when the message is still the chat's last one (edit, or '' once deleted). */
  recordMessageEdit(chatId: string, messageId: string, text: string, type?: MessageType): void;
  /** Record the id of a message this session just sent, so its library echo is recognised as ours. */
  rememberOwnSend(id: string | null | undefined): void;
  /** Look up a previously-seen message from the store (the reply/forward/react/delete handle). */
  getStoredMessage(messageId: string): Promise<WAMessage | null> | undefined;
  /** Rewrite a stored message in place (see BaileysMessageStore.update); undefined without a store. */
  updateStoredMessage(messageId: string, change: (stored: WAMessage) => WAMessage | null): Promise<void> | undefined;
  /** Whether this message was deleted for everyone, even where the stored copy does not show it yet. */
  wasDeletedForEveryone(messageId: string): boolean;
  /** Record a delete for everyone this session just made (see wasDeletedForEveryone). */
  markDeletedForEveryone(messageId: string): void;
  /** The text of an edit of this message the stored copy with key `target` does not show yet, if any. */
  pendingEditOf(messageId: string, target: WAMessageKey): string | undefined;
  /** Remember a lid<->phone pair the socket resolved, so later reads do not have to ask again. */
  recordLidMapping(lid: string, pn: string, isReported?: boolean): void;
  /** The currently-registered onMessageCreate callback, if any (assigned at initialize()). */
  getOnMessageCreate(): EngineEventCallbacks['onMessageCreate'];
  /** Map a WAMessage to its neutral shape (the adapter's inbound mapper). */
  mapMessage(
    msg: WAMessage,
    contentType: string | undefined,
    opts?: { skipMediaDownload?: boolean },
  ): Promise<IncomingMessage>;
}

/** RIFF….WEBP magic. Sniffed from the bytes, because the declared label may be the DTO's placeholder. */
function isWebpBuffer(data: Buffer): boolean {
  return (
    data.length > 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/**
 * Sticker payloads must BE WebP, not merely be called WebP.
 *
 * Baileys stamps the label unconditionally — `prepareWAMessageMedia` applies
 * `if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]` with
 * `MIMETYPE_MAP.sticker = 'image/webp'` (Utils/messages.js:18, 86-88) — and transcodes nothing. So
 * a PNG handed over here is published as a stickerMessage whose declared type contradicts its bytes,
 * and the send still reports success. whatsapp-web.js has no such gap: `sendMediaAsSticker: true`
 * routes through `Util.formatToWebpSticker`, which converts `image/*` and throws for anything else.
 *
 * An input that is already WebP is passed through BYTE-IDENTICAL: re-encoding an existing sticker
 * would strip the WebP EXIF sticker-pack metadata and change its size.
 *
 * `{ animated: true }` is not optional — without it sharp silently keeps only the first frame, which
 * would reintroduce the same quiet-corruption this function exists to remove.
 */
/**
 * Load the deferred `sharp` binary, mapping a LOAD failure to a 500 rather than the decode path's 400.
 * A native-binary load failure (older CPU, stripped/musl image, missing prebuilt) is a host capability
 * gap: a valid PNG would hit it too, so reporting it as a 400 tells the caller their image is malformed.
 */
export async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch (error) {
    throw new InternalServerErrorException(
      `Sticker conversion is unavailable: sharp could not load (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/**
 * Refuse SVG input process-wide. OpenWA never needs it, yet a sticker and the thumbnail of every outbound
 * image hand caller-supplied bytes to sharp, which autodetects SVG and parses it with librsvg: a native
 * decoder with a memory-safety record that is the largest attack surface on those two routes. The block is
 * libvips state shared by every importer of sharp, Baileys included, so it has to be set before the first
 * decode and not by the first sticker. Best effort: a sharp that cannot load has nothing to block, and the
 * routes that need it report that themselves (see loadSharp).
 */
export async function blockSvgDecoding(): Promise<void> {
  try {
    (await import('sharp')).default.block({ operation: ['VipsForeignLoadSvg'] });
  } catch {
    // sharp could not load, so there is no decoder to block.
  }
}

/**
 * Refuse a picture the image decoder cannot read, before Baileys hands it to that decoder: its own
 * conversion rejects such a file with an error nothing maps, which reached the client as a 500. An SVG is
 * one since blockSvgDecoding, and so is a file that is no image at all. Only the header is read. A sharp
 * that cannot load is left to the library, which reports that itself. The 400 is raised before anything
 * reaches WhatsApp, so it carries markNothingSent.
 */
export async function assertReadableImage(data: Buffer): Promise<void> {
  const sharp = await import('sharp').then(
    module => module.default,
    () => undefined,
  );
  if (!sharp) return;
  try {
    await sharp(data).metadata();
  } catch (error) {
    throw markNothingSent(
      new BadRequestException(
        `The picture could not be read as an image (SVG is not accepted): ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * Animation frames a sticker conversion accepts: a 10-second animation at 50 fps. Each frame is
 * resized and encoded at 512x512 (a few ms apiece), so cost is linear in the frame count, and a
 * GIF of 1x1 frames packs tens of thousands of them into well under a megabyte.
 */
export const MAX_STICKER_FRAMES = 500;

/**
 * Image conversions (stickers and link preview images) running at once, process-wide. Each sharp call
 * (a sticker's frame scan, then the pipeline) holds a libuv threadpool worker (4 by default) for its
 * whole run, and that pool also serves fs, dns.lookup, crypto and zlib.
 */
const imageConversions = new ConcurrencyLimiter(2);

/**
 * Re-encode a link preview image as the JPEG Baileys labels it (it stamps image/jpeg on any input),
 * fitted inside 1280x1280 without enlarging and turned upright by its EXIF orientation, so a
 * multi-megabyte original is not what every recipient downloads. JPEG has no alpha, so transparency
 * becomes white rather than libvips' default black. The decode reads the whole file, which refuses a
 * truncated or corrupt one that a header read lets through.
 */
async function toPreviewJpeg(data: Buffer): Promise<Buffer> {
  // A sharp that cannot load uploads the original as it is, as before this re-encode existed.
  const sharp = await loadSharp().catch(() => undefined);
  if (!sharp) return data;
  try {
    return await imageConversions.run(() =>
      sharp(data)
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer(),
    );
  } catch (error) {
    throw markNothingSent(
      new BadRequestException(
        `The picture could not be read as an image (SVG is not accepted): ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

async function toWebpSticker(data: Buffer, mimetype: string): Promise<Buffer> {
  if (isWebpBuffer(data)) {
    return data;
  }
  if (!mimetype.startsWith('image/')) {
    // Deliberately a 400 rather than EngineNotSupportedError: the capability IS supported, this
    // particular payload cannot become a sticker. A 501 would report the wrong thing and would also
    // make the row look unavailable to the parity gate's throw-scan. Like every refusal here it comes
    // before anything reaches WhatsApp, so it carries markNothingSent.
    throw markNothingSent(
      new BadRequestException(
        `A sticker must be a WebP image, or an image this gateway can convert to one. Received '${mimetype}'.`,
      ),
    );
  }
  // Imported lazily so an unusable `sharp` (a native binary that will not build or load on an older
  // CPU, a stripped image) degrades ONLY this one Baileys sticker route instead of killing the whole
  // gateway at boot. `sharp` sits at the top of a module the built-in engine loads unconditionally, so
  // an eager import made a single optional capability a hard boot requirement on both engines. Same
  // deferral the adapters already use for the engine libraries themselves.
  const sharp = await loadSharp();
  try {
    const image = sharp(data, { animated: true });
    return await imageConversions.run(async () => {
      // Counting frames only scans the file, so an oversized animation is refused before any decode.
      // The scan still runs on the threadpool and grows faster than the frame count, so it holds the
      // same slot as the pipeline.
      const { pages = 1 } = await image.metadata();
      if (pages > MAX_STICKER_FRAMES) {
        throw markNothingSent(
          new BadRequestException(
            `The sticker animation has ${pages} frames; at most ${MAX_STICKER_FRAMES} can be converted.`,
          ),
        );
      }
      return image
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp()
        .toBuffer();
    });
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    // Bytes that do not decode as the image they claim to be. Refuse before the socket rather than
    // ship them mislabelled — that is the whole point.
    throw markNothingSent(
      new BadRequestException(
        `The sticker image could not be converted to WebP: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/** Fetched Content-Types that say nothing about the bytes (a missing header reads as ''). */
const GENERIC_FETCHED_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * Resolve a MediaInput's data (Buffer | base64 string | http(s) URL) to bytes + mimetype.
 *
 * `sessionProxyUrl` is this session's egress proxy, which the URL fetch leaves through (#1626). It
 * is required, not optional, so a new call site cannot fetch direct on a proxied session by omission.
 *
 * `fallbackType` is the kind's default (image/jpeg, video/mp4, audio/mpeg, application/octet-stream for a
 * document), used for a URL whose type neither the caller nor the host names. A document needs one too:
 * Baileys labels a document with an empty type as application/pdf.
 */
export async function resolveMediaBuffer(
  media: MediaInput,
  sessionProxyUrl: string | undefined,
  fallbackType?: string,
): Promise<{ data: Buffer; mimetype: string }> {
  if (Buffer.isBuffer(media.data)) {
    return { data: media.data, mimetype: media.mimetype };
  }
  if (/^https?:\/\//i.test(media.data)) {
    const fetched = await loadRemoteMediaBuffer(media.data, sessionProxyUrl);
    // A generic placeholder mimetype (buildMediaInput's 'application/octet-stream' default when the
    // caller supplied none) carries no real signal, so the fetched Content-Type decides. That header
    // is taken as the host sent it, not sniffed from the bytes, so a missing or generic one is no
    // better than the placeholder and the kind's default stands in. This serves URL-based sends where
    // the caller has no mimetype to pass through the conversation-send facade (e.g. chatwoot-adapter
    // outbound relay).
    const callerMimetype = media.mimetype && media.mimetype !== 'application/octet-stream' ? media.mimetype : null;
    const unknown = fallbackType !== undefined && GENERIC_FETCHED_TYPES.has(fetched.mimetype.toLowerCase());
    return { data: fetched.data, mimetype: callerMimetype ?? (unknown ? fallbackType : fetched.mimetype) };
  }
  return { data: Buffer.from(media.data, 'base64'), mimetype: media.mimetype };
}

/** Baileys' DisconnectReason.connectionClosed, read without loading the library. */
const CONNECTION_CLOSED = 428;

/**
 * Give a WhatsApp throttle or timeout answer (WA code 429 or 408) its retryable 503 instead of letting
 * the raw Boom surface as a 500. `sendMessage` awaits several IQs before it relays the message (group
 * roster, devices, sessions) and nothing after the relay awaits a result, so a numeric code here is a
 * query WhatsApp turned away: a 429 provably sent nothing.
 *
 * A connection that closed under the send is the other provable case, as long as the message stanza
 * stays the last thing a send awaits (baileys-send-stanza-last.spec.ts pins that against the library):
 * Baileys refuses a write on a socket that is not open with `Boom('Connection Closed', 428)` before
 * encoding anything, and a query still pending when the WebSocket closes rejects with the bare close
 * code. Either way nothing reached WhatsApp, so it is EngineNotSentError, which a retry may repeat.
 * Every other failure is returned untouched: a write the socket itself failed may have left.
 */
export function mapSendRefusal(error: unknown): unknown {
  const code = refusedStatusCode(error);
  if (code === 429) return new EngineThrottledError('WhatsApp rate-limited the send (code 429)');
  if (code === 408) return new EngineTransportError('WhatsApp timed out a query the send depends on (code 408)');
  const boom = error as { isBoom?: unknown; output?: { statusCode?: unknown } } | null;
  if (typeof error === 'number' || (boom?.isBoom === true && boom.output?.statusCode === CONNECTION_CLOSED)) {
    return new EngineNotSentError('The WhatsApp connection closed before the message was sent');
  }
  return error;
}

export class BaileysMessaging {
  constructor(
    private readonly host: BaileysMessagingHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /** Bound a write whose confirmation the library discards; see baileys-query-deadline.ts. */
  private confirmed<T>(work: Promise<T>, operation: string): Promise<T> {
    return confirmedWrite(work, this.queryBudgetMs, operation);
  }

  /**
   * Baileys sets no deadline on a media upload. A direct session uploads through Node's global agent, whose
   * 5 s idle timeout ends a stalled upload; a session proxy's agent has none, so a proxy that holds the tunnel
   * open and stops answering kept the send waiting for good. A request timeout replaces the agent's, so only a
   * proxied session gets one: it would lengthen the direct session's bound.
   */
  private uploadTimeoutMs(): number | undefined {
    return this.host.sessionProxyUrl() ? this.queryBudgetMs : undefined;
  }

  /**
   * Post-ensureReady socket handle. Read before the write, so its 409 (the socket torn down, or replaced since
   * `expected` was read) carries markNothingSent.
   */
  private sock(expected?: WASocket): WASocket {
    let socket: WASocket;
    try {
      socket = this.host.getSocket();
    } catch (error) {
      throw markNothingSent(error);
    }
    if (expected && socket !== expected) throw markNothingSent(new EngineNotReadyError());
    return socket;
  }

  /** The readiness check that opens a send: nothing is written yet, so its 409 carries markNothingSent. */
  private ensureReadyToSend(): void {
    try {
      this.host.ensureReady();
    } catch (error) {
      throw markNothingSent(error);
    }
  }

  /**
   * The thumbnail fields of a custom preview that carries an image. The bytes come from the caller's
   * base64 or from the SSRF-guarded loader with a thumbnail-sized cap, never as a URL handed to
   * Baileys, which would fetch it with its own unguarded client. They are re-encoded by toPreviewJpeg,
   * and Baileys derives the inline jpegThumbnail and the dimensions from that JPEG. Uploading it as a
   * 'thumbnail-link' is what Baileys' own preview generator does, and the uploaded
   * `highQualityThumbnail` is what WhatsApp renders as the large card.
   *
   * A refused host, a failed fetch, an oversized body or bytes that do not decode as an image throw:
   * swallowing them would hide a missing SSRF_ALLOWED_HOSTS entry behind a 200. Only a failed WhatsApp
   * upload sends the text without the image, with a warning in the log.
   */
  private async previewThumbnail(
    preview: CustomLinkPreview,
  ): Promise<{ jpegThumbnail?: Buffer; highQualityThumbnail?: BaileysLib.proto.Message.IImageMessage }> {
    let data: Buffer;
    if (preview.thumbnailBase64) {
      data = Buffer.from(preview.thumbnailBase64, 'base64');
    } else if (preview.thumbnailUrl) {
      ({ data } = await loadRemoteMediaBuffer(preview.thumbnailUrl, this.host.sessionProxyUrl(), {
        maxBytes: LINK_PREVIEW_THUMBNAIL_MAX_BYTES,
      }));
    } else {
      return {};
    }
    await assertReadableImage(data);
    const image = await toPreviewJpeg(data);
    const lib = await this.host.loadLib();
    try {
      const { imageMessage } = await lib.prepareWAMessageMedia(
        { image },
        {
          upload: this.sock().waUploadToServer,
          mediaTypeOverride: 'thumbnail-link',
          mediaUploadTimeoutMs: this.uploadTimeoutMs(),
        },
      );
      if (!imageMessage) return {};
      return {
        ...(imageMessage.jpegThumbnail ? { jpegThumbnail: Buffer.from(imageMessage.jpegThumbnail) } : {}),
        highQualityThumbnail: imageMessage,
      };
    } catch (error) {
      this.host.logger.warn('Link preview image upload failed; sending the preview without it', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    sendOptions?: { linkPreview?: boolean; customPreview?: CustomLinkPreview } & Quotable,
  ): Promise<MessageResult> {
    this.ensureReadyToSend();
    const jid = await this.toDeliverableJid(chatId);
    // Baileys spreads the caller's options LAST (messages-send.js:1086), so `getUrlInfo` here
    // replaces its hardcoded one — which delegates to a package carrying an unfixed SSRF advisory
    // (see safe-link-preview.ts). Passed on every text send so that generator is never reachable,
    // not only when a preview was asked for.
    const options = {
      ...(this.withEphemeral(jid) ?? {}),
      getUrlInfo: (text: string) => generateSafeLinkPreview(text, { sessionProxyUrl: this.host.sessionProxyUrl() }),
      // Merged rather than assigned: getUrlInfo above must survive, or the library's own vulnerable
      // preview generator becomes reachable again on quoted sends only.
      ...((await this.quoteOption(sendOptions?.quotedMessageId)) ?? {}),
    };
    // `linkPreview: null` is Baileys' explicit "no preview": with the key absent it instead calls the
    // configured generator (Utils/messages.js:279-281), which for us means a blocking outbound fetch
    // of every URL in the text (up to 3s each, no cache) before the message can go out.
    //
    // Previews are therefore OPT-IN on this engine: only `linkPreview: true` leaves the key absent.
    // That keeps the documented engine default ("Baileys builds none") true, and keeps a bulk
    // campaign whose template carries a slow or dead URL from stalling on every single message.
    // getUrlInfo above is still passed unconditionally, so the library's vulnerable generator stays
    // unreachable on the paths that do generate.
    //
    // Built by send() only once the recipient has passed its check, so a number that is not on WhatsApp
    // costs no preview image fetch, conversion or upload, and its 400 is not hidden behind an image error.
    const content = async () => ({
      text,
      ...this.withMentions(mentions),
      ...(sendOptions?.linkPreview === true ? {} : { linkPreview: null }),
      // A caller-supplied preview short-circuits generation entirely: with the key present Baileys
      // never calls getUrlInfo, so the page is not fetched and the metadata is used verbatim. Its
      // image, when one is given, is fetched and uploaded by previewThumbnail.
      ...(sendOptions?.customPreview
        ? {
            linkPreview: {
              'matched-text': sendOptions.customPreview.url,
              'canonical-url': sendOptions.customPreview.url,
              title: sendOptions.customPreview.title,
              ...(sendOptions.customPreview.description ? { description: sendOptions.customPreview.description } : {}),
              ...(await this.previewThumbnail(sendOptions.customPreview)),
            },
          }
        : {}),
    });
    const sent = await this.send(jid, content, options);
    if (sent) {
      void this.host.putStoredMessage(sent)?.catch(err =>
        this.host.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.host.recordMessage(sent, 'text');
      // Parity with the wwjs engine's message_create → message.sent (see emitOwnSendEcho).
      void this.emitOwnSendEcho(sent);
    }
    return {
      id: sent?.key?.id ?? '',
      timestamp: this.host.toUnixSeconds(sent?.messageTimestamp),
    };
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async getNumberId(number: string): Promise<string | null> {
    this.host.ensureReady();
    const results = await withQueryDeadline(
      this.sock().onWhatsApp(number),
      this.queryBudgetMs,
      'WhatsApp did not answer the number-check query in time',
    );
    // onWhatsApp has no else branch after `if (results)`, so it resolves undefined when the usync
    // query goes unanswered — and Baileys' query() swallows its own timeout rather than throwing.
    // An empty ARRAY is a real answer; undefined is the absence of one, and coalescing the two
    // turns "we never heard back" into "this number is not on WhatsApp", which the caller then
    // acts on. The two are distinguishable here, so they are distinguished.
    if (results === undefined) {
      throw new EngineTransportError('WhatsApp did not answer the number-check query');
    }
    const hit = results[0];
    // Baileys returns a raw `<phone>@s.whatsapp.net`; neutralize it before it crosses the engine
    // boundary so the value matches whatsapp-web.js (`<phone>@c.us`) and the IWhatsAppEngine contract
    // (no raw `@s.whatsapp.net` in a neutral field). It also round-trips back to a send on either engine.
    return hit?.exists ? this.host.toNeutralJid(hit.jid) : null;
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.host.ensureReady();
    const presence = state === 'typing' ? 'composing' : state === 'recording' ? 'recording' : 'paused';
    try {
      await this.sock().sendPresenceUpdate(presence, await this.toDeliverableJid(chatId));
    } catch (error) {
      // Presence is best-effort — a failure here must never surface as a 500 on the direct typing
      // endpoint or MCP tool (mirrors the whatsapp-web.js adapter; #583 R4). A migrated contact can
      // yield `No LID for user` on the presence path even when the actual send succeeds.
      this.host.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, {
        error: String(error),
      });
    }
  }

  /**
   * Publish the account's own GLOBAL presence — the no-jid form of sendPresenceUpdate, which
   * addresses the whole account rather than a chat (`<presence>`, not a per-chat `<chatstate>`).
   * Not best-effort, unlike sendChatState: the caller asked for a specific visibility, so a
   * failure surfaces instead of leaving the account silently online (#871).
   *
   * Baileys resolves this call without sending anything when `creds.me.name` is unset (it logs
   * "no name present, ignoring presence update request" and returns). It reads the live credentials,
   * so this does too: `sock.user` is a copy of creds.me made when the socket was built, and a newly
   * linked account's name syncs after that. Refusing here keeps PUT /presence from reporting success
   * for an update that never left.
   */
  async setOnlinePresence(available: boolean): Promise<void> {
    this.host.ensureReady();
    if (!this.sock().authState?.creds?.me?.name) {
      throw new EngineNotReadyError(
        'The account push name is not available yet, so this presence update would be ignored. Retry once the session has synced its profile name.',
      );
    }
    await this.sock().sendPresenceUpdate(available ? 'available' : 'unavailable');
  }

  /**
   * Subscribe to a chat's presence. Unlike sendChatState this is NOT best-effort: the caller asked
   * for a subscription, and silently swallowing a failure would leave them waiting for updates that
   * can never arrive. A failure surfaces so the caller can retry or stop expecting them.
   */
  async subscribeToPresence(chatId: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().presenceSubscribe(await this.toDeliverableJid(chatId));
  }

  /**
   * Send a native product card (#905). Baileys has no catalog-lookup-then-send helper, so the
   * adapter resolves the Product first; here it becomes a {product} message whose snapshot is
   * priced in thousandths (priceAmount1000) and whose image is handed to Baileys as a URL upload.
   * The card needs an image — a product whose catalog entry has none cannot be sent this way.
   */
  async sendProductMessage(chatId: string, product: Product, body?: string): Promise<MessageResult> {
    this.host.ensureReady();
    if (!product.imageUrl) {
      throw new BadRequestException(`Product ${product.id} has no image — a product card requires one`);
    }
    const content: AnyMessageContent = {
      product: {
        productId: product.id,
        title: product.name,
        description: product.description,
        currencyCode: product.currency,
        priceAmount1000: product.price === undefined ? undefined : Math.round(product.price * 1000),
        retailerId: product.retailerId,
        url: product.url || undefined,
        productImage: { url: product.imageUrl },
      },
      businessOwnerJid: this.host.toEngineJid(this.host.normalizedSelfJid()),
      body,
    };
    return this.sendContent(chatId, content);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), 'image/jpeg');
    return this.sendContent(
      chatId,
      {
        image: data,
        caption: media.caption,
        mimetype,
        ...this.withMentions(media.mentions),
      },
      await this.quoteOption(media.quotedMessageId),
    );
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), 'video/mp4');
    return this.sendContent(
      chatId,
      {
        video: data,
        caption: media.caption,
        mimetype,
        ...this.withMentions(media.mentions),
      },
      await this.quoteOption(media.quotedMessageId),
    );
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), 'audio/mpeg');
    const ptt = media.ptt ?? false;
    return this.sendContent(
      chatId,
      // Audio carries no caption, so a mention here tags the recipient through contextInfo without
      // visible @text. It is still forwarded: the route accepts `mentions` (SendAudioMessageDto
      // extends SendMediaMessageDto) and whatsapp-web.js sends it, so dropping it here made the same
      // request notify participants on one engine and silently not on the other.
      // The duration and a voice note's waveform come from describeAudio, never from Baileys, which
      // would read the file in this process.
      { audio: data, mimetype, ptt, ...(await describeAudio(data, ptt)), ...this.withMentions(media.mentions) },
      await this.quoteOption(media.quotedMessageId),
    );
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), 'application/octet-stream');
    return this.sendContent(
      chatId,
      {
        document: data,
        mimetype,
        fileName: media.filename ?? 'file',
        caption: media.caption,
        ...this.withMentions(media.mentions),
      },
      await this.quoteOption(media.quotedMessageId),
    );
  }

  async createCallLink(type: CallLinkType, startTime: number): Promise<string> {
    this.host.ensureReady();
    const lib = await this.host.loadLib();
    // The socket resolves only the bare `token` attribute of the `link_create` node; the finished
    // link is that token behind one of the library's two exported prefixes. Note the audio prefix
    // WhatsApp itself uses is `/voice/`, which is also what whatsapp-web.js calls the same thing.
    //
    // No timeoutMs is passed: without it the library's wait resolves nothing after its own 60 s, which
    // would read as "no link". The wrap below is the deadline, but its 503 is rethrown as a 500:
    // minting is non-idempotent and the deadline does not cancel the query, so a client replaying a
    // 503 could create a second link. Same rule as createGroup and the whatsapp-web.js call link.
    let token: string | undefined;
    try {
      token = await this.confirmed(
        this.sock().createCallLink(type, { startTime: Math.floor(startTime / 1000) }),
        'the call link',
      );
    } catch (err) {
      throw err instanceof EngineTransportError ? new Error(err.message) : err;
    }
    if (!token) {
      // A prefix with nothing after it is a dead link that looks like a real one — the caller would
      // hand it to a user and only find out then.
      throw new EngineRefusedError('WhatsApp did not return a call link');
    }
    return `${type === 'video' ? lib.CALL_VIDEO_PREFIX : lib.CALL_AUDIO_PREFIX}${token}`;
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl());
    // A sticker has neither text nor caption, but stickerMessage carries a contextInfo like every
    // other content type, so a mention still tags the participant. The route accepts the field
    // (send-sticker shares SendMediaMessageDto) and docs/06 lists it among the media sends that
    // take one, so dropping it here left a documented capability doing nothing.
    return this.sendContent(
      chatId,
      { sticker: await toWebpSticker(data, mimetype), ...this.withMentions(media.mentions) },
      await this.quoteOption(media.quotedMessageId),
    );
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    return this.sendContent(
      chatId,
      {
        location: {
          degreesLatitude: location.latitude,
          degreesLongitude: location.longitude,
          name: location.description,
          address: location.address,
        },
      },
      await this.quoteOption(location.quotedMessageId),
    );
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReadyToSend();
    return this.sendContent(
      chatId,
      {
        contacts: { displayName: contact.name, contacts: [{ vcard: buildVCard(contact) }] },
      },
      await this.quoteOption(contact.quotedMessageId),
    );
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.ensureReadyToSend();
    // selectableCount 1 = single choice; 0 = no limit, which is how WhatsApp expresses
    // "allow multiple answers". Baileys generates the poll's messageSecret itself.
    return this.sendContent(
      chatId,
      {
        poll: {
          name: poll.name,
          values: poll.options,
          selectableCount: poll.allowMultipleAnswers ? 0 : 1,
        },
      },
      await this.quoteOption(poll.quotedMessageId),
    );
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    this.ensureReadyToSend();
    const socket = this.sock();
    const quoted = await this.requireStored(quotedMsgId);
    // The one requireStored path that had no chat check. whatsapp-web.js resolves the quote by
    // fetching from the named chat and 404s when the id is not in it, so the same request replied
    // across conversations here and was refused there. The library encodes the foreign chat into
    // contextInfo rather than rejecting it (Utils/messages.js), so the adapter is the only guard.
    // NOT applied to quoteOption: cross-chat quoting on the send-* routes is deliberate and
    // published in docs/06.
    await this.assertStoredInChat(quoted, chatId, quotedMsgId, socket);
    return this.sendContent(chatId, { text, ...this.withMentions(mentions) }, { quoted }, socket);
  }

  /**
   * Send a structured button/list reply against a stored business prompt.
   *
   * Classic prompts (`buttonsMessage` / `templateMessage` / `listMessage`) go through Baileys'
   * `buttonReply` / `listReply` helpers via {@link sendContent}, so the send inherits
   * `withEphemeral`, the store put and the own-send echo. Native-flow `interactiveMessage` has no
   * helper; it uses the template `buttonReply` shape, which is unverified against a live business
   * native-flow prompt.
   */
  async clickButton(chatId: string, messageId: string, buttonId: string, text?: string): Promise<MessageResult> {
    this.host.ensureReady();
    const socket = this.sock();
    const quoted = await this.requireStored(messageId);
    await this.assertStoredInChat(quoted, chatId, messageId, socket);

    const b = await this.host.loadLib();
    const normalized = b.normalizeMessageContent(quoted.message ?? undefined) ?? quoted.message ?? {};
    const contentType = b.getContentType(normalized);
    const resolved = resolveBaileysButtonClick(normalized, contentType, buttonId, text);
    if (!resolved.ok) {
      if (resolved.error === 'unknown_button') {
        throw new BadRequestException(
          `buttonId "${buttonId}" is not among the clickable choices on message ${messageId}`,
        );
      }
      throw new BadRequestException(
        `message ${messageId} is not a WhatsApp Business button/list prompt that can be clicked`,
      );
    }

    const result = await this.sendContent(chatId, resolved.payload.content as AnyMessageContent, { quoted }, socket);
    return { ...result, body: resolved.payload.text };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReadyToSend();
    const socket = this.sock();
    const forward = await this.requireStored(messageId);
    // fromChatId was accepted and then ignored, so a message id from ANY chat forwarded successfully
    // while whatsapp-web.js answered 404 for the same request (it fetches from the named chat and
    // fails when the id is not in it). Same check the star and react paths already apply.
    await this.assertStoredInChat(forward, fromChatId, messageId, socket);
    return this.sendContent(toChatId, { forward }, undefined, socket);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.host.ensureReady();
    const socket = this.sock();
    const target = await this.requireStored(messageId);
    await this.assertStoredInChat(target, chatId, messageId, socket);
    // Resolved like any other send: a lid-migrated contact rejects PN-addressed sends (ack 463).
    await this.send(
      await this.toDeliverableJid(chatId, socket),
      { react: { text: emoji, key: target.key } },
      undefined,
      socket,
    );
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    this.host.ensureReady();
    const socket = this.sock();
    // A message already deleted for everyone can still be deleted for me: that clears its placeholder.
    const target = await this.requireStored(messageId, true);
    await this.assertStoredInChat(target, chatId, messageId, socket);
    // Only the sender, or a group admin, can delete a message for everyone. WhatsApp ignores any other
    // revoke, yet the send resolves, so it would report a deletion that never happened. WhatsApp Web
    // deletes such a message for the account alone instead, and so does this. A group whose member
    // list shows no row for the account proves nothing either way, so the revoke still goes out there.
    // Whichever branch runs, the text leaves this account's view, so clear the preview immediately.
    const chatJid = target.key.remoteJid ?? chatId;
    // The preview of a received broadcast-list message is kept in its sender's chat.
    const previewJid = baileysChatJid(chatJid, target.key.participant, target.key.fromMe === true);
    if (
      forEveryone &&
      (target.key.fromMe === true || (await this.selfIsGroupAdmin(target.key.remoteJid, socket)) !== false)
    ) {
      await this.send(await this.toDeliverableJid(chatId, socket), { delete: target.key }, undefined, socket);
      this.host.recordMessageEdit(previewJid, messageId, '', 'revoked');
      // Clear the stored copy before the buffered echo arrives. Record the deletion first so it
      // survives a failed store write or a repeat delivery of the original.
      this.host.markDeletedForEveryone(messageId);
      await this.changeStored(messageId, stored => ({ ...stored, message: null }));
      return;
    }
    // Delete-for-me (revoke on this device only): Baileys exposes it as a chat modification, not a
    // sendMessage. The stored message timestamp (epoch seconds) is part of the payload.
    await this.confirmed(
      this.sock(socket).chatModify(
        {
          deleteForMe: {
            deleteMedia: true,
            key: target.key,
            timestamp: this.host.toUnixSeconds(target.messageTimestamp),
          },
        },
        // Indexed by the chat the message is stored in: for a lid-keyed chat that is its lid, which the
        // @c.us id the listing publishes does not fold to.
        this.host.toEngineJid(chatJid),
      ),
      'the delete-for-me',
    );
    this.host.recordMessageEdit(previewJid, messageId, '', 'revoked');
  }

  /**
   * Whether the account is an admin of this chat: false for anything that is not a group, and
   * undefined when no participant row can be identified as the account.
   */
  private async selfIsGroupAdmin(jid: string | null | undefined, socket?: WASocket): Promise<boolean | undefined> {
    if (!jid?.endsWith('@g.us')) return false;
    const metadata = await withQueryDeadline(
      this.sock(socket).groupMetadata(jid),
      this.queryBudgetMs,
      'WhatsApp did not answer the group metadata query in time',
    );
    if (socket) this.sock(socket);
    const self = findSelfParticipant(metadata, this.host.normalizedSelfJid(), id => this.host.toNeutralJid(id));
    return self === undefined ? undefined : self.admin === 'admin' || self.admin === 'superadmin';
  }

  async editMessage(chatId: string, messageId: string, body: string, mentions?: string[]): Promise<MessageResult> {
    this.host.ensureReady();
    const socket = this.sock();
    const target = await this.requireStored(messageId);
    // The chat check comes first so a message from another chat answers not-found whichever side
    // sent it; checking fromMe first would tell an inbound message there from an own one.
    await this.assertStoredInChat(target, chatId, messageId, socket);
    // Only the account's own messages are editable: WhatsApp refuses the edit of an inbound message
    // but the send would still resolve, dressing the refusal up as success (and the service layer
    // would then "update" the stored body). Refuse first — mirrors the wwjs null-edit guard.
    if (target.key.fromMe !== true) {
      throw new EngineRefusedError(
        `the edit of message ${messageId} was rejected — only the account's own messages can be edited`,
      );
    }
    // An edit keeps the original message id, so it is neither re-persisted nor echoed as a new send.
    // The destination is resolved like any other send: a lid-migrated contact rejects PN-addressed
    // sends with ack error 463 (see toDeliverableJid).
    const jid = await this.toDeliverableJid(chatId, socket);
    // Same guard as sendContent: an edit carries text, so without it the library would fetch
    // every URL in the new body through its own vulnerable generator.
    // Tags are applied to the inner message's contextInfo BEFORE the library wraps it in the
    // protocolMessage edit envelope, so an edit can re-tag participants. An edit REPLACES the
    // content, so omitting mentions drops whatever tags the original carried.
    const editContent = { text: body, ...this.withMentions(mentions), edit: target.key };
    const b = await this.host.loadLib();
    await this.send(jid, this.previewSafe(editContent), this.previewSafeOptions(editContent), socket);
    // Update the preview and raw copy immediately, ahead of the buffered echo.
    this.host.recordMessageEdit(target.key.remoteJid ?? chatId, messageId, body);
    // A later quote must carry the updated text even before the edit's echo arrives.
    await this.changeStored(messageId, stored => {
      const content = b.normalizeMessageContent(stored.message ?? undefined);
      return content && setBaileysText(content, body) ? stored : null;
    });
    // Both fields describe the EDITED MESSAGE, not the protocol envelope that carried the edit.
    // That envelope has an id and a send time of its own; answering with either would name something
    // no route can address and no stored row is keyed by, and would disagree with the
    // whatsapp-web.js engine, which re-reads the message and reports the original of both. An edit
    // does not move a message in the chat, so its timestamp is still the one it was sent at.
    return { id: messageId, timestamp: this.host.toUnixSeconds(target.messageTimestamp) };
  }

  /**
   * Build the `{ mentions }` slice of a Baileys message content, de-normalizing neutral `@c.us` WIDs to
   * the engine dialect. Returns an empty object when none are given so the content is byte-identical to
   * the pre-#530 send (no stray `mentions` key). The text must still contain the `@<number>` token for
   * WhatsApp to render the tag — that is the caller's responsibility.
   */
  private withMentions(mentions?: string[]): { mentions?: string[] } {
    return mentions?.length ? { mentions: toEngineParticipants(mentions, jid => this.host.toEngineJid(jid)) } : {};
  }

  /**
   * Resolve a 1:1 phone-dialect chat id (`@c.us` / `@s.whatsapp.net`) to the contact's `@lid` when the
   * mapping is known. WhatsApp rejects PN-addressed 1:1 sends to LID-migrated accounts with ack error
   * 463 ("missing tctoken" — the privacy token is stored and honored under the LID), while the very
   * same send addressed to the LID delivers (verified live). Unmapped phone ids still need the
   * canonical Baileys domain; the library does not rewrite a neutral @c.us destination.
   */
  private async toDeliverableJid(chatId: string, expected?: WASocket): Promise<string> {
    if (expected) this.sock(expected);
    const { kind, userPart: user } = parseWaId(chatId);
    if (kind === 'lid') return `${user}@lid`;
    if (kind !== 'user') return chatId;
    const pn = this.host.toEngineJid(chatId);
    const sock = this.sock();
    try {
      const lid = await withQueryDeadline(
        Promise.resolve(sock.signalRepository?.lidMapping?.getLIDForPN(pn)),
        this.queryBudgetMs,
        'WhatsApp did not answer the recipient LID lookup in time',
      );
      if (this.host.getSocketOrNull() !== sock) throw markNothingSent(new EngineNotReadyError());
      // Record what the socket just told us. This resolution is the one place a cold contact's lid
      // becomes known before any message arrives, and without writing it back the session store
      // still believes the two ids are unrelated — which makes an ownership check comparing the
      // stored key's lid against a phone-dialect chatId reject a message that IS in that chat.
      if (lid) this.host.recordLidMapping(`${userPart(lid)}@lid`, pn, false);
      return lid ? `${userPart(lid)}@lid` : pn;
    } catch (error) {
      if (this.host.getSocketOrNull() !== sock || error instanceof EngineNotReadyError) {
        throw markNothingSent(new EngineNotReadyError());
      }
      if (error instanceof EngineTransportError) throw new EngineNotSentError(error.message);
      return pn; // LID resolution is best-effort; the phone destination must still be canonical.
    }
  }

  /**
   * Fold the chat's known disappearing-messages timer into Baileys' send options so outbound messages
   * honor the chat's ephemeral setting (#473). Returns `options` unchanged when no positive timer is
   * cached: omitting `ephemeralExpiration` reproduces today's behavior (Baileys' send guard is truthy),
   * so an unknown / boot-window / stale-empty cache never forces a message to disappear. Returning
   * `undefined` keeps the send a 2-arg call, identical to before. React/delete/status do not route
   * through here, so they are excluded by construction (reactions are NOT excluded by Baileys' guard).
   */
  private withEphemeral(
    chatId: string,
    options?: MiscMessageGenerationOptions,
  ): MiscMessageGenerationOptions | undefined {
    const ephemeralExpiration = this.host.getEphemeralExpiration(chatId);
    if (ephemeralExpiration === undefined) {
      return options;
    }
    return { ...options, ephemeralExpiration };
  }

  /** Send a Baileys content object and shape the result like the other sends. */
  /**
   * Keep the library's own preview generator unreachable, and keep it from firing at all.
   *
   * `generateWAMessageContent` calls the generator whenever the content carries `text` and no
   * explicit `linkPreview` (Utils/messages.js), and the default generator delegates to
   * `link-preview-js`, which carries an unfixed SSRF advisory. sendTextMessage guards both halves
   * itself; every OTHER text-bearing send goes through here, and used to guard neither, so a reply
   * or an edit containing a URL made the gateway fetch it through the vulnerable path.
   *
   * `linkPreview: null` is Baileys' explicit "no preview", which matches the documented engine
   * default. A caller that set one already keeps it.
   */
  private previewSafe(content: AnyMessageContent): AnyMessageContent {
    if (!('text' in content) || 'linkPreview' in content) return content;
    return { ...content, linkPreview: null };
  }

  /**
   * Options carrying the vetted generator, so the library's own is never selected. Added only for
   * text-bearing content: media sends never reach the generator, and leaving their options untouched
   * keeps the two-argument sendMessage call they already make.
   */
  private previewSafeOptions(content: AnyMessageContent, options?: MiscMessageGenerationOptions) {
    if (!('text' in content)) return options;
    return {
      ...(options ?? {}),
      getUrlInfo: (text: string) => generateSafeLinkPreview(text, { sessionProxyUrl: this.host.sessionProxyUrl() }),
    };
  }

  private async sendContent(
    chatId: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
    expected?: WASocket,
  ): Promise<MessageResult> {
    if (expected) this.sock(expected);
    const b = await this.host.loadLib();
    if (expected) this.sock(expected);
    const jid = await this.toDeliverableJid(chatId, expected);
    const safe = this.previewSafe(content);
    const merged = this.previewSafeOptions(safe, this.withEphemeral(jid, options));
    const sent = await this.send(jid, safe, merged, expected);
    if (sent) {
      void this.host.putStoredMessage(sent)?.catch(err =>
        this.host.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // Preview metadata must not turn a completed send into a retryable failure.
      let type: MessageType | undefined;
      try {
        if (sent.message) {
          const normalized = b.normalizeMessageContent(sent.message) ?? sent.message;
          type = mapBaileysMessageType(
            b.getContentType(normalized),
            normalized.audioMessage?.ptt === true,
            isBaileysCatalogShare(normalized),
          );
        }
      } catch (error) {
        this.host.logger.warn('Failed to classify sent message preview', { error: String(error) });
      }
      this.host.recordMessage(sent, type);
      // wwjs fires `message_create` for its own API sends, which SessionService turns into `message.sent`.
      // Baileys' own socket-sends echo back only as a `type:'append'` upsert, which handleMessagesUpsert
      // skips by the id send() recorded, so that event never fired for API sends. Emit the outbound
      // "created" callback here for parity: best-effort,
      // and off the response path. No media re-download: the API caller already holds the
      // payload and the REST send path persists it (wwjs, by contrast, does download it on its echo).
      void this.emitOwnSendEcho(sent);
    }
    return { id: sent?.key?.id ?? '', timestamp: this.host.toUnixSeconds(sent?.messageTimestamp) };
  }

  /**
   * Every send goes through here. Content message ids are recorded before the library echoes
   * them back. Baileys re-emits each own send through `messages.upsert` tagged `append`, the
   * same tag WhatsApp uses to replay what the account typed on its phone while the gateway was
   * down, and the id is the only thing that tells the two apart (see handleMessagesUpsert). The
   * record is synchronous on the send's own continuation, ahead of the library's buffered echo.
   *
   * A send that fails after a stop or logout has torn its socket down is not ready (409), the same as
   * one interrupted before it reached the socket; a failure on a socket still in place propagates. A swap
   * found before sock.sendMessage is called sent nothing, so that 409 carries markNothingSent, as does the 400
   * for a recipient WhatsApp reports unregistered. The send is not moved to the new socket: a logout followed
   * by a relink to another account looks the same.
   *
   * `content` may be a function, for content that costs work to build (a link preview image): it is
   * called after the recipient check, and its own errors are not send refusals.
   */
  private async send(
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1] | (() => Promise<Parameters<WASocket['sendMessage']>[1]>),
    options?: Parameters<WASocket['sendMessage']>[2],
    expected?: WASocket,
  ): Promise<WAMessage | undefined> {
    const sock = this.sock(expected);
    if (parseWaId(jid).kind === 'user') {
      let numberId: string | null;
      try {
        numberId = await this.getNumberId(jid);
      } catch (error) {
        if (this.host.getSocketOrNull() !== sock) throw markNothingSent(new EngineNotReadyError());
        throw new EngineNotSentError(`WhatsApp could not check the recipient before send: ${String(error)}`);
      }
      if (this.host.getSocketOrNull() !== sock) throw markNothingSent(new EngineNotReadyError());
      if (!numberId)
        throw markNothingSent(new BadRequestException(`WhatsApp reports recipient ${jid} is not registered`));
      const canonical = this.host.toEngineJid(numberId);
      if (canonical !== jid) jid = await this.toDeliverableJid(numberId);
    }
    const message = typeof content === 'function' ? await content() : content;
    if (this.host.getSocketOrNull() !== sock) throw markNothingSent(new EngineNotReadyError());
    const mediaUploadTimeoutMs = this.uploadTimeoutMs();
    const sendOptions = mediaUploadTimeoutMs ? { ...options, mediaUploadTimeoutMs } : options;
    let sent: WAMessage | undefined;
    try {
      sent = sendOptions ? await sock.sendMessage(jid, message, sendOptions) : await sock.sendMessage(jid, message);
    } catch (error) {
      if (this.host.getSocketOrNull() !== sock) throw new EngineNotReadyError();
      throw mapSendRefusal(error);
    }
    // Mutations are announced by their library echo; no local callback replaces it.
    if (!('react' in message || 'delete' in message || 'edit' in message)) this.host.rememberOwnSend(sent?.key?.id);
    return sent;
  }

  /**
   * Emit the engine-neutral "message created" callback for a message this session just sent via the API,
   * so downstream `message.sent` webhook/WS/hook delivery matches the whatsapp-web.js engine. Best-effort:
   * a mapping failure must never fail the send that already succeeded.
   */
  private async emitOwnSendEcho(sent: WAMessage): Promise<void> {
    const onMessageCreate = this.host.getOnMessageCreate();
    if (!onMessageCreate) return;
    try {
      const b = await this.host.loadLib();
      if (!sent.message || !sent.key?.remoteJid) return;
      const normalizedRoot = b.normalizeMessageContent(sent.message) ?? sent.message;
      const contentType = b.getContentType(normalizedRoot);
      // protocol / reaction / empty own messages carry no neutral "sent" content.
      if (!contentType || contentType === 'protocolMessage' || contentType === 'reactionMessage') return;
      const neutral = await this.host.mapMessage(sent, contentType, { skipMediaDownload: true });
      onMessageCreate(neutral);
    } catch (err) {
      this.host.logger.warn('Failed to emit own-send echo', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Turn an optional quoted-message id into Baileys' `quoted` send option.
   *
   * Baileys quotes by full stored message, never by id, so an id has to be resolved first — and an
   * id we cannot resolve is a hard failure rather than a silent unquoted send: the caller asked for
   * a reply, and a plain message delivered under that name is the wrong result reported as success.
   */
  private async quoteOption(quotedMessageId?: string): Promise<MiscMessageGenerationOptions | undefined> {
    if (!quotedMessageId) return undefined;
    return { quoted: await this.requireStored(quotedMessageId) };
  }

  /**
   * Resolve a previously-seen message from the store, or throw a clear not-found error.
   *
   * A message deleted for everyone is kept with its content removed, and is not found here unless
   * `allowDeleted`: quoting it would hand WhatsApp the deleted content again (Baileys copies the
   * quoted message into the reply's contextInfo), and there is nothing left to forward, react to or
   * edit. A message the session knows was deleted is treated the same while its stored copy still
   * holds the content, as it can when the delete overtook the original's own store write. An edit
   * that overtook it the same way is applied to a copy, so a quote or forward carries the edited text.
   */
  private async requireStored(messageId: string, allowDeleted = false): Promise<WAMessage> {
    const found = await this.host.getStoredMessage(messageId);
    const deleted = !found?.message || this.host.wasDeletedForEveryone(messageId);
    if (!found?.key || (deleted && !allowDeleted)) {
      // Every caller looks the message up before it writes anything, so nothing was sent.
      throw markNothingSent(new MessageNotFoundError(messageId));
    }
    const edited = deleted ? undefined : this.host.pendingEditOf(messageId, found.key);
    if (edited === undefined) return found;
    const b = await this.host.loadLib();
    const copy = JSON.parse(JSON.stringify(found, b.BufferJSON.replacer), b.BufferJSON.reviver) as WAMessage;
    const content = b.normalizeMessageContent(copy.message ?? undefined);
    if (content) setBaileysText(content, edited);
    return copy;
  }

  /** Apply a change this session just made to the stored copy. Best-effort: the change already went out. */
  private async changeStored(messageId: string, change: (stored: WAMessage) => WAMessage | null): Promise<void> {
    try {
      await this.host.updateStoredMessage(messageId, change);
    } catch (err) {
      this.host.logger.warn('Failed to apply an edit or delete to the message store', {
        msgId: messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The stored key must belong to the requested chat — acting with another chat's key is a
   * not-found here, not a cross-chat write (a pin sent into chat A referencing chat B's message, or
   * a star indexed under the wrong conversation, would report success). Both sides are neutralized
   * so @c.us/@s.whatsapp.net (and a known lid<->pn twin) compare equal, and a received broadcast-list
   * message is found under the sender chat it is reported in. Every caller checks before it writes, so
   * the not-found carries markNothingSent (the lid query it may run writes no message).
   */
  private async assertStoredInChat(
    target: WAMessage,
    chatId: string,
    messageId: string,
    socket: WASocket,
  ): Promise<void> {
    this.sock(socket);
    const persisted = await storedKeyInChatPersisted(
      target.key,
      chatId,
      this.host.findPersistedLidPhone?.bind(this.host),
    );
    this.sock(socket);
    if (persisted) return;
    const requested = parseWaId(chatId);
    const stored = parseWaId(
      baileysChatJid(target.key.remoteJid ?? '', target.key.participant, target.key.fromMe === true),
    );
    if ((requested.kind === 'user' && stored.kind === 'lid') || (requested.kind === 'lid' && stored.kind === 'user')) {
      const phone = requested.kind === 'user' ? requested.userPart : stored.userPart;
      const lid = requested.kind === 'lid' ? requested.userPart : stored.userPart;
      if (typeof socket.executeUSyncQuery === 'function') {
        const library = await this.host.loadLib();
        if (this.host.getSocketOrNull() !== socket) throw markNothingSent(new EngineNotReadyError());
        const confirmed = await queryLidPhone(socket, library, phone, lid, this.queryBudgetMs);
        if (this.host.getSocketOrNull() !== socket) throw markNothingSent(new EngineNotReadyError());
        if (confirmed) {
          this.host.recordLidMapping(`${lid}@lid`, `${phone}@s.whatsapp.net`);
          return;
        }
      }
    }
    throw markNothingSent(new MessageNotFoundError(messageId, chatId));
  }

  async starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    this.host.ensureReady();
    const socket = this.sock();
    const target = await this.requireStored(messageId);
    await this.assertStoredInChat(target, chatId, messageId, socket);
    // fromMe is load-bearing: the same message id addresses a different message depending on
    // direction, so omitting it would star the wrong side of the conversation.
    // chatModify keys the star app-state index by the raw jid (no jidNormalizedUser, unlike the send
    // path), so it takes the chat the message is stored in, folded to the engine form: a neutral @c.us,
    // or the phone jid of a chat keyed by the contact's lid, would index a phantom chat and the star
    // would silently apply to nothing.
    await this.confirmed(
      this.sock(socket).chatModify(
        { star: { messages: [{ id: target.key.id!, fromMe: target.key.fromMe ?? false }], star } },
        this.host.toEngineJid(target.key.remoteJid ?? chatId),
      ),
      'the star change',
    );
  }

  /**
   * Pin/unpin a message IN THE CHAT. Deliberately not `chatModify({pin})` — that pins the chat
   * itself in the chat list, a different feature that happens to share the word.
   */
  async pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void> {
    this.host.ensureReady();
    const socket = this.sock();
    const target = await this.requireStored(messageId);
    await this.assertStoredInChat(target, chatId, messageId, socket);
    // Read the enum through the LAZY loader rather than a static import. @whiskeysockets/baileys is
    // pure ESM and every other site in this codebase defers it to first connect; a module-scope
    // require would drag ~590 modules into boot even for whatsapp-web.js-only processes.
    const { proto } = await this.host.loadLib();
    await this.send(
      await this.toDeliverableJid(chatId, socket),
      {
        pin: target.key,
        type: proto.PinInChat.Type.PIN_FOR_ALL,
        // WhatsApp recognises only these three windows; the DTO rejects anything else before we
        // get here, so the cast documents the contract rather than widening it.
        time: durationSeconds as 86400 | 604800 | 2592000,
      },
      undefined,
      socket,
    );
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    this.host.ensureReady();
    const socket = this.sock();
    const target = await this.requireStored(messageId);
    await this.assertStoredInChat(target, chatId, messageId, socket);
    const { proto } = await this.host.loadLib();
    // `time` is meaningless for an unpin and is omitted rather than sent as a dummy value.
    await this.send(
      await this.toDeliverableJid(chatId, socket),
      {
        pin: target.key,
        type: proto.PinInChat.Type.UNPIN_FOR_ALL,
      },
      undefined,
      socket,
    );
  }
}
