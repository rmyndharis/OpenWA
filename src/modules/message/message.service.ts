import { Injectable, BadRequestException, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageProjector } from '../session/message-projector.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { ReplyMessageDto } from './dto/message-actions.dto';
import { Message, MessageDirection } from './entities/message.entity';
import { HookManager, applySendingGate } from '../../core/hooks';
import { SendPacingService } from './send-pacing.service';
import { createLogger } from '../../common/services/logger.service';
import { parseWaId } from '../../engine/identity/wa-id';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { StorageService, isMissingObjectError } from '../../common/storage/storage.service';
import { MessageSendService, SaveOutgoingMessageData } from './message-send.service';
// Type-only: the module binds this class to PLUGIN_MESSAGE_PORT with a `useExisting` alias, which
// TypeScript does not check, so `implements` is what keeps the two in step.
import type { PluginMessagePort } from '../../core/plugins/plugin-host-ports';

// Re-exported for existing importers (bulk send shares the rendered-template cap with the send path).
export { DEFAULT_TEMPLATE_RENDER_MAX_CHARS } from './message-send.service';

export interface GetMessagesOptions {
  chatId?: string;
  /** Filter by sender. A phone matches stored `@c.us`/`@s.whatsapp.net` ids AND any lid resolving to it. Group messages match on `author` (the real sender) as well as `from` (which holds the group JID). */
  from?: string;
  limit?: number;
  offset?: number;
  /**
   * Keyset cursor: the `id` of the last row of the previous page. Anchors the window to a ROW
   * instead of to a count, so a write between two pages cannot shift it. Takes precedence over
   * `offset`, which is left working unchanged for callers that already use it.
   */
  after?: string;
}

/**
 * Aggregate budget for the inline base64 media ONE message-list response may carry, counted in the
 * encoded bytes that actually land in the JSON body. Override with
 * MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES; 0 omits every payload.
 *
 * The row count was already clamped to 1..100, but a row is not a bounded object: `metadata.media.data`
 * holds the whole base64 payload, so a hundred media rows serialise to hundreds of megabytes — past
 * V8's string ceiling the read fails outright, and the dashboard requests the maximum page size with
 * no way to ask for less. Mirrors the export path's budget rather than inventing a second policy.
 *
 * NOT a hard ceiling on the response. The newest payload is let through whatever its size (see
 * spendInlineMediaBudget), so the real bound is `max(budget, one payload)` — and one payload is
 * bounded upstream by `capInboundMedia` at MEDIA_DOWNLOAD_MAX_BYTES (50 MiB by default, ~68 MiB once
 * base64-encoded). That is well inside V8's string ceiling and is the point: the alternative is a
 * large photo no client can ever read back. Raising MEDIA_DOWNLOAD_MAX_BYTES raises this too.
 */
export const DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = 8 * 1024 * 1024;

