import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, MessageResponseDto } from './dto';
import { IWhatsAppEngine, MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';

/** Result returned by every engine send call. */
interface EngineSendResult {
  id: string;
  timestamp: number;
}

/** Optional hook callbacks fired around a dispatch (only sendText uses them). */
interface DispatchHooks {
  onSent?: (result: EngineSendResult) => Promise<unknown>;
  onFailed?: (error: unknown) => Promise<unknown>;
}

export interface GetMessagesOptions {
  chatId?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly hookManager: HookManager,
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

    return this.dispatchSend(
      sessionId,
      { chatId: finalDto.chatId, body: finalDto.text, type: 'text' },
      engine => engine.sendTextMessage(finalDto.chatId, finalDto.text),
      {
        onSent: result =>
          this.hookManager.execute(
            'message:sent',
            { sessionId, result, input: finalDto },
            { sessionId, source: 'MessageService' },
          ),
        onFailed: error =>
          this.hookManager.execute(
            'message:failed',
            { sessionId, error: error instanceof Error ? error.message : String(error), input: finalDto },
            { sessionId, source: 'MessageService' },
          ),
      },
    );
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const media = this.buildMediaInput(dto);
    return this.dispatchSend(sessionId, { chatId: dto.chatId, body: dto.caption || '', type: 'image' }, engine =>
      engine.sendImageMessage(dto.chatId, media),
    );
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const media = this.buildMediaInput(dto);
    return this.dispatchSend(sessionId, { chatId: dto.chatId, body: dto.caption || '', type: 'video' }, engine =>
      engine.sendVideoMessage(dto.chatId, media),
    );
  }

  async sendAudio(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const media = this.buildMediaInput(dto);
    return this.dispatchSend(sessionId, { chatId: dto.chatId, type: 'audio' }, engine =>
      engine.sendAudioMessage(dto.chatId, media),
    );
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const media = this.buildMediaInput(dto);
    return this.dispatchSend(sessionId, { chatId: dto.chatId, body: dto.filename || '', type: 'document' }, engine =>
      engine.sendDocumentMessage(dto.chatId, media),
    );
  }

  /**
   * Get message history for a session
   */
  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId, limit = 50, offset = 0 } = options;

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
    return this.dispatchSend(
      sessionId,
      { chatId: dto.chatId, body: `📍 ${dto.description || 'Location'}`, type: 'location' },
      engine =>
        engine.sendLocationMessage(dto.chatId, {
          latitude: dto.latitude,
          longitude: dto.longitude,
          description: dto.description,
          address: dto.address,
        }),
    );
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string },
  ): Promise<MessageResponseDto> {
    return this.dispatchSend(
      sessionId,
      { chatId: dto.chatId, body: `📇 ${dto.contactName}`, type: 'contact' },
      engine => engine.sendContactMessage(dto.chatId, { name: dto.contactName, number: dto.contactNumber }),
    );
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const media = this.buildMediaInput(dto);
    return this.dispatchSend(sessionId, { chatId: dto.chatId, type: 'sticker' }, engine =>
      engine.sendStickerMessage(dto.chatId, media),
    );
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    return this.dispatchSend(sessionId, { chatId: dto.chatId, body: dto.text, type: 'text' }, engine =>
      engine.replyToMessage(dto.chatId, dto.quotedMessageId, dto.text),
    );
  }

  async forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    return this.dispatchSend(sessionId, { chatId: dto.toChatId, body: '[Forwarded]', type: 'forward' }, engine =>
      engine.forwardMessage(dto.fromChatId, dto.toChatId, dto.messageId),
    );
  }

  /**
   * Shared send pipeline: save PENDING → call engine → mark SENT (+ optional
   * onSent hook), or mark FAILED (+ optional onFailed hook) and rethrow.
   * Behavior identical across all public send methods.
   */
  private async dispatchSend(
    sessionId: string,
    meta: { chatId: string; body?: string; type: string },
    send: (engine: IWhatsAppEngine) => Promise<EngineSendResult>,
    hooks?: DispatchHooks,
  ): Promise<MessageResponseDto> {
    const engine = await this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, meta);

    try {
      const result = await send(engine);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      if (hooks?.onSent) {
        await hooks.onSent(result);
      }

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      message.status = MessageStatus.FAILED;
      await this.messageRepository.save(message);

      if (hooks?.onFailed) {
        await hooks.onFailed(error);
      }

      throw error;
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
   * When called before sending, creates a record with PENDING status.
   */
  private async saveOutgoingMessage(
    sessionId: string,
    data: {
      waMessageId?: string;
      chatId: string;
      body?: string;
      type: string;
      timestamp?: number;
      status?: MessageStatus;
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
    });
    return this.messageRepository.save(message);
  }

  // ========== Phase 3: Reactions ==========

  async reactToMessage(sessionId: string, dto: { chatId: string; messageId: string; emoji: string }): Promise<void> {
    const engine = await this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = await this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  // ========== Delete Message ==========

  async deleteMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; forEveryone?: boolean },
  ): Promise<void> {
    const engine = await this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);
  }

  private getEngine(sessionId: string): Promise<IWhatsAppEngine> {
    // Owner-aware (Tier 4): in cluster mode this surfaces a 409 naming the node
    // that owns the session instead of a generic "not active".
    return this.sessionService.resolveEngine(sessionId);
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
