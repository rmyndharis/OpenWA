import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { generateSafeLinkPreview } from './safe-link-preview';
import {
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
} from '../interfaces/whatsapp-engine.interface';
import { toEngineParticipants } from './baileys-groups';
import { buildVCard } from './vcard';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { BadRequestException } from '@nestjs/common';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { type createLogger } from '../../common/services/logger.service';

/**
 * Messaging-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysMessagingHost {
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
  toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  loadLib(): Promise<typeof BaileysLib>;
  /** Persist a just-sent message to the store; undefined when no store is configured. */
  putStoredMessage(msg: WAMessage): Promise<void> | undefined;
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

/** Resolve a MediaInput's data (Buffer | base64 string | http(s) URL) to bytes + mimetype. */
export async function resolveMediaBuffer(media: MediaInput): Promise<{ data: Buffer; mimetype: string }> {
  if (Buffer.isBuffer(media.data)) {
    return { data: media.data, mimetype: media.mimetype };
  }
  if (/^https?:\/\//i.test(media.data)) {
    const fetched = await loadRemoteMediaBuffer(media.data);
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
  constructor(private readonly host: BaileysMessagingHost) {}

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    sendOptions?: { linkPreview?: boolean; customPreview?: CustomLinkPreview },
  ): Promise<MessageResult> {
    this.host.ensureReady();
    const jid = await this.toDeliverableJid(chatId);
    // Baileys spreads the caller's options LAST (messages-send.js:1086), so `getUrlInfo` here
    // replaces its hardcoded one — which delegates to a package carrying an unfixed SSRF advisory
    // (see safe-link-preview.ts). Passed on every text send so that generator is never reachable,
    // not only when a preview was asked for.
    const options = {
      ...(this.withEphemeral(jid) ?? {}),
      getUrlInfo: (text: string) => generateSafeLinkPreview(text),
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
    const sent = await this.sock().sendMessage(jid, content, options);
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
    const hit = results?.[0];
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
    const { data, mimetype } = await resolveMediaBuffer(media);
    return this.sendContent(chatId, {
      image: data,
      caption: media.caption,
      mimetype,
      ...this.withMentions(media.mentions),
    });
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return this.sendContent(chatId, {
      video: data,
      caption: media.caption,
      mimetype,
      ...this.withMentions(media.mentions),
    });
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return this.sendContent(chatId, { audio: data, mimetype, ptt: media.ptt ?? false });
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return this.sendContent(chatId, {
      document: data,
      mimetype,
      fileName: media.filename ?? 'file',
      caption: media.caption,
      ...this.withMentions(media.mentions),
    });
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.host.ensureReady();
    const { data } = await resolveMediaBuffer(media);
    return this.sendContent(chatId, { sticker: data });
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.host.ensureReady();
    return this.sendContent(chatId, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description,
        address: location.address,
      },
    });
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.host.ensureReady();
    return this.sendContent(chatId, {
      contacts: { displayName: contact.name, contacts: [{ vcard: buildVCard(contact) }] },
    });
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.host.ensureReady();
    // selectableCount 1 = single choice; 0 = no limit, which is how WhatsApp expresses
    // "allow multiple answers". Baileys generates the poll's messageSecret itself.
    return this.sendContent(chatId, {
      poll: {
        name: poll.name,
        values: poll.options,
        selectableCount: poll.allowMultipleAnswers ? 0 : 1,
      },
    });
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.host.ensureReady();
    const quoted = await this.requireStored(quotedMsgId);
    return this.sendContent(chatId, { text }, { quoted });
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.host.ensureReady();
    const forward = await this.requireStored(messageId);
    return this.sendContent(toChatId, { forward });
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    // Resolved like any other send: a lid-migrated contact rejects PN-addressed sends (ack 463).
    await this.sock().sendMessage(await this.toDeliverableJid(chatId), { react: { text: emoji, key: target.key } });
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    this.host.ensureReady();
    const target = await this.requireStored(messageId);
    this.assertStoredInChat(target, chatId, messageId);
    if (forEveryone) {
      await this.sock().sendMessage(await this.toDeliverableJid(chatId), { delete: target.key });
      return;
    }
    // Delete-for-me (revoke on this device only): Baileys exposes it as a chat modification, not a
    // sendMessage. The stored message timestamp (epoch seconds) is part of the payload.
    await this.sock().chatModify(
      {
        deleteForMe: {
          deleteMedia: true,
          key: target.key,
          timestamp: this.host.toUnixSeconds(target.messageTimestamp),
        },
      },
      this.host.toEngineJid(chatId),
    );
  }

  async editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
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
    const sent = await this.sock().sendMessage(jid, { text: body, edit: target.key });
    return { id: sent?.key?.id ?? messageId, timestamp: this.host.toUnixSeconds(sent?.messageTimestamp) };
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
  private async sendContent(
    chatId: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<MessageResult> {
    const jid = await this.toDeliverableJid(chatId);
    const merged = this.withEphemeral(jid, options);
    const sent = merged
      ? await this.sock().sendMessage(jid, content, merged)
      : await this.sock().sendMessage(jid, content);
    if (sent) {
      void this.host.putStoredMessage(sent)?.catch(err =>
        this.host.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // wwjs fires `message_create` for its own API sends, which SessionService turns into `message.sent`.
      // Baileys' own socket-sends echo back only as a `type:'append'` upsert (skipped as history sync), so
      // that event never fired for API sends. Emit the outbound "created" callback here for parity —
      // best-effort and off the response path, with no media re-download (matching the wwjs payload).
      void this.emitOwnSendEcho(sent);
    }
    return { id: sent?.key?.id ?? '', timestamp: this.host.toUnixSeconds(sent?.messageTimestamp) };
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
    await this.sock().chatModify(
      { star: { messages: [{ id: target.key.id!, fromMe: target.key.fromMe ?? false }], star } },
      this.host.toEngineJid(chatId),
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
    await this.sock().sendMessage(await this.toDeliverableJid(chatId), {
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
    await this.sock().sendMessage(await this.toDeliverableJid(chatId), {
      pin: target.key,
      type: proto.PinInChat.Type.UNPIN_FOR_ALL,
    });
  }
}
