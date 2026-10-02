import { Injectable, BadRequestException, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageProjector } from '../session/message-projector.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { ReplyMessageDto, ClickButtonDto } from './dto/message-actions.dto';
import { Message, MessageDirection } from './entities/message.entity';
import { HookManager, applySendingGate } from '../../core/hooks';
import { SendPacingService } from './send-pacing.service';
import { createLogger } from '../../common/services/logger.service';
import { resolveJidCandidates as expandJidCandidates } from '../../engine/identity/jid-candidates';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { StorageService, isMissingObjectError } from '../../common/storage/storage.service';
import { MessageSendService, SaveOutgoingMessageData } from './message-send.service';
// Type-only: the module binds this class to PLUGIN_MESSAGE_PORT with a `useExisting` alias, which
// TypeScript does not check, so `implements` is what keeps the two in step.
import type { PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { MessageWindow, validateMessageWindow } from './message-window';

// Re-exported for existing importers (bulk send shares the rendered-template cap with the send path).
export { DEFAULT_TEMPLATE_RENDER_MAX_CHARS } from './message-send.service';

export interface GetMessagesOptions extends MessageWindow {
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
  /**
   * Set false to omit every inline media payload, leaving each row's `{ omitted, sizeBytes }` marker
   * and the media endpoint. The budget below is per RESPONSE, so a walk pulls it afresh on every
   * page; a client reading many pages usually wants the rows, not the bytes. Defaults to true.
   */
  inlineMedia?: boolean;
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
 *
 * It bounds the read as well: getMessages loads a page in chunks and drops each omitted payload
 * before reading the next chunk, so payloads past the budget are never all held at once.
 */
export const DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = 8 * 1024 * 1024;

export function resolveMessageListInlineMediaBudgetBytes(): number {
  const parsed = Number.parseInt(process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
}

/** `metadata.media.data` holds `base64 || url`, so a pointer must never be mistaken for a payload. */
const MEDIA_URL_POINTER = /^https?:\/\//i;

/**
 * The engine's own `{ omitted: true, sizeBytes }` marker for a media object whose payload is dropped,
 * the same shape `capInboundMedia` writes when inbound media is skipped on the way in, so a trimmed
 * row is not a new shape consumers must learn. Every descriptive field except `data` survives.
 */
export function omitInlineMedia(media: { data: string; sizeBytes?: number }): Record<string, unknown> {
  const { data, ...withoutPayload } = media;
  return {
    ...withoutPayload,
    omitted: true,
    // Decoded bytes, matching what capInboundMedia reports: the caller asked how big it WAS.
    sizeBytes: media.sizeBytes ?? Buffer.byteLength(data, 'base64'),
  };
}

/**
 * Stateful form of spendInlineMediaBudget: feed it the rows of one page newest-first, one at a time,
 * so a caller can drop each omitted payload before it reads the next row.
 */
export function createInlineMediaSpender(budgetBytes: number): (message: Message) => void {
  let spent = 0;
  return message => {
    const metadata = message.metadata as Record<string, unknown> | null | undefined;
    if (!metadata || typeof metadata !== 'object') return;
    // A revoked message has no media, even on a row restored or merged after its revoke was cleared.
    if (message.type === 'revoked') {
      delete metadata.media;
      return;
    }
    const media = metadata.media as { data?: unknown; sizeBytes?: number } | null | undefined;
    if (!media || typeof media.data !== 'string' || MEDIA_URL_POINTER.test(media.data)) return;

    const encoded = Buffer.byteLength(media.data, 'utf8');
    // The newest payload is always let through when inlining is enabled at all. Without this an
    // item larger than the whole budget was omitted even as the ONLY media on the page, so a single
    // large photo or video (well inside the bytes the gateway stores inline) could never be read
    // back through this route: the dashboard thread has no other media source and caches with
    // staleTime: Infinity, leaving a permanent placeholder for media WhatsApp displays.
    // A budget of 0 means "do not inline", not "a very small budget", so it grants no allowance.
    const allowanceApplies = spent === 0 && budgetBytes > 0;
    if (spent + encoded <= budgetBytes || allowanceApplies) {
      spent += encoded;
      return;
    }
    metadata.media = omitInlineMedia({ ...media, data: media.data });
  };
}

/**
 * Spend the budget over an already-ordered (newest-first) page, replacing each payload past it with
 * the omitted marker (see omitInlineMedia). Mutates and returns the rows.
 *
 * A budget, not a blanket strip: the recent media a caller is most likely reading still arrives
 * inline, and anything dropped remains fetchable from GET /:chatId/:messageId/media.
 */
export function spendInlineMediaBudget(messages: Message[], budgetBytes: number): Message[] {
  messages.forEach(createInlineMediaSpender(budgetBytes));
  return messages;
}

/**
 * Floor for the bytes of stored metadata one message-list read loads at once. The page is read in
 * chunks of at most `max(budget, this)` metadata bytes (at least one row each), and each chunk's
 * omitted payloads are dropped before the next chunk is read, so the heap holds about one chunk plus
 * what the budget keeps instead of every payload on the page.
 */
const MESSAGE_LIST_READ_CHUNK_MIN_BYTES = 1024 * 1024;

/** Pin window applied when the caller does not choose one — WhatsApp's own default of 24h. */
export const DEFAULT_PIN_DURATION_SECONDS = 86400;

/**
 * Mimetypes an archived chat-media file may be served as. Everything else — documents, and notably
 * `image/svg+xml`, which is scriptable despite the `image/` prefix — is served as inert
 * octet-stream so the media endpoint cannot host active content on the API origin.
 */
const INERT_MEDIA_MIMETYPE =
  /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(mpeg|mp4|ogg|aac|wav|webm))$/;

/**
 * The declared mimetype's normalized essence when it is safe to echo back, else inert octet-stream.
 * Parameters are dropped rather than echoed: the sender wrote them, a comma among them makes a
 * browser read a second type, and a character above U+00FF is refused as a header value.
 */
function inertMimetype(mimetype: string): string {
  const essence = mimetype.split(';')[0].trim().toLowerCase();
  return INERT_MEDIA_MIMETYPE.test(essence) ? essence : 'application/octet-stream';
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

  /**
   * Second sort key for the message list: what makes the page order TOTAL without scrambling the
   * order the messages actually arrived in.
   *
   * A tiebreaker is required, because `createdAt` is not unique. But `id` is a random v4 uuid, so
   * it orders a tie group at random: five same-second messages came back shuffled, and the
   * dashboard renders whatever the server sends. It is also in no index, so SQLite sorted the whole
   * result into a temp b-tree to apply it.
   *
   * SQLite already stores the insertion sequence as `rowid`, the implicit trailing column of every
   * index, so `(createdAt DESC, rowid DESC)` is a plain backward scan of `(sessionId, createdAt)`:
   * arrival order restored, and the temp b-tree gone with it. Measured on the pinned better-sqlite3
   * with the shipped index set.
   *
   * PostgreSQL has no equivalent. `ctid` is physical position and moves on every ack UPDATE, so it
   * cannot order anything, and a monotonic column would need a table rewrite on the hottest table
   * with no recoverable insertion order to backfill from. It keeps `id`: the walk stays correct,
   * and a same-second group keeps its uuid order there.
   */
  private get orderTiebreak(): 'rowid' | 'id' {
    return this.messageRepository.manager?.connection?.options?.type === 'postgres' ? 'id' : 'rowid';
  }

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

  clickButton(sessionId: string, dto: ClickButtonDto): Promise<MessageResponseDto> {
    return this.sender.clickButton(sessionId, dto);
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
  ): Promise<{ messages: Message[]; total: number; unknownTimestampTotal?: number }> {
    const { chatId, from, after, inlineMedia } = options;
    validateMessageWindow(options);
    const messageTimeOrder = options.orderBy === 'timestamp';
    // Sanitize pagination: a non-finite limit/offset — e.g. `?limit=abc` -> NaN —
    // must never reach TypeORM's take()/skip(). Clamp to sane bounds; fall back to defaults.
    const rawLimit = options.limit;
    const rawOffset = options.offset;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

    const tiebreak = messageTimeOrder ? 'id' : this.orderTiebreak;
    // Match across dialects: a stored chatId may be `@s.whatsapp.net` (e.g. an outbound send addressed
    // by a raw engine id) while the caller filters by the neutral `@c.us` from the chat list - same
    // chat, different dialect. Resolving both sides through the table keeps them equal.
    const chatIds = chatId ? await this.resolveJidCandidates(chatId) : undefined;
    // SQLite has no planner statistics here (nothing runs ANALYZE), so with several chatId candidates
    // it prefers the (sessionId, createdAt) index because it already yields the order, and walks the
    // whole session filtering chatId row by row. The unary `+` takes createdAt out of index-order
    // consideration, so it seeks (sessionId, chatId, createdAt) and sorts only that chat's rows, the
    // plan ANALYZE would pick. A single candidate already uses that index in order, and PostgreSQL
    // (no unary `+` on timestamps) has statistics, so both keep the plain key.
    const orderColumn = messageTimeOrder ? 'timestamp' : 'createdAt';
    const createdAtKey =
      this.orderTiebreak === 'rowid' && chatIds !== undefined && chatIds.length > 1
        ? `+message.${orderColumn}`
        : `message.${orderColumn}`;

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.sessionId = :sessionId', { sessionId })
      // Stories belong to the status store. Legacy imports can still contain
      // their rows here; exclude them before totals, time gaps and pagination.
      .andWhere('message.chatId <> :statusBroadcast', { statusBroadcast: 'status@broadcast' })
      .orderBy(createdAtKey, 'DESC')
      // `createdAt` is not unique: SQLite stores whole seconds, Postgres NOW() is transaction-scoped
      // so a bulk write ties every row, and a history backfill stamps WhatsApp's own second-resolution
      // timestamp. Without a tiebreaker the tie group's order is whatever the plan produces, and
      // Postgres sorts it differently between two statements, so a page walk repeats some rows and
      // never returns others. See `orderTiebreak` for why the key differs by dialect.
      .addOrderBy(`message.${tiebreak}`, 'DESC')
      .take(limit);

    // `after` replaces the offset rather than adding to it: mixing a row anchor with a count is
    // meaningless, and silently ignoring one of the two is friendlier to an SDK that always sends
    // `offset=0` than a 400 would be.
    if (after === undefined) {
      query.skip(offset);
    }

    if (chatIds) {
      query.andWhere('message.chatId IN (:...chatIds)', { chatIds });
    }
    if (options.direction !== undefined) {
      query.andWhere('message.direction = :direction', { direction: options.direction });
    }
    if (options.type !== undefined) query.andWhere('message.type = :messageType', { messageType: options.type });

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
      const froms = await this.resolveJidCandidates(from);
      query.andWhere('(message.from IN (:...froms) OR message.author IN (:...authorFroms))', {
        froms,
        authorFroms: froms,
      });
    }

    if (options.messageId !== undefined) {
      query.andWhere('message.waMessageId = :messageId', { messageId: options.messageId });
    }
    const hasTimeSelection = messageTimeOrder || options.since !== undefined || options.until !== undefined;
    // Unknown times cannot belong to a verified time window. Count the gap within the same
    // session/chat/sender/direction, before applying time bounds, without loading message bodies.
    const unknownTimestampTotal = hasTimeSelection
      ? await query.clone().andWhere('message.timestamp IS NULL').getCount()
      : undefined;
    if (messageTimeOrder) query.andWhere('message.timestamp IS NOT NULL');
    if (options.since !== undefined) {
      query.andWhere('message.timestamp >= :since', { since: options.since / 1000 });
    }
    if (options.until !== undefined) {
      query.andWhere('message.timestamp < :until', { until: options.until / 1000 });
    }

    // A budget of 0 means "never inline" and grants no single-payload allowance, which is exactly
    // what an opted-out caller asks for, so the flag picks the budget rather than a second code path.
    const inlineMediaBudget = inlineMedia === false ? 0 : resolveMessageListInlineMediaBudgetBytes();

    // `total` keeps its documented meaning, rows matching the filters, so count before narrowing.
    const total = await query.clone().getCount();

    if (after !== undefined) {
      // A selection cursor must name a row inside this same selection, not merely a row from the
      // session. Otherwise an unrelated chat/time/direction could silently truncate a valid walk.
      if (
        (messageTimeOrder ||
          options.since !== undefined ||
          options.until !== undefined ||
          options.direction !== undefined ||
          options.type !== undefined) &&
        !(await query.clone().andWhere('message.id = :cursorId', { cursorId: after }).getCount())
      ) {
        throw new BadRequestException('Unknown cursor for this message selection');
      }
      // The anchor's sort key is resolved INSIDE the statement. Carrying it in the cursor instead
      // would mean round-tripping a timestamp through JSON, and neither dialect survives that:
      // SQLite holds two text shapes for one instant (`datetime('now')` writes 19 chars, a stamped
      // JS Date writes 23) and compares them as text, while node-postgres truncates the column's
      // microseconds to a millisecond Date. Both mis-seek silently, which is the very failure this
      // cursor exists to remove.
      query.andWhere(
        `(message.${orderColumn}, message.${tiebreak}) < ` +
          `(SELECT anchor."${orderColumn}", anchor."${tiebreak}" FROM messages anchor ` +
          'WHERE anchor."id" = :after AND anchor."sessionId" = :sessionId)',
        { after, sessionId },
      );
    }

    // The page is picked by id only. Each row's metadata can hold a whole base64 payload, so the
    // rows themselves are read in bounded chunks below, sized from a second, id-keyed statement.
    // The size stays out of the ordered one: a sort evaluates its result columns for every matching
    // row, so a size there would be computed across the whole chat, not just this page.
    const pageIds = (await query.select('message.id', 'id').getRawMany<{ id: string }>()).map(r => r.id);
    const page = await this.readMetadataSizes(sessionId, pageIds);

    // An anchor that does not exist (or belongs to another session) makes the row comparison NULL,
    // which returns zero rows and reads exactly like the end of the history. Only pay for the
    // lookup on an empty page, and turn that silent truncation into a loud 400.
    if (
      after !== undefined &&
      page.length === 0 &&
      !(await this.messageRepository.exists({ where: { id: after, sessionId } }))
    ) {
      throw new BadRequestException(`Unknown cursor '${after}' for this session`);
    }

    // The 1..100 clamp above bounds the ROW COUNT, not the response: each row carries its inline
    // base64 in metadata.media.data. Spent newest-first (the query orders createdAt DESC), so the
    // most recently viewed media still arrives inline and the rest keeps its omitted marker.
    return {
      messages: await this.readPageSpendingBudget(sessionId, page, inlineMediaBudget),
      total,
      ...(unknownTimestampTotal !== undefined ? { unknownTimestampTotal } : {}),
    };
  }

  /**
   * The stored metadata size of each page row, in page order. OCTET_LENGTH, not LENGTH: both
   * SQLite and PostgreSQL answer it from the stored header, while a character count has to read
   * (and on PostgreSQL detoast) every payload in full, which the chunked read then does again.
   */
  private async readMetadataSizes(
    sessionId: string,
    pageIds: string[],
  ): Promise<Array<{ id: string; metadataLength: number | string | null }>> {
    if (pageIds.length === 0) return [];
    const sizes = await this.messageRepository
      .createQueryBuilder('message')
      .select('message.id', 'id')
      .addSelect('OCTET_LENGTH(message.metadata)', 'metadataLength')
      .where('message.id IN (:...pageIds)', { pageIds })
      .andWhere('message.sessionId = :sessionId', { sessionId })
      .getRawMany<{ id: string; metadataLength: number | string | null }>();
    const sizeById = new Map(sizes.map(r => [r.id, r.metadataLength]));
    return pageIds.map(id => ({ id, metadataLength: sizeById.get(id) ?? null }));
  }

  /**
   * Load the rows of a page in its order, in chunks of at most `max(budget, 1 MiB)` stored metadata
   * bytes (at least one row per chunk), spending the inline media budget on each chunk before the
   * next is read. Loading the whole page at once put every payload on the heap before the budget
   * dropped most of them. A row deleted since the page was picked is left out.
   */
  private async readPageSpendingBudget(
    sessionId: string,
    page: Array<{ id: string; metadataLength: number | string | null }>,
    budgetBytes: number,
  ): Promise<Message[]> {
    const spend = createInlineMediaSpender(budgetBytes);
    const chunkLimit = Math.max(budgetBytes, MESSAGE_LIST_READ_CHUNK_MIN_BYTES);
    const messages: Message[] = [];
    let chunk: string[] = [];
    let chunkBytes = 0;

    const flush = async (): Promise<void> => {
      const rows = await this.messageRepository.find({ where: { id: In(chunk), sessionId } });
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const id of chunk) {
        const row = byId.get(id);
        if (!row) continue;
        spend(row);
        messages.push(row);
      }
      chunk = [];
      chunkBytes = 0;
    };

    for (const { id, metadataLength } of page) {
      const bytes = Number(metadataLength) || 0;
      if (chunk.length > 0 && chunkBytes + bytes > chunkLimit) await flush();
      chunk.push(id);
      chunkBytes += bytes;
    }
    if (chunk.length > 0) await flush();
    return messages;
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
  private async resolveJidCandidates(value: string): Promise<string[]> {
    // Rules live in the shared helper (engine/identity/jid-candidates) so this filter and the
    // API-key chat scope cannot disagree about which ids refer to the same entity. The raw input is
    // kept as a candidate too: a row stored under a non-folded spelling must still match it.
    const expanded = await expandJidCandidates(value, {
      resolveLid: lid => this.lidMappingStore.findPhoneForLid(lid),
      lidsForPhone: phone => this.lidMappingStore.findLidsForPhone(phone),
    });
    return [...new Set([value, ...expanded])];
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
   * Unlike status media (only ever an image, a video or a voice note), chat media includes documents
   * a sender chose the type of — so the declared mimetype is echoed back only when it is inert, and the caller
   * serves the result as an attachment regardless. Both matter: an allow-list alone would still let
   * `image/svg+xml` through as active content on the API origin.
   */
  async getChatMedia(
    sessionId: string,
    chatId: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const chatIds = await this.resolveJidCandidates(chatId);
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
      // A revoked message's media is gone, even on a row cleared before revokes dropped it.
      row?.type === 'revoked' ||
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

    // Clear the stored message the same way an engine revoke does (body, media and metadata), on
    // its mutation chain. Best-effort: never rejects. No localized display string is persisted
    // here; the dashboard renders the localized "message deleted" text.
    await this.messageProjector.recordRevoke(sessionId, dto.messageId);
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