export function resolveMessageListInlineMediaBudgetBytes(): number {
  const parsed = Number.parseInt(process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
}

/** `metadata.media.data` holds `base64 || url`, so a pointer must never be mistaken for a payload. */
const MEDIA_URL_POINTER = /^https?:\/\//i;

/**
 * Spend the budget over an already-ordered (newest-first) page, replacing each payload past it with
 * the engine's own `{ omitted: true, sizeBytes }` marker — the same shape `capInboundMedia` writes
 * when inbound media is skipped on the way in, so a trimmed row is not a new shape consumers must
 * learn. Mutates and returns the rows.
 *
 * A budget, not a blanket strip: the recent media a caller is most likely reading still arrives
 * inline, and anything dropped remains fetchable from GET /:chatId/:messageId/media.
 */
export function spendInlineMediaBudget(messages: Message[], budgetBytes: number): Message[] {
  let spent = 0;
  for (const message of messages) {
    const metadata = message.metadata as Record<string, unknown> | null | undefined;
    if (!metadata || typeof metadata !== 'object') continue;
    const media = metadata.media as { data?: unknown; sizeBytes?: number } | null | undefined;
    if (!media || typeof media.data !== 'string' || MEDIA_URL_POINTER.test(media.data)) continue;

    const encoded = Buffer.byteLength(media.data, 'utf8');
    // The newest payload is always let through when inlining is enabled at all. Without this an
    // item larger than the whole budget was omitted even as the ONLY media on the page, so a single
    // large photo or video — well inside the bytes the gateway stores inline — could never be read
    // back through this route: the dashboard thread has no other media source and caches with
    // staleTime: Infinity, leaving a permanent placeholder for media WhatsApp displays.
    // A budget of 0 means "do not inline", not "a very small budget", so it grants no allowance.
    const allowanceApplies = spent === 0 && budgetBytes > 0;
    if (spent + encoded <= budgetBytes || allowanceApplies) {
      spent += encoded;
      continue;
    }
    const { data, ...withoutPayload } = media;
    metadata.media = {
      ...withoutPayload,
      omitted: true,
      // Decoded bytes, matching what capInboundMedia reports — the caller asked how big it WAS.
      sizeBytes: media.sizeBytes ?? Buffer.byteLength(data, 'base64'),
    };
  }
  return messages;
}

/** Pin window applied when the caller does not choose one — WhatsApp's own default of 24h. */
export const DEFAULT_PIN_DURATION_SECONDS = 86400;

/**
 * Mimetypes an archived chat-media file may be served as. Everything else — documents, and notably
 * `image/svg+xml`, which is scriptable despite the `image/` prefix — is served as inert
 * octet-stream so the media endpoint cannot host active content on the API origin.
 */
const INERT_MEDIA_MIMETYPE =
  /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(mpeg|mp4|ogg|aac|wav|webm))(;|$)/;

/** The declared mimetype when it is safe to echo back, else inert octet-stream. */
function inertMimetype(mimetype: string): string {
  return INERT_MEDIA_MIMETYPE.test(mimetype) ? mimetype : 'application/octet-stream';
}

