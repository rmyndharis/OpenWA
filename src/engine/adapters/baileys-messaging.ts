import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '@whiskeysockets/baileys';
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
  PollInput,
  Product,
  Quotable,
} from '../interfaces/whatsapp-engine.interface';
import { toEngineParticipants } from './baileys-groups';
import { buildVCard } from './vcard';
import { resolveBaileysButtonClick } from './baileys-message-mapper';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { type createLogger } from '../../common/services/logger.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';

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
  readonly logger: ReturnType<typeof createLogger>;
  toNeutralJid(jid: string): string;
  toEngineJid(jid: string): string;
  normalizedSelfJid(): string;
  /** The chat's cached disappearing-messages timer (#473), or undefined when none is known. */
  getEphemeralExpiration(chatId: string): number | undefined;
  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  toUnixSeconds(ts: number | string | { toNumber(): number } | null | undefined): number;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  loadLib(): Promise<typeof BaileysLib>;
  /** Persist a just-sent message to the store; undefined when no store is configured. */
  putStoredMessage(msg: WAMessage): Promise<void> | undefined;
  /** Record the id of a message this session just sent, so its library echo is recognised as ours. */
  rememberOwnSend(id: string | null | undefined): void;
  /** Look up a previously-seen message from the store (the reply/forward/react/delete handle). */
  getStoredMessage(messageId: string): Promise<WAMessage | null> | undefined;
  /** Remember a lid<->phone pair the socket resolved, so later reads do not have to ask again. */
  recordLidMapping(lid: string, pn: string): void;
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

