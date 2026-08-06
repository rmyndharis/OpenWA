import { MessageMedia, MessageTypes, type Client, type Message } from 'whatsapp-web.js';
import {
  CustomLinkPreview,
  IncomingMessage,
  LocationInput,
  ContactCard,
  DeliveryStatus,
  MediaInput,
  MessageReaction,
  MessageResult,
  PollInput,
} from '../interfaces/whatsapp-engine.interface';
import { MessageWithReactions, SerializedWid } from '../types/whatsapp-web-js.types';
import { BadRequestException } from '@nestjs/common';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { chatKind, userPart } from '../identity/wa-id';
import { chatHistoryMediaBudgetBytes, coerceDeclaredSize, ingestMediaBudgetBytes } from './inbound-media-cap';
import { buildIncomingMessageBase } from './message-mapper';
import { buildVCard } from './vcard';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { type WwebjsEngineHost } from './wwebjs-host';

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
export async function loadRemoteMedia(url: string): Promise<MessageMedia> {
  // Fetch through the SSRF-pinned path: it validates the host, pins the connection to the vetted IP
  // (so a DNS rebind can't redirect it to an internal target between check and connect), caps bytes,
  // and refuses redirects. We then build the MessageMedia from the returned bytes — NOT via
  // MessageMedia.fromUrl, whose bundled node-fetch performs its own unpinned DNS re-resolution.
  const { data, mimetype } = await loadRemoteMediaBuffer(url);
  const filename = new URL(url).pathname.split('/').pop() || undefined;
  return new MessageMedia(mimetype || 'application/octet-stream', data.toString('base64'), filename);
}

/**
 * True when a send error is whatsapp-web.js's "recipient needs a LID we don't have" failure, raised
 * when sending to a `@c.us` for a contact WhatsApp has migrated to `@lid`.
 * Matched on the wwjs error text — there is no structured code; revisit if wwjs changes it.
 */