@Injectable()
export class MessageService implements PluginMessagePort {
  private readonly logger = createLogger('MessageService');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly engines: EngineRegistry,
    private readonly messageProjector: MessageProjector,
    private readonly hookManager: HookManager,
    private readonly lidMappingStore: LidMappingStoreService,
    // Required, not @Optional: a missing pacing service would silently mean "no pacing", which is
    // the one failure mode this feature must not have. The service itself no-ops when disabled.
    private readonly pacing: SendPacingService,
    private readonly sender: MessageSendService,
    // Optional so the existing standalone constructions keep working; absent (like a disabled
    // archive) means the media read endpoint serves only the inline row copy, never archived files.
    @Optional()
    private readonly chatMediaArchive?: ChatMediaArchiveService,
    @Optional()
    private readonly storageService?: StorageService,
  ) {}

  // ========== Outbound sends (delegated) ==========
  //
  // The send family lives on MessageSendService; these pass-throughs keep the MessageService
  // surface stable for the controller, agent tools, plugin capabilities and bulk send, which were
  // all wired here before the split.

  sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendText(sessionId, dto);
  }

  sendTemplate(sessionId: string, dto: SendTemplateMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendTemplate(sessionId, dto);
  }

  sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendImage(sessionId, dto);
  }

  sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendVideo(sessionId, dto);
  }

  sendAudio(sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendAudio(sessionId, dto);
  }

  sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendDocument(sessionId, dto);
  }

  sendLocation(
    sessionId: string,
    dto: {
      chatId: string;
      latitude: number;
      longitude: number;
      description?: string;
      address?: string;
      quotedMessageId?: string;
    },
  ): Promise<MessageResponseDto> {
    return this.sender.sendLocation(sessionId, dto);
  }

  sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string; quotedMessageId?: string },
  ): Promise<MessageResponseDto> {
    return this.sender.sendContact(sessionId, dto);
  }

  sendPoll(
    sessionId: string,
    dto: { chatId: string; name: string; options: string[]; allowMultipleAnswers?: boolean; quotedMessageId?: string },
  ): Promise<MessageResponseDto> {
    return this.sender.sendPoll(sessionId, dto);
  }

  sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendSticker(sessionId, dto);
  }

  // Typed by the DTO rather than an inline literal, like every sibling forwarder here. The literal
  // listed three fields while the controller already handed it a fourth, so the declaration said
  // less than what flowed through, and a non-REST caller (the agent tool) could not pass it at all.
  reply(sessionId: string, dto: ReplyMessageDto): Promise<MessageResponseDto> {
    return this.sender.reply(sessionId, dto);
  }

  forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    return this.sender.forward(sessionId, dto);
  }

  /** Persist an outbound row; exposed for the bulk path, which reuses the send-persistence rules. */
  saveOutgoingMessage(sessionId: string, data: SaveOutgoingMessageData): Promise<Message> {
    return this.sender.saveOutgoingMessage(sessionId, data);
  }

  /**
   * Get message history for a session
   */
  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId, from, after } = options;
    // Sanitize pagination: a non-finite limit/offset — e.g. `?limit=abc` -> NaN —
    // must never reach TypeORM's take()/skip(). Clamp to sane bounds; fall back to defaults.
    const rawLimit = options.limit;
    const rawOffset = options.offset;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.sessionId = :sessionId', { sessionId })
      .orderBy('message.createdAt', 'DESC')
      // `createdAt` is not unique: SQLite stores whole seconds, Postgres NOW() is transaction-scoped
      // so a bulk write ties every row, and a history backfill stamps WhatsApp's own second-resolution
      // timestamp. Without a tiebreaker the tie group's order is whatever the plan produces, and
      // Postgres sorts it differently between two statements, so a page walk repeats some rows and
      // never returns others. `id` is random, not chronological, but it is unique and stable, which
      // is all a total order needs.
      .addOrderBy('message.id', 'DESC')
      .take(limit);

    // `after` replaces the offset rather than adding to it: mixing a row anchor with a count is
    // meaningless, and silently ignoring one of the two is friendlier to an SDK that always sends
    // `offset=0` than a 400 would be.
    if (after === undefined) {
      query.skip(offset);
    }

    if (chatId) {
      // Match across dialects: a stored chatId may be `@s.whatsapp.net` (e.g. an outbound send addressed
      // by a raw engine id) while the caller filters by the neutral `@c.us` from the chat list - same
      // chat, different dialect. Resolving both sides through the table keeps them equal.
      query.andWhere('message.chatId IN (:...chatIds)', { chatIds: this.resolveJidCandidates(chatId) });
    }

    if (from) {
      // Resolve the filter through the lid->phone table so a phone matches not just the stored
      // `<phone>@c.us` id but also any lid that resolves to the same person - turning the prior
      // silent miss (a lid-stored author vs a phone filter) into a hit.
      // A group message stores the real sender in `author` (`from` holds the group JID), so match
      // BOTH columns against the same candidate set or the filter skips every group message the
      // person wrote. Query plan: neither `from` nor `author` is indexed - the predicate applies
      // within the (sessionId, createdAt)-narrowed scan exactly as the from-only filter did, so the
      // OR costs nothing the old plan didn't already pay. No new index: per-session narrowing
      // dominates selectivity and a single btree cannot serve an OR across two columns anyway.
      const froms = this.resolveJidCandidates(from);
      query.andWhere('(message.from IN (:...froms) OR message.author IN (:...authorFroms))', {
        froms,
        authorFroms: froms,
      });
    }

    if (after !== undefined) {
      // `total` keeps its documented meaning, rows matching the filters, so count before narrowing.
      const total = await query.clone().getCount();
      // The anchor's sort key is resolved INSIDE the statement. Carrying it in the cursor instead
      // would mean round-tripping a timestamp through JSON, and neither dialect survives that:
      // SQLite holds two text shapes for one instant (`datetime('now')` writes 19 chars, a stamped
      // JS Date writes 23) and compares them as text, while node-postgres truncates the column's
      // microseconds to a millisecond Date. Both mis-seek silently, which is the very failure this
      // cursor exists to remove.
      query.andWhere(
        '(message.createdAt, message.id) < ' +
          '(SELECT anchor."createdAt", anchor."id" FROM messages anchor ' +
          'WHERE anchor."id" = :after AND anchor."sessionId" = :sessionId)',
        { after, sessionId },
      );
      const messages = await query.getMany();
      // An anchor that does not exist (or belongs to another session) makes the row comparison NULL,
      // which returns zero rows and reads exactly like the end of the history. Only pay for the
      // lookup on an empty page, and turn that silent truncation into a loud 400.
      if (messages.length === 0 && !(await this.messageRepository.exists({ where: { id: after, sessionId } }))) {
        throw new BadRequestException(`Unknown cursor '${after}' for this session`);
      }
      return { messages: spendInlineMediaBudget(messages, resolveMessageListInlineMediaBudgetBytes()), total };
    }

    const [messages, total] = await query.getManyAndCount();
    // The 1..100 clamp above bounds the ROW COUNT, not the response: each row carries its inline
    // base64 in metadata.media.data. Spent newest-first (the query orders createdAt DESC), so the
    // most recently viewed media still arrives inline and the rest keeps its omitted marker.
    return { messages: spendInlineMediaBudget(messages, resolveMessageListInlineMediaBudgetBytes()), total };
  }

  /**
   * Expand a user JID filter into every stored id that refers to the same person: the literal input
   * (so an exact lid filter still matches), the user-part in both user dialects (`@c.us` /
   * `@s.whatsapp.net`), and every lid the resolution table maps to that phone.
   *
   * Scoped by chat kind. For a non-user kind (group/status/newsletter/broadcast) the stored id can
   * only ever be the literal JID, so no candidates are generated: expanding a group or channel id's
   * digits into the user dialects (or probing the lid table with them) could mis-resolve the filter
   * onto an unrelated entity whose phone digits happen to match — fail closed on the literal id.
   * A `@lid` input forward-resolves to its phone instead of minting `<lid-digits>@c.us` (the lid's
   * digits are NOT a phone), so rows stored under the resolved form still match a raw-lid filter.
   */
  private resolveJidCandidates(value: string): string[] {
    const parsed = parseWaId(value);
    if (parsed.kind !== 'user' && parsed.kind !== 'lid' && parsed.kind !== 'unknown') {
      return [value];
    }
    if (parsed.kind === 'lid') {
      const candidates = new Set<string>([value]);
      const resolved = this.lidMappingStore.getCached(parsed.userPart);
      if (resolved) {
        candidates.add(`${resolved}@c.us`);
        candidates.add(`${resolved}@s.whatsapp.net`);
      }
      return [...candidates];
    }
    const phone = parsed.userPart;
    const candidates = new Set<string>([value, `${phone}@c.us`, `${phone}@s.whatsapp.net`]);
    for (const lid of this.lidMappingStore.lidsForPhone(phone)) {
      candidates.add(`${lid}@lid`);
    }
    return [...candidates];
  }

  /**
   * Save incoming message (called from session webhook dispatch)
   */
  async saveIncomingMessage(sessionId: string, data: Partial<Message>): Promise<Message> {
    const message = this.messageRepository.create({
      ...data,
      sessionId,
      direction: MessageDirection.INCOMING,
    });
    return this.messageRepository.save(message);
  }

  // ========== Phase 3: Reactions ==========

  async reactToMessage(sessionId: string, dto: { chatId: string; messageId: string; emoji: string }): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  /**
   * Read a message's media: the archived file when one exists, else the inline copy persisted on
   * the message row. The fallback is what makes media sent BY the account retrievable here — the
   * archive is written only on the inbound path, but outbound rows carry the payload inline: the
   * REST send persists it, wwjs downloads it for the own-send echo, and Baileys downloads it for
   * phone-composed fromMe messages (the Baileys API-send echo alone carries only a marker, which
   * the REST-persisted copy covers) — #1165. It also serves an inbound message whose archived file
   * was purged by retention while the inline copy lives on.
   *
   * Unlike status media (only ever an image or video), chat media includes documents a sender chose
   * the type of — so the declared mimetype is echoed back only when it is inert, and the caller
   * serves the result as an attachment regardless. Both matter: an allow-list alone would still let
   * `image/svg+xml` through as active content on the API origin.
   */
  async getChatMedia(
    sessionId: string,
    chatId: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const chatIds = this.resolveJidCandidates(chatId);
    const media = await this.chatMediaArchive?.getMedia(sessionId, chatIds, messageId);
    if (media && this.storageService) {
      try {
        return { buffer: await this.storageService.getFile(media.path), mimetype: inertMimetype(media.mimetype) };
      } catch (error) {
        // The row outlived its file: the retention purge (or a concurrent delete) removed it
        // between the DB read and this read. Not a server fault — try the inline copy instead.
        if (!isMissingObjectError(error)) {
          throw error;
        }
      }
    }

    // Match across dialects like getMessages does: an outbound row stores the caller's literal
    // chatId (REST persist) or the engine-neutral form (own-send echo) depending on which writer
    // won the persist race, so a literal match would 404 on half the rows this fallback exists for.
    const row = await this.messageRepository.findOne({
      where: { sessionId, chatId: In(chatIds), waMessageId: messageId },
    });
    const inline = (row?.metadata as { media?: { data?: unknown; mimetype?: unknown; omitted?: unknown } })?.media;
    if (
      !inline ||
      inline.omitted ||
      typeof inline.data !== 'string' ||
      !inline.data ||
      typeof inline.mimetype !== 'string' ||
      !inline.mimetype ||
      // A URL-based send persists the URL STRING as `data` (buildMediaInput: `data: base64 ||
      // dto.url!`) — the bytes were fetched at send time and never stored. Decoding the URL as
      // base64 would serve garbage, so report it as absent. Same discriminator as the send path.
      /^https?:\/\//i.test(inline.data)
    ) {
      throw new NotFoundException('No media stored for this message');
    }
    return { buffer: Buffer.from(inline.data, 'base64'), mimetype: inertMimetype(inline.mimetype) };
  }

  /** Maximum messages a single getChatHistory call may request from the engine. */
  private static readonly MAX_CHAT_HISTORY_LIMIT = 100;

  /** Higher ceiling for opt-in deep history (`deep=true`). Bounded so a caller still can't ask unbounded. */
  private static readonly MAX_DEEP_CHAT_HISTORY_LIMIT = 2000;

  /**
   * Fetch chat history live from WhatsApp (bypasses local DB).
   * Returns the most recent `limit` messages for the given chat.
   * When `includeMedia` is true, downloads media (base64) for messages that have it.
   *
   * `limit` is clamped to [1, 100] (and falls back to 50 for non-finite input) so a caller cannot ask the
   * engine to fetch an unbounded number of messages. When `deep` is true the ceiling is raised to 2000
   * (for reaching weeks/months back on whatsapp-web.js, which can load earlier messages on demand) and
   * media is forced off — downloading base64 for up to 2000 messages would be an enormous, slow payload.
   *
   * An optional `signal` (HTTP client disconnect) is threaded to the engine, which checks it between
   * media downloads. Callers without cancellation keep the exact three-argument engine call shape.
   */
  async getChatHistory(
    sessionId: string,
    chatId: string,
    limit = 50,
    includeMedia = false,
    deep = false,
    signal?: AbortSignal,
  ) {
    const engine = this.getEngine(sessionId);
    const ceiling = deep ? MessageService.MAX_DEEP_CHAT_HISTORY_LIMIT : MessageService.MAX_CHAT_HISTORY_LIMIT;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), ceiling) : 50;
    const media = deep ? false : includeMedia;
    return signal
      ? engine.getChatHistory(chatId, safeLimit, media, undefined, signal)
      : engine.getChatHistory(chatId, safeLimit, media);
  }

  // ========== Delete Message ==========

  /**
   * Pin a message for a bounded window. Nothing is persisted locally: a pin is chat state owned by
   * WhatsApp, not a property of our message row, and it expires on WhatsApp's clock — a mirrored
   * copy here would silently go stale.
   */
  async pinMessage(sessionId: string, dto: { chatId: string; messageId: string; durationSeconds?: number }) {
    const engine = this.getEngine(sessionId);
    await engine.pinMessage(dto.chatId, dto.messageId, dto.durationSeconds ?? DEFAULT_PIN_DURATION_SECONDS);
    return { success: true };
  }

  async unpinMessage(sessionId: string, dto: { chatId: string; messageId: string }) {
    const engine = this.getEngine(sessionId);
    await engine.unpinMessage(dto.chatId, dto.messageId);
    return { success: true };
  }

  /**
   * Star or unstar a message. Like a pin, this is WhatsApp-owned state and is not mirrored locally
   * — but unlike a pin it is private to the account and never expires.
   *
   * Best-effort on whatsapp-web.js: its star/unstar resolve void and silently do nothing when
   * WhatsApp declines the message, so a 200 here means the instruction was delivered, not that the
   * star is definitely set.
   */
  async starMessage(sessionId: string, dto: { chatId: string; messageId: string; star: boolean }) {
    const engine = this.getEngine(sessionId);
    await engine.starMessage(dto.chatId, dto.messageId, dto.star);
    return { success: true };
  }

  /**
   * Cast a vote on a poll. Not supported on the Baileys engine, which surfaces as a 501 from the
   * adapter. `options` are option texts — see the engine interface for why there are no ids.
   */
  async votePoll(sessionId: string, dto: { chatId: string; pollMessageId: string; options: string[] }) {
    const engine = this.getEngine(sessionId);
    await engine.votePoll(dto.chatId, dto.pollMessageId, dto.options);
    return { success: true };
  }

  async deleteMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; forEveryone?: boolean },
  ): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);

    // Flag the stored message as revoked. No localized display string is persisted here;
    // the dashboard renders the localized "message deleted" text.
    try {
      await this.messageRepository.update({ sessionId, waMessageId: dto.messageId }, { body: '', type: 'revoked' });
    } catch (err) {
      this.logger.warn(`Failed to flag deleted message ${dto.messageId} as revoked`, { error: String(err) });
    }
  }

  // ========== Edit Message ==========

  async editMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; body: string; mentions?: string[] },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    // An edit replaces the text the recipient sees, so it is content leaving the account and goes
    // through the same moderation chokepoint as every other sender. A plugin can rewrite `body`
    // here exactly as it can for a first send.
    const finalDto = await this.applySendingGate(sessionId, 'edit', dto);
    const result = finalDto.mentions?.length
      ? await engine.editMessage(finalDto.chatId, finalDto.messageId, finalDto.body, finalDto.mentions)
      : await engine.editMessage(finalDto.chatId, finalDto.messageId, finalDto.body);

    // Best-effort: reflect the new body in the stored copy (mirrors deleteMessage's revoked flag),
    // serialized with the inbound edit/reaction writers through the session's per-message mutation
    // queue. A missing row must not fail the request — the engine edit already succeeded.
    await this.messageProjector.recordOutboundMessageEdit(sessionId, finalDto.messageId, finalDto.body);
    return { messageId: result.id, timestamp: result.timestamp };
  }

  /**
   * Run the pre-send `message:sending` plugin gate for one outbound message and return the
   * (possibly plugin-modified) input, or throw BadRequestException if a plugin blocked the send.
   * On this query-side class the edit path is the one sender it gates; the text, media, and
   * extended senders pass through the twin method in MessageSendService. Both funnel into the
   * same core/hooks/sending-gate implementation (shared with StatusService too), so no outbound
   * sender skips moderation.
   */
  private async applySendingGate<T extends object>(sessionId: string, type: string, input: T): Promise<T> {
    // Pacing runs BEFORE the plugin gate, so a send that policy forbids never reaches a plugin at
    // all — plugins should not be asked to moderate, or given the chance to rewrite, traffic that is
    // not going to be sent. The consequence is deliberate and documented in the hook contract: a
    // paced-out send fires no `message:sending`, so a plugin cannot observe it. Refusals are a 429
    // carrying `code: SEND_PACING_LIMITED`; a plugin veto stays a 400.
    // Every gated sender's DTO addresses its destination as `chatId` except forward, which uses
    // `toChatId` — without the fallback a forward skipped the cold-reachout gate entirely, while
    // its persisted row still drained the cold budget. Edit carries a chatId too; the edited
    // message's own row already makes that chat warm, so the gate is a no-op there.
    const target = input as { chatId?: string; toChatId?: string };
    await this.pacing.assertSendAllowed(sessionId, target.chatId ?? target.toChatId);
    return applySendingGate(this.hookManager, sessionId, type, input, 'MessageService');
  }

  private getEngine(sessionId: string) {
    return this.engines.require(
      sessionId,
      () => new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`),
    );
  }
}