async function toWebpSticker(data: Buffer, mimetype: string): Promise<Buffer> {
  if (isWebpBuffer(data)) {
    return data;
  }
  if (!mimetype.startsWith('image/')) {
    // Deliberately a 400 rather than EngineNotSupportedError: the capability IS supported, this
    // particular payload cannot become a sticker. A 501 would report the wrong thing and would also
    // make the row look unavailable to the parity gate's throw-scan.
    throw new BadRequestException(
      `A sticker must be a WebP image, or an image this gateway can convert to one. Received '${mimetype}'.`,
    );
  }
  // Imported lazily so an unusable `sharp` (a native binary that will not build or load on an older
  // CPU, a stripped image) degrades ONLY this one Baileys sticker route instead of killing the whole
  // gateway at boot. `sharp` sits at the top of a module the built-in engine loads unconditionally, so
  // an eager import made a single optional capability a hard boot requirement on both engines. Same
  // deferral the adapters already use for the engine libraries themselves.
  const sharp = await loadSharp();
  try {
    return await sharp(data, { animated: true })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp()
      .toBuffer();
  } catch (error) {
    // Bytes that do not decode as the image they claim to be. Refuse before the socket rather than
    // ship them mislabelled — that is the whole point.
    throw new BadRequestException(
      `The sticker image could not be converted to WebP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Resolve a MediaInput's data (Buffer | base64 string | http(s) URL) to bytes + mimetype.
 *
 * `sessionProxyUrl` is this session's egress proxy, which the URL fetch leaves through (#1626). It
 * is required, not optional, so a new call site cannot fetch direct on a proxied session by omission.
 */
export async function resolveMediaBuffer(
  media: MediaInput,
  sessionProxyUrl: string | undefined,
): Promise<{ data: Buffer; mimetype: string }> {
  if (Buffer.isBuffer(media.data)) {
    return { data: media.data, mimetype: media.mimetype };
  }
  if (/^https?:\/\//i.test(media.data)) {
    const fetched = await loadRemoteMediaBuffer(media.data, sessionProxyUrl);
    // A generic placeholder mimetype (buildMediaInput's 'application/octet-stream' default when the
    // caller supplied none) carries no real signal — defer to the fetched response content-type,
    // which was sniffed from the actual bytes. This fixes URL-based sends where the caller has no
    // mimetype to pass through the conversation-send facade (e.g. chatwoot-adapter outbound relay).
    const callerMimetype = media.mimetype && media.mimetype !== 'application/octet-stream' ? media.mimetype : null;
    return { data: fetched.data, mimetype: callerMimetype ?? fetched.mimetype };
  }
  return { data: Buffer.from(media.data, 'base64'), mimetype: media.mimetype };
}

export class BaileysMessaging {
  constructor(
    private readonly host: BaileysMessagingHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /** Bound a write whose confirmation the library discards; see baileys-query-deadline.ts. */
  private confirmed<T>(work: Promise<T>, operation: string): Promise<T> {
    return withQueryDeadline(work, this.queryBudgetMs, `WhatsApp did not confirm ${operation} in time`);
  }

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    sendOptions?: { linkPreview?: boolean; customPreview?: CustomLinkPreview } & Quotable,
  ): Promise<MessageResult> {
    this.host.ensureReady();
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
    const content = {
      text,
      ...this.withMentions(mentions),
      ...(sendOptions?.linkPreview === true ? {} : { linkPreview: null }),
      // A caller-supplied preview short-circuits generation entirely: with the key present Baileys
      // never calls getUrlInfo, so nothing is fetched and the metadata is used verbatim.
      ...(sendOptions?.customPreview
        ? {
            linkPreview: {
              'matched-text': sendOptions.customPreview.url,
              'canonical-url': sendOptions.customPreview.url,
              title: sendOptions.customPreview.title,
              ...(sendOptions.customPreview.description ? { description: sendOptions.customPreview.description } : {}),
            },
          }
        : {}),
    };
    const sent = await this.send(jid, content, options);
    if (sent) {
      void this.host.putStoredMessage(sent)?.catch(err =>
        this.host.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
    const results = await this.sock().onWhatsApp(number);
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
   * addresses the whole account rather than a chat. Not best-effort, unlike sendChatState: the
   * caller asked for a specific visibility, so a failure surfaces instead of leaving the account
   * silently online (#871). Resets on reconnect per the socket's markOnlineOnConnect option.
   */
  async setOnlinePresence(available: boolean): Promise<void> {
    this.host.ensureReady();
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
        priceAmount1000: Math.round(product.price * 1000),
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
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl());
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
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl());
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
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl());
    return this.sendContent(
      chatId,
      // Audio carries no caption, so a mention here tags the recipient through contextInfo without
      // visible @text. It is still forwarded: the route accepts `mentions` (SendAudioMessageDto
      // extends SendMediaMessageDto) and whatsapp-web.js sends it, so dropping it here made the same
      // request notify participants on one engine and silently not on the other.
      { audio: data, mimetype, ptt: media.ptt ?? false, ...this.withMentions(media.mentions) },
      await this.quoteOption(media.quotedMessageId),
    );
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl());
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
    // timeoutMs is passed so the library can retire its own pending query, and the call is ALSO
    // wrapped: baileys' query() swallows its timeout, so an unanswered request would otherwise
    // resolve to nothing and be indistinguishable from a refusal.
    const token = await this.confirmed(
      this.sock().createCallLink(type, { startTime: Math.floor(startTime / 1000) }, this.queryBudgetMs),
      'the call link',
    );
    if (!token) {
      // A prefix with nothing after it is a dead link that looks like a real one — the caller would
      // hand it to a user and only find out then.
      throw new EngineRefusedError('WhatsApp did not return a call link');
    }
    return `${type === 'video' ? lib.CALL_VIDEO_PREFIX : lib.CALL_AUDIO_PREFIX}${token}`;
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
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
    this.host.ensureReady();
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
    this.host.ensureReady();
    return this.sendContent(
      chatId,
      {
        contacts: { displayName: contact.name, contacts: [{ vcard: buildVCard(contact) }] },
      },
      await this.quoteOption(contact.quotedMessageId),
    );
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.host.ensureReady();
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
    this.host.ensureReady();
    const quoted = await this.requireStored(quotedMsgId);
    // The one requireStored path that had no chat check. whatsapp-web.js resolves the quote by
    // fetching from the named chat and 404s when the id is not in it, so the same request replied
    // across conversations here and was refused there. The library encodes the foreign chat into
    // contextInfo rather than rejecting it (Utils/messages.js), so the adapter is the only guard.
    // NOT applied to quoteOption: cross-chat quoting on the send-* routes is deliberate and
    // published in docs/06.
    this.assertStoredInChat(quoted, chatId, quotedMsgId);
    return this.sendContent(chatId, { text, ...this.withMentions(mentions) }, { quoted });
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
    const quoted = await this.requireStored(messageId);
    this.assertStoredInChat(quoted, chatId, messageId);

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

    const result = await this.sendContent(chatId, resolved.payload.content as AnyMessageContent, { quoted });
    return { ...result, body: resolved.payload.text };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.host.ensureReady();
    const forward = await this.requireStored(messageId);
    // fromChatId was accepted and then ignored, so a message id from ANY chat forwarded successfully
    // while whatsapp-web.js answered 404 for the same request (it fetches from the named chat and
    // fails when the id is not in it). Same check the star and react paths already apply.
    this.assertStoredInChat(forward, fromChatId, messageId);
    return this.sendContent(toChatId, { forward });
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    // Resolved like any other send: a lid-migrated contact rejects PN-addressed sends (ack 463).
    await this.send(await this.toDeliverableJid(chatId), { react: { text: emoji, key: target.key } });
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    if (forEveryone) {
      await this.send(await this.toDeliverableJid(chatId), { delete: target.key });
      return;
    }
    // Delete-for-me (revoke on this device only): Baileys exposes it as a chat modification, not a
    // sendMessage. The stored message timestamp (epoch seconds) is part of the payload.
    await this.confirmed(
      this.sock().chatModify(
        {
          deleteForMe: {
            deleteMedia: true,
            key: target.key,
            timestamp: this.host.toUnixSeconds(target.messageTimestamp),
          },
        },
        this.host.toEngineJid(chatId),
      ),
      'the delete-for-me',
    );
  }

  async editMessage(chatId: string, messageId: string, body: string, mentions?: string[]): Promise<MessageResult> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    // Only the account's own messages are editable: WhatsApp refuses the edit of an inbound message
    // but the send would still resolve, dressing the refusal up as success (and the service layer
    // would then "update" the stored body). Refuse first — mirrors the wwjs null-edit guard.
    if (target.key.fromMe !== true) {
      throw new EngineRefusedError(
        `the edit of message ${messageId} was rejected — only the account's own messages can be edited`,
      );
    }
    this.assertStoredInChat(target, chatId, messageId);
    // An edit keeps the original message id, so it is neither re-persisted nor echoed as a new send.
    // The destination is resolved like any other send: a lid-migrated contact rejects PN-addressed
    // sends with ack error 463 (see toDeliverableJid).
    const jid = await this.toDeliverableJid(chatId);
    // Same guard as sendContent: an edit carries text, so without it the library would fetch
    // every URL in the new body through its own vulnerable generator.
    // Tags are applied to the inner message's contextInfo BEFORE the library wraps it in the
    // protocolMessage edit envelope, so an edit can re-tag participants. An edit REPLACES the
    // content, so omitting mentions drops whatever tags the original carried.
    const editContent = { text: body, ...this.withMentions(mentions), edit: target.key };
    await this.send(jid, this.previewSafe(editContent), this.previewSafeOptions(editContent));
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
   * same send addressed to the LID delivers (verified live). Groups, broadcast, already-lid and
   * unmapped ids pass through unchanged, reproducing the previous behavior.
   */
  private async toDeliverableJid(chatId: string): Promise<string> {
    if (!chatId.endsWith('@c.us') && !chatId.endsWith('@s.whatsapp.net')) {
      return chatId;
    }
    try {
      const pn = this.host.toEngineJid(chatId);
      const lid = await this.sock().signalRepository?.lidMapping?.getLIDForPN(pn);
      // Record what the socket just told us. This resolution is the one place a cold contact's lid
      // becomes known before any message arrives, and without writing it back the session store
      // still believes the two ids are unrelated — which makes an ownership check comparing the
      // stored key's lid against a phone-dialect chatId reject a message that IS in that chat.
      if (lid) this.host.recordLidMapping(lid, pn);
      return lid ?? chatId;
    } catch {
      return chatId; // resolution is best-effort; an unmapped contact sends to the PN as before
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
  ): Promise<MessageResult> {
    const jid = await this.toDeliverableJid(chatId);
    const safe = this.previewSafe(content);
    const merged = this.previewSafeOptions(safe, this.withEphemeral(jid, options));
    const sent = await this.send(jid, safe, merged);
    if (sent) {
      void this.host.putStoredMessage(sent)?.catch(err =>
        this.host.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
   * Every message this delegate sends goes through here so its id is recorded before the library
   * echoes it back. Baileys re-emits each own send through `messages.upsert` tagged `append`, the
   * same tag WhatsApp uses to replay what the account typed on its phone while the gateway was
   * down, and the id is the only thing that tells the two apart (see handleMessagesUpsert). The
   * record is synchronous on the send's own continuation, ahead of the library's buffered echo.
   */
  private async send(
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1],
    options?: Parameters<WASocket['sendMessage']>[2],
  ): Promise<WAMessage | undefined> {
    const sent = options
      ? await this.sock().sendMessage(jid, content, options)
      : await this.sock().sendMessage(jid, content);
    this.host.rememberOwnSend(sent?.key?.id);
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

  /** Resolve a previously-seen message from the store, or throw a clear not-found error. */
  private async requireStored(messageId: string): Promise<WAMessage> {
    const found = await this.host.getStoredMessage(messageId);
    if (!found?.key) {
      throw new MessageNotFoundError(messageId);
    }
    return found;
  }

  /**
   * The stored key must belong to the requested chat — acting with another chat's key is a
   * not-found here, not a cross-chat write (a pin sent into chat A referencing chat B's message, or
   * a star indexed under the wrong conversation, would report success). Both sides are neutralized
   * so @c.us/@s.whatsapp.net (and a known lid<->pn twin) compare equal.
   */
  private assertStoredInChat(target: WAMessage, chatId: string, messageId: string): void {
    if (this.host.toNeutralJid(target.key.remoteJid ?? '') !== this.host.toNeutralJid(chatId)) {
      throw new MessageNotFoundError(messageId, chatId);
    }
  }

  async starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    // fromMe is load-bearing: the same message id addresses a different message depending on
    // direction, so omitting it would star the wrong side of the conversation.
    // Fold @c.us -> @s.whatsapp.net: chatModify keys the star app-state index by the raw jid (no
    // jidNormalizedUser, unlike the send path), so a neutral @c.us would index a phantom chat and
    // the star would silently apply to nothing on a 1:1 conversation.
    await this.confirmed(
      this.sock().chatModify(
        { star: { messages: [{ id: target.key.id!, fromMe: target.key.fromMe ?? false }], star } },
        this.host.toEngineJid(chatId),
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
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    // Read the enum through the LAZY loader rather than a static import. @whiskeysockets/baileys is
    // pure ESM and every other site in this codebase defers it to first connect; a module-scope
    // require would drag ~590 modules into boot even for whatsapp-web.js-only processes.
    const { proto } = await this.host.loadLib();
    await this.send(await this.toDeliverableJid(chatId), {
      pin: target.key,
      type: proto.PinInChat.Type.PIN_FOR_ALL,
      // WhatsApp recognises only these three windows; the DTO rejects anything else before we
      // get here, so the cast documents the contract rather than widening it.
      time: durationSeconds as 86400 | 604800 | 2592000,
    });
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    const { proto } = await this.host.loadLib();
    // `time` is meaningless for an unpin and is omitted rather than sent as a dummy value.
    await this.send(await this.toDeliverableJid(chatId), {
      pin: target.key,
      type: proto.PinInChat.Type.UNPIN_FOR_ALL,
    });
  }
}
