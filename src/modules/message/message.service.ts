import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { MediaInput, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { renderTemplate } from '../../common/utils/template-render';
import { createLogger } from '../../common/services/logger.service';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';

export interface GetMessagesOptions {
  chatId?: string;
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

    try {
      const result = await engine.sendTextMessage(finalDto.chatId, finalDto.text);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      // Note: the `message:sent` hook is emitted solely by SessionService.onMessageCreate (engine
      // `message_create`) with a consistent IncomingMessage payload for ALL sends (text, media,
      // and phone-composed), so it is intentionally not fired here to avoid a double dispatch.
      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      // Mark as failed
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);

      // Execute hook on failure
      await this.hookManager.execute(
        'message:failed',
        { sessionId, error: error instanceof Error ? error.message : String(error), input: finalDto },
        { sessionId, source: 'MessageService' },
      );

      throw error;
    }
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

    try {
      const result = await engine.sendImageMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
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

    try {
      const result = await engine.sendVideoMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
  }

  async sendAudio(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'audio',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    try {
      const result = await engine.sendAudioMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.filename || '',
      type: 'document',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
      },
    });

    try {
      const result = await engine.sendDocumentMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
  }

  /**
   * Get message history for a session
   */
  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId } = options;
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
      query.andWhere('message.chatId = :chatId', { chatId });
    }

    const [messages, total] = await query.getManyAndCount();
    return { messages, total };
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

    try {
      const result = await engine.sendLocationMessage(dto.chatId, {
        latitude: dto.latitude,
        longitude: dto.longitude,
        description: dto.description,
        address: dto.address,
      });

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
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

    try {
      const result = await engine.sendContactMessage(dto.chatId, {
        name: dto.contactName,
        number: dto.contactNumber,
      });

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
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

    try {
      const result = await engine.sendStickerMessage(dto.chatId, media);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
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

    try {
      const result = await engine.replyToMessage(dto.chatId, dto.quotedMessageId, dto.text);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
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

    try {
      const result = await engine.forwardMessage(dto.fromChatId, dto.toChatId, dto.messageId);

      // Update with actual WhatsApp message ID and status. A forward whose engine could not recover the
      // sent copy's real id returns an empty id — leave waMessageId unset (NULL) so no ack mis-matches it.
      if (result.id) {
        message.waMessageId = result.id;
      }
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);
      throw this.toClientFacingError(error);
    }
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

  /**
   * Fetch chat history live from WhatsApp (bypasses local DB).
   * Returns the most recent `limit` messages for the given chat.
   * When `includeMedia` is true, downloads media (base64) for messages that have it.
   *
   * `limit` is clamped to [1, 100] (and falls back to 50 for non-finite input) so a
   * caller cannot ask the engine to fetch an unbounded number of messages.
   */
  async getChatHistory(sessionId: string, chatId: string, limit = 50, includeMedia = false) {
    const engine = this.getEngine(sessionId);
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MessageService.MAX_CHAT_HISTORY_LIMIT)
      : 50;
    return engine.getChatHistory(chatId, safeLimit, includeMedia);
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

    return {
      mimetype: dto.mimetype || 'application/octet-stream',
      data: dto.url || dto.base64!,
      filename: dto.filename,
      caption: dto.caption,
    };
  }
}
