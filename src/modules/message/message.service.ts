import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, MessageResponseDto } from './dto';
import { MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';
import { MessageNotSentError } from '../../engine/errors/message-not-sent.error';

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

  /**
   * A message WhatsApp would not send is the caller's problem, not a server fault: the number may not be
   * registered, or the chat id may be malformed. Answer 400 with the reason rather than letting it surface
   * as a bare 500, which tells the caller nothing about what to change.
   */
  private toHttpError(error: unknown): unknown {
    return error instanceof MessageNotSentError ? new BadRequestException(error.message) : error;
  }

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

    try {
      const result = await engine.sendTextMessage(finalDto.chatId, finalDto.text);

      // Update with actual WhatsApp message ID and status
      message.waMessageId = result.id;
      message.status = MessageStatus.SENT;
      message.timestamp = result.timestamp;
      await this.messageRepository.save(message);

      // Execute hook after successful send
      await this.hookManager.execute(
        'message:sent',
        { sessionId, result, input: finalDto },
        { sessionId, source: 'MessageService' },
      );

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

      throw this.toHttpError(error);
    }
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'image',
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
      throw this.toHttpError(error);
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
      throw this.toHttpError(error);
    }
  }

  async sendAudio(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'audio',
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
      throw this.toHttpError(error);
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
      throw this.toHttpError(error);
    }
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
      throw this.toHttpError(error);
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
      throw this.toHttpError(error);
    }
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'sticker',
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
      throw this.toHttpError(error);
    }
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.text,
      type: 'text',
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
      throw this.toHttpError(error);
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
      throw this.toHttpError(error);
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
    const engine = this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  // ========== Delete Message ==========

  async deleteMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; forEveryone?: boolean },
  ): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);
  }

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`);
    }
    return engine;
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