export function isNoLidForUserError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No LID for user');
}

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
export async function toMessageMedia(media: MediaInput, opts?: { trustDeclaredType?: boolean }): Promise<MessageMedia> {
  if (typeof media.data === 'string' && isHttpUrl(media.data)) {
    const fetched = await loadRemoteMedia(media.data);
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
    const fetchedTypeIsGeneric = !fetchedType || fetchedType === 'application/octet-stream';
    const declaredTypeIsConvertible = declaredType.startsWith('image/') || declaredType.startsWith('video/');
    if (opts?.trustDeclaredType === false && fetchedTypeIsGeneric && declaredTypeIsConvertible) {
      fetched.mimetype = declaredType;
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
 * opposite outcomes into that one value (`Client.js:1558`): the chat could not be resolved so nothing
 * was sent (`if (!chat) return null`, `Client.js:1539`), or the message went out and only its id could
 * not be read back (`Msg.get` miss, `Injected/Utils.js:585`). Nothing here can tell those apart, so an
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
  return { id: id?._serialized ?? id?.$1 ?? '', timestamp: msg.timestamp };
}

/**
 * Messaging operations extracted from WhatsAppWebJsAdapter: the send paths (with the @c.us -> @lid
 * resolution cache), reactions, history, delete and edit. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly.
 */
export class WwebjsMessaging {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  // Cache of resolved individual recipients: `<phone>@c.us` -> the id `sendMessage` accepts (a
  // `<lid>@lid` for a migrated contact, or the confirmed `@c.us` for a non-migrated one). `getNumberId`
  // is a rate-limited WhatsApp Web existence probe that also throws intermittently, so caching every
  // confirmed resolution keeps ordinary sends from re-probing on each message (#580). A `@lid` is
  // stable; a stale entry (a contact that migrates mid-session) self-heals via the retry in
  // `sendResolved`.
  // Unbounded Map, bounded in practice by distinct recipients per session; add an LRU only if a
  // session ever addresses a truly unbounded set of fresh numbers.
  private readonly resolvedSendIds = new Map<string, string>();

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
    if (!chatId.endsWith('@c.us')) {
      return chatId;
    }
    const cached = this.resolvedSendIds.get(chatId);
    if (cached) {
      return cached;
    }
    try {
      const wid = await this.host.getNumberId(chatId);
      if (wid) {
        this.resolvedSendIds.set(chatId, wid);
        if (wid.endsWith('@lid')) {
          // Persist the learned phone -> lid so the message read-path (resolveJidCandidates) can
          // bridge this contact's `@c.us` and `@lid` rows on a pure whatsapp-web.js deployment
          // (#583 R3). Fire-and-forget: resolution (and the send) must never block/fail on the write.
          void this.host.config.lidMappingStore
            ?.remember(userPart(wid), userPart(chatId), this.host.config.sessionId)
            ?.catch(() => {});
        }
        return wid;
      }
      return chatId;
    } catch {
      return chatId;
    }
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
   */
  private async sendResolved<T>(chatId: string, send: (to: string) => Promise<T>): Promise<T> {
    const to = await this.resolveSendId(chatId);
    try {
      return await send(to);
    } catch (err) {
      // A transport-level failure means the page/browser is gone — report it as a death signal.
      // No-op for ordinary send errors; the retry/throw behavior below is unchanged.
      this.host.reportIfPageTransportError(err, 'sendMessage');
      if (!chatId.endsWith('@c.us') || !isNoLidForUserError(err)) {
        throw err;
      }
      this.resolvedSendIds.delete(chatId);
      const fresh = await this.resolveSendId(chatId);
      if (fresh === to) {
        throw new RecipientUnreachableError(chatId);
      }
      // The first send threw, but wwjs can throw after the message is already on the wire — so this
      // retry may produce a duplicate. Log it: without this the second copy is invisible.
      this.host.logger.warn('Send retried against a re-resolved id after "No LID for user"; may duplicate', {
        chatId,
        staleId: to,
        freshId: fresh,
      });
      try {
        return await send(fresh);
      } catch (retryErr) {
        // The re-resolved id is no better than the stale one — same unreachable recipient, and the
        // raw error would 500 exactly as the first one did.
        if (isNoLidForUserError(retryErr)) {
          throw new RecipientUnreachableError(chatId);
        }
        throw retryErr;
      }
    }
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    options?: { linkPreview?: boolean; customPreview?: CustomLinkPreview },
  ): Promise<MessageResult> {
    this.host.ensureReady();
    // wwebjs accepts neutral `<phone>@c.us` WIDs directly as mentionedJidList, so no de-normalization
    // is needed. Omit the options object entirely when none are given to keep today's send behavior.
    //
    // Only an explicit `false` is forwarded. whatsapp-web.js reads the flag as
    // `linkPreview === false ? undefined : true` (Client.js:1458), so passing `true` is identical to
    // passing nothing — sending it anyway would add an options object to every plain send for no
    // change in behaviour.
    // whatsapp-web.js takes a BOOLEAN only (index.d.ts:1547) — there is no way to hand it title,
    // description or a thumbnail. Silently dropping the caller's preview would send a message that
    // looks nothing like what they asked for, so it refuses instead.
    if (options?.customPreview) {
      throw new EngineNotSupportedError('sendTextMessage(customPreview)');
    }
    const sendOptions: { mentions?: string[]; linkPreview?: boolean } = {};
    if (mentions?.length) sendOptions.mentions = mentions;
    if (options?.linkPreview === false) sendOptions.linkPreview = false;

    const msg = await this.sendResolved(chatId, to =>
      Object.keys(sendOptions).length
        ? this.client().sendMessage(to, text, sendOptions)
        : this.client().sendMessage(to, text),
    );
    return toMessageResult(msg);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, media.ptt ? { sendAudioAsVoice: true } : undefined);
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
  ): Promise<MessageResult> {
    this.host.ensureReady();
    this.host.ensureNotChannelRecipient(chatId);

    // Build the media once (a remote URL is fetched here); sendResolved may retry the send itself.
    const messageMedia = await toMessageMedia(media);
    // A nameless document reaches WA Web as `new File([blob], undefined)` and is labelled literally
    // "undefined". Only documents render a filename, so default just this path — as Baileys does.
    if (extraOptions?.sendMediaAsDocument && !messageMedia.filename) {
      messageMedia.filename = 'file';
    }
    const msg = await this.sendResolved(chatId, to =>
      this.client().sendMessage(to, messageMedia, {
        caption: media.caption,
        ...(media.mentions?.length ? { mentions: media.mentions } : {}),
        // sendAudioAsVoice only for audio, sendMediaAsDocument only for documents;
        // {...undefined} contributes no keys.
        ...extraOptions,
      }),
    );

    return toMessageResult(msg);
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.host.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const module = await import('whatsapp-web.js');
    const Location = module.Location || module.default?.Location;

    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.sendResolved(chatId, to => this.client().sendMessage(to, loc));
    return toMessageResult(msg);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.host.ensureReady();
    // Shared builder sanitizes name/number (strips CR/LF, digits-only waid) so a crafted contact
    // can't inject extra vCard fields — the previous inline build interpolated raw values.
    const vcard = buildVCard(contact);

    const msg = await this.sendResolved(chatId, to =>
      this.client().sendMessage(to, vcard, {
        parseVCards: true,
      }),
    );
    return toMessageResult(msg);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
    // Sticker has its own send path (sendMediaAsSticker), not the sendMediaMessage funnel, but it
    // hits the same channel crash: for a channel wwjs drops the sticker form and runs processMediaData
    // with sendToChannel, which still ends at msg.avParams() (Utils.js:518). Guard it too (#673).
    this.host.ensureNotChannelRecipient(chatId);
    // Keep the fetched content-type for a remote URL: here the mimetype selects the conversion, and
    // whatsapp-web.js returns the media unconverted once it reads as webp (Util.formatImageToWebpSticker).
    const messageMedia = await toMessageMedia(media, { trustDeclaredType: false });

    const msg = await this.sendResolved(chatId, to =>
      this.client().sendMessage(to, messageMedia, {
        sendMediaAsSticker: true,
      }),
    );
    return toMessageResult(msg);
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.host.ensureReady();
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
    const msg = await this.sendResolved(chatId, to =>
      this.client().sendMessage(to, new Poll(poll.name, poll.options, pollOptions)),
    );
    return toMessageResult(msg);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.host.ensureReady();
    try {
      // Find the message to quote
      const chat = await this.client().getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

      if (!quotedMsg) {
        throw new MessageNotFoundError(quotedMsgId);
      }

      // Reply's send leg hits the same `No LID for user` path as a normal send for a migrated contact,
      // so route it through sendResolved (resolve @c.us->@lid, cache, self-heal). reply(content, chatId)
      // accepts an explicit target (#583 R1).
      const msg = await this.sendResolved(chatId, to => quotedMsg.reply(text, to));
      return toMessageResult(msg);
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'replyToMessage');
      throw error;
    }
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.host.ensureReady();
    try {
      const chat = await this.client().getChatById(fromChatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      const msgToForward = messages.find(m => m.id._serialized === messageId);

      if (!msgToForward) {
        throw new MessageNotFoundError(messageId);
      }

      // The forward's send leg fails with `No LID for user` for a LID-migrated destination, so resolve
      // it (and self-heal a stale mapping) via sendResolved. Capture the id actually sent to so the
      // id-recovery below reads back from the SAME (resolved) chat, not the raw @c.us (#583 R1).
      let resolvedTo = toChatId;
      await this.sendResolved(toChatId, to => {
        resolvedTo = to;
        return msgToForward.forward(to);
      });

      // whatsapp-web.js's forward() returns void, so BEST-EFFORT recover the REAL id of the sent copy by
      // reading it back from the destination chat (the most recent outgoing message). The delivery-ack
      // matcher keys on this id, so a synthetic one would leave the forward stuck at SENT; Baileys already
      // returns the real id. The forward already succeeded here, so recovery must NEVER fail the operation.
      // When the copy can't be identified we return an explicit-unknown id (empty): message.service then
      // leaves the row's waMessageId unset so no ack can mis-match it — unlike a synthetic or source id,
      // which could cross-drive another row's delivery status. Concurrent forwards to the same chat may
      // mis-identify the copy — acceptable for delivery-status accuracy.
      try {
        const destChat = await this.client().getChatById(resolvedTo);
        const sentByMe = (await destChat?.fetchMessages({ limit: 5, fromMe: true })) ?? [];
        let sent: (typeof sentByMe)[number] | undefined;
        for (const m of sentByMe) {
          if (!sent || m.timestamp > sent.timestamp) {
            sent = m;
          }
        }
        if (sent) {
          return toMessageResult(sent);
        }
      } catch (error) {
        // Still surface a dead page even though the send itself succeeded (detection only; the
        // forward's best-effort recovery contract is unchanged).
        this.host.reportIfPageTransportError(error, 'forwardMessage');
        this.host.logger.warn(`Forward succeeded but recovering the sent message id failed: ${String(error)}`);
      }
      return { id: '', timestamp: Math.floor(Date.now() / 1000) };
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'forwardMessage');
      throw error;
    }
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.host.ensureReady();
    try {
      // NOTE: do NOT resolve chatId to @lid here — whatsapp-web.js reacts using the found message's own
      // id, not this chatId, so LID-resolving the lookup gives no send benefit and would miss a message
      // stored under the pre-migration @c.us chat (#583 R1 review).
      const chat = await this.client().getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      const message = messages.find(m => m.id._serialized === messageId);
      if (!message) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      await (message as MessageWithReactions).react(emoji);
      this.host.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'reactToMessage');
      throw error;
    }
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
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

  async getChatHistory(
    chatId: string,
    limit: number = 50,
    includeMedia: boolean = false,
    mediaMaxBytes?: number,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    const results: IncomingMessage[] = [];
    // Aggregate base64 budget across the whole pass: the per-message cap bounds ONE blob, but without
    // an aggregate bound a 100-message history could stack ~100 × 50 MiB into one response. Once the
    // running total crosses the budget, later media messages get the declared-only `omitted` marker —
    // no download — while everything already inlined stays inline (a small history is byte-identical
    // to before). `signal` (client disconnect) stops the loop between messages; partials are returned.
    // The 25 MiB default is sized for ONE HTTP response and is too tight for a caller that ingests
    // into a store instead (mediaMaxBytes — the status seed): two ~10 MiB videos are ~28 MiB of
    // base64 and would strip every later status. Such a caller gets a budget derived from its own
    // per-item cap rather than an exemption — unbounded here would mean a 50-item seed could stack
    // ~650 MiB of base64 on the heap at connect time.
    let mediaBudget = !includeMedia
      ? Number.POSITIVE_INFINITY
      : mediaMaxBytes === undefined
        ? chatHistoryMediaBudgetBytes()
        : ingestMediaBudgetBytes(mediaMaxBytes);
    for (const msg of messages) {
      if (signal?.aborted) {
        break;
      }
      // Reuse the shared mapper so history messages carry the same author/contact
      // enrichment as live incoming messages (#223). The mapper defaults chatId to
      // msg.from, which is wrong here (history includes fromMe messages whose `from`
      // is our own number), so override it to the requested chat and recompute the
      // chatId-derived flags (isGroup, isStatusBroadcast, kind) from the real chat.
      const out = buildIncomingMessageBase(msg);
      out.chatId = chatId;
      out.isGroup = chatId.endsWith('@g.us');
      out.isStatusBroadcast = chatId === 'status@broadcast';
      out.kind = chatKind(chatId);
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
          out.quotedMessage = { id: quoted.id._serialized, body: quoted.body };
        } catch (error) {
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
            this.host.logger.warn(`Failed to download media for ${msg.id._serialized}: ${String(error)}`);
          }
        }
      }
      results.push(out);
    }
    return results;
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.host.ensureReady();
    // NOTE: do NOT resolve chatId to @lid here — delete operates on the found message's own key, not
    // this chatId, so LID-resolving the lookup gives no benefit and would miss a message stored under
    // the pre-migration @c.us chat (#583 R1 review).
    const chat = await this.client().getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    await message.delete(forEveryone);
    this.host.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  async editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
    this.host.ensureReady();
    // Same lookup window as react/delete: fetchMessages sees only the 100 most recent messages.
    // NOTE: do NOT resolve chatId to @lid here — edit operates on the found message's own key, not
    // this chatId, so LID-resolving the lookup would miss a message stored under the pre-migration
    // @c.us chat (#583 R1 review).
    const chat = await this.client().getChatById(chatId);
    // getChatById RESOLVES undefined for an unknown chat (wwebjs does not throw) — that is the same
    // client-facing outcome as a message outside the fetch window, not a TypeError (-> 500).
    if (!chat) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    const edited = await message.edit(body);
    if (!edited) {
      // wwebjs RESOLVES null (instead of throwing) when the page-side edit is refused — only the
      // account's own text messages are editable; surface the refusal, not a phantom success.
      throw new EngineRefusedError(
        `the edit of message ${messageId} was rejected — only the account's own text messages can be edited`,
      );
    }
    this.host.logger.log(`Edited message ${messageId} in chat ${chatId}`);
    return toMessageResult(edited);
  }

  /**
   * Locate a message in the 100-message fetch window shared by react/delete/edit — and now pin.
   * Deliberately NOT applied to the existing call sites: they differ in whether they tolerate an
   * unknown chat, and rewriting them is not this change's business.
   *
   * As with those sites, chatId is NOT lid-resolved: the pin acts on the found message's own key,
   * so resolving would only risk missing a message stored under the pre-migration @c.us chat.
   */
  private async findInFetchWindow(chatId: string, messageId: string): Promise<Message> {
    const chat = await this.client().getChatById(chatId);
    // getChatById RESOLVES undefined for an unknown chat rather than throwing, which is the same
    // client-facing outcome as a message outside the window — a 404, not a TypeError-driven 500.
    if (!chat) throw new MessageNotFoundError(messageId, chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) throw new MessageNotFoundError(messageId, chatId);
    return message;
  }

  async votePoll(chatId: string, pollMessageId: string, options: string[]): Promise<void> {
    this.host.ensureReady();
    // Same 100-message window as pin/react/delete, so a poll older than that is unreachable and
    // reported as not-found rather than as a failed vote.
    const message = await this.findInFetchWindow(chatId, pollMessageId);
    try {
      await (message as unknown as { vote(selected: string[]): Promise<void> }).vote(options);
    } catch (error) {
      // vote() throws a BARE STRING (not an Error) when the target is not a poll creation message
      // (Message.js:1010). Left alone that surfaces as an opaque 500; it is a client mistake, so
      // map it to a 400. Anything that is a real Error is a genuine engine fault and propagates.
      if (typeof error === 'string') {
        throw new BadRequestException(`Message ${pollMessageId} is not a poll: ${error}`);
      }
      throw error;
    }
    this.host.logger.log(`Voted on poll ${pollMessageId} in chat ${chatId} (${options.length} option(s))`);
  }

  async pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void> {
    this.host.ensureReady();
    const message = await this.findInFetchWindow(chatId, messageId);
    // The page-side helper returns false rather than throwing for every refusal — a non-number
    // duration, a message it cannot resolve, or a send WhatsApp rejected (Injected/Utils.js:1670).
    // Surface that as a refusal instead of reporting a pin that never happened.
    if (!(await message.pin(durationSeconds))) {
      throw new EngineRefusedError(
        `the pin of message ${messageId} was rejected — in a group only admins may pin, and the duration must be 24h, 7d or 30d`,
      );
    }
    this.host.logger.log(`Pinned message ${messageId} in chat ${chatId} for ${durationSeconds}s`);
  }

  async starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    this.host.ensureReady();
    const message = await this.findInFetchWindow(chatId, messageId);
    // Both resolve void, and the page-side helper silently does nothing when canStarMsg() refuses
    // the message (Message.js:672-712). There is no signal to map, so a star that WhatsApp declined
    // is indistinguishable from one it accepted — documented rather than faked into a refusal.
    await (star ? message.star() : message.unstar());
    this.host.logger.log(`${star ? 'Starred' : 'Unstarred'} message ${messageId} in chat ${chatId}`);
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    this.host.ensureReady();
    const message = await this.findInFetchWindow(chatId, messageId);
    // unpin() passes duration 0 itself, so the injected non-number guard cannot bite here; a false
    // return means WhatsApp refused the unpin (e.g. not an admin).
    if (!(await message.unpin())) {
      throw new EngineRefusedError(`the unpin of message ${messageId} was rejected — in a group only admins may unpin`);
    }
    this.host.logger.log(`Unpinned message ${messageId} in chat ${chatId}`);
  }
}
