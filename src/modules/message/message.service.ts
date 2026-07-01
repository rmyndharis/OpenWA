import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { assertBase64WithinMediaCap } from './media-cap.util';
import { MediaInput, IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { renderTemplate } from '../../common/utils/template-render';
import { createLogger } from '../../common/services/logger.service';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { userPart } from '../../engine/identity/wa-id';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

export interface GetMessagesOptions {
  chatId?: string;
  /** Filter by sender. A phone matches stored `@c.us`/`@s.whatsapp.net` ids AND any lid resolving to it. */
  from?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class MessageService {
  private readonly logger = createLogger('MessageService');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly hookManager: HookManager,
    private readonly templateService: TemplateService,
    private readonly lidMappingStore: LidMappingStoreService,
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    // Execute hook before sending - plugins can modify or block
    const { continue: shouldContinue, data: hookData } = await this.hookManager.execute(
      'message:sending',
      { sessionId, input: dto, type: 'text' },
      { sessionId, source: 'MessageService' },
    );

    if (!shouldContinue) {
      throw new BadRequestException('Message sending blocked by plugin');
    }

    // Use potentially modified input
    const finalDto = (hookData as { input: SendTextMessageDto }).input;

    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
    });

    // Opt-in humanising "typing…" pause before the actual send (anti-automation signal).
    await this.simulateTypingIfEnabled(engine, finalDto.chatId, finalDto.text);

    let result: MessageResult;
    try {
      // Keep the 2-arg call shape for plain sends; only pass mentions when the caller supplied any.
      result = finalDto.mentions?.length
        ? await engine.sendTextMessage(finalDto.chatId, finalDto.text, finalDto.mentions)
        : await engine.sendTextMessage(finalDto.chatId, finalDto.text);
    } catch (error) {
      // The SEND itself failed — mark FAILED and fire the failure hook (a post-send persistence fault is
      // handled separately by persistSentState and must NOT land here).
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      await this.hookManager.execute(
        'message:failed',
        { sessionId, error: error instanceof Error ? error.message : String(error), input: finalDto },
        { sessionId, source: 'MessageService' },
      );
      throw error;
    }

    // Note: the `message:sent` hook is emitted solely by SessionService.onMessageCreate (engine
    // `message_create`) with a consistent IncomingMessage payload for ALL sends (text, media,
    // and phone-composed), so it is intentionally not fired here to avoid a double dispatch.
    return this.persistSentState(message, result);
  }

  /**
   * Resolve a stored template, render its body (with optional header/footer
   * flattened using newlines) using the supplied variables, and delegate to the
   * existing {@link sendText} path so plugin hooks, persistence, and status
   * tracking are reused. Throws NotFoundException when the template cannot be
   * resolved by id or name.
   */
  async sendTemplate(sessionId: string, dto: SendTemplateMessageDto): Promise<MessageResponseDto> {
    const template = await this.templateService.resolve(sessionId, {
      templateId: dto.templateId,
      templateName: dto.templateName,
    });

    const vars = dto.vars ?? {};
    const segments = [template.header, template.body, template.footer]
      .filter((segment): segment is string => segment != null && segment.length > 0)
      .map(segment => renderTemplate(segment, vars));
    const text = segments.join('\n\n');

    return this.sendText(sessionId, { chatId: dto.chatId, text });
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'image',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendImageMessage(dto.chatId, media);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'video',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendVideoMessage(dto.chatId, media);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async sendAudio(sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    // Voice notes need a real audio codec; default to ogg/opus when the caller omits a mimetype so the
    // wire message and the persisted record agree. Resolved BEFORE buildMediaInput so its base64
    // mimetype guard sees the effective type. buildMediaInput itself stays generic (shared by all media).
    const audioDto = dto.ptt && !dto.mimetype ? { ...dto, mimetype: 'audio/ogg; codecs=opus' } : dto;
    const media = this.buildMediaInput(audioDto);
    media.ptt = dto.ptt;

    // Save message as pending BEFORE sending. A PTT send is a 'voice' note (matches inbound
    // classification, the outbound webhook echo, stats, and the dashboard), not a plain 'audio' file.
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: dto.ptt ? 'voice' : 'audio',
      metadata: {
        media: { mimetype: audioDto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendAudioMessage(dto.chatId, media);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || dto.filename || '',
      type: 'document',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendDocumentMessage(dto.chatId, media);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  /**
   * Get message history for a session
   */
  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId, from } = options;
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
      .skip(offset)
      .take(limit);

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
      query.andWhere('message.from IN (:...froms)', { froms: this.resolveJidCandidates(from) });
    }

    const [messages, total] = await query.getManyAndCount();
    return { messages, total };
  }

  /**
   * Expand a JID filter into every stored id that refers to the same chat/person: the literal input (so
   * an exact group/lid filter still matches), the user-part in both user dialects (`@c.us` /
   * `@s.whatsapp.net`), and every lid the resolution table maps to that phone.
   */
  private resolveJidCandidates(value: string): string[] {
    const phone = userPart(value);
    const candidates = new Set<string>([value, `${phone}@c.us`, `${phone}@s.whatsapp.net`]);
    for (const lid of this.lidMappingStore.lidsForPhone(phone)) {
      candidates.add(`${lid}@lid`);
    }
    return [...candidates];
  }

  // ========== Phase 3: Extended Messaging ==========

  async sendLocation(
    sessionId: string,
    dto: { chatId: string; latitude: number; longitude: number; description?: string; address?: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: `📍 ${dto.description || 'Location'}`,
      type: 'location',
    });

    let result: MessageResult;
    try {
      result = await engine.sendLocationMessage(dto.chatId, {
        latitude: dto.latitude,
        longitude: dto.longitude,
        description: dto.description,
        address: dto.address,
      });
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: `📇 ${dto.contactName}`,
      type: 'contact',
    });

    let result: MessageResult;
    try {
      result = await engine.sendContactMessage(dto.chatId, {
        name: dto.contactName,
        number: dto.contactNumber,
      });
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'sticker',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendStickerMessage(dto.chatId, media);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Resolve the quoted message body (best-effort) so the dashboard can render the reply preview.
    let quotedBody = '';
    try {
      const quoted = await this.messageRepository.findOne({
        where: { sessionId, waMessageId: dto.quotedMessageId },
      });
      quotedBody = quoted?.body || '';
    } catch (err) {
      this.logger.warn(`Failed to resolve quoted message ${dto.quotedMessageId}`, { error: String(err) });
    }

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.text,
      type: 'text',
      metadata: {
        quotedMessage: { id: dto.quotedMessageId, body: quotedBody },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.replyToMessage(dto.chatId, dto.quotedMessageId, dto.text);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    return this.persistSentState(message, result);
  }

  async forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.toChatId,
      body: '[Forwarded]',
      type: 'forward',
    });

    let result: MessageResult;
    try {
      result = await engine.forwardMessage(dto.fromChatId, dto.toChatId, dto.messageId);
    } catch (error) {
      await this.saveFailedMessage(message);
      throw this.toClientFacingError(error);
    }
    // persistSentState preserves the empty-id rule: a forward whose engine couldn't recover the sent
    // copy's id leaves waMessageId NULL so no ack mis-matches it.
    return this.persistSentState(message, result);
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

  /**
   * Save outgoing message to database.
   * When called before sending, creates a record with PENDING status; bulk send reuses this after a
   * successful send (status SENT) so batch messages are persisted like single sends.
   */
  async saveOutgoingMessage(
    sessionId: string,
    data: {
      waMessageId?: string;
      chatId: string;
      body?: string;
      type: string;
      timestamp?: number;
      status?: MessageStatus;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Message> {
    const session = await this.sessionService.findOne(sessionId);
    const message = this.messageRepository.create({
      sessionId,
      waMessageId: data.waMessageId,
      chatId: data.chatId,
      from: session?.phone || 'me',
      to: data.chatId,
      body: data.body,
      type: data.type,
      direction: MessageDirection.OUTGOING,
      timestamp: data.timestamp,
      status: data.status ?? MessageStatus.PENDING,
      metadata: data.metadata,
    });
    return this.messageRepository.save(message);
  }

  /**
   * Persist a send as FAILED, dropping any outbound media payload first. A failed row's media base64
   * (often multi-MB) is never displayed or retried, so keeping it only bloats the messages table; the
   * mimetype/filename are kept so the row still describes what was attempted.
   */
  private async saveFailedMessage(message: Message): Promise<void> {
    const media = (message.metadata as { media?: { data?: unknown } } | undefined)?.media;
    if (media) {
      delete media.data;
    }
    message.status = MessageStatus.FAILED;
    await this.messageRepository.save(message);
  }

  /**
   * Persist the SENT state AFTER the engine has already accepted the message. The send already
   * succeeded, so a failure to write the SENT row must NOT be surfaced as a send failure — a transient
   * DB fault would otherwise mark a delivered message permanently FAILED and (for text) fire
   * `message:failed`. Log and return success instead.
   */
  private async persistSentState(message: Message, result: MessageResult): Promise<MessageResponseDto> {
    // A forward whose engine couldn't recover the sent copy's id returns an empty id — leave waMessageId
    // unset (NULL) so no ack mis-matches it. Every other send path carries a real id.
    if (result.id) message.waMessageId = result.id;
    message.status = MessageStatus.SENT;
    message.timestamp = result.timestamp;
    try {
      await this.messageRepository.save(message);
    } catch (persistError) {
      this.logger.warn(`Persisting SENT state failed after a successful send (id=${result.id})`, {
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
    return { messageId: result.id, timestamp: result.timestamp };
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
   */
  async getChatHistory(sessionId: string, chatId: string, limit = 50, includeMedia = false, deep = false) {
    const engine = this.getEngine(sessionId);
    const ceiling = deep ? MessageService.MAX_DEEP_CHAT_HISTORY_LIMIT : MessageService.MAX_CHAT_HISTORY_LIMIT;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), ceiling) : 50;
    return engine.getChatHistory(chatId, safeLimit, deep ? false : includeMedia);
  }

  // ========== Delete Message ==========

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

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`);
    }
    return engine;
  }

  /**
   * Humanising delay: show the engine's typing indicator and pause for a length-scaled, jittered
   * interval before the real send, so automated single sends don't look instantaneous (anti-ban).
   * ON by default — set `SIMULATE_TYPING=false` to disable. Engine-agnostic (goes through
   * `sendChatState`) and strictly best-effort — it never throws and never blocks the send if presence
   * fails or the engine has no presence concept. `SIMULATE_TYPING_MAX_MS` (default 5000) caps the pause.
   * Note: this covers single sends only; bulk sends use their own `delayBetweenMessages` throttle.
   */
  private async simulateTypingIfEnabled(engine: IWhatsAppEngine, chatId: string, text: string): Promise<void> {
    if (process.env.SIMULATE_TYPING === 'false') return;
    try {
      await engine.sendChatState(chatId, 'typing');
      const maxMs = Number(process.env.SIMULATE_TYPING_MAX_MS) || 5000;
      const planned = Math.min(maxMs, 500 + text.length * 45);
      const jittered = Math.round(planned * (0.85 + Math.random() * 0.3)); // ±15% so it isn't metronomic
      await new Promise(resolve => setTimeout(resolve, jittered));
    } catch (error) {
      this.logger.warn(`simulateTyping skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Map a blocked outbound media fetch (SSRF guard) to an HTTP 400 so a
   * caller-supplied internal/unsafe URL returns a client error instead of a 500.
   * All other errors pass through unchanged.
   */
  private toClientFacingError(error: unknown): unknown {
    if (error instanceof SsrfBlockedError) {
      return new BadRequestException(error.message);
    }
    return error;
  }

  private buildMediaInput(dto: SendMediaMessageDto): MediaInput {
    if (!dto.url && !dto.base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }

    if (dto.base64 && !dto.mimetype) {
      throw new BadRequestException('mimetype is required when using base64 data');
    }

    // Bound an outbound base64 payload to the same byte cap as URL/inbound media, before it is
    // persisted or handed to the engine. URL media is already capped while streaming.
    assertBase64WithinMediaCap(dto.base64);

    return {
      mimetype: dto.mimetype || 'application/octet-stream',
      data: dto.url || dto.base64!,
      filename: dto.filename,
      caption: dto.caption,
      mentions: dto.mentions,
    };
  }
}
