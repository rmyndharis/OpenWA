import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { userPart } from '../../engine/identity/wa-id';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

export interface GetMessagesOptions {
  chatId?: string;
  /** Filter by sender. A phone matches stored `@c.us`/`@s.whatsapp.net` ids AND any lid resolving to it. */
  from?: string;
  limit?: number;
  offset?: number;
}

/**
 * Outbound sends are executed directly against the WhatsApp engine, not via a BullMQ queue.
 *
 * The engine is single-threaded per session (a Puppeteer page for the whatsapp-web.js adapter, a
 * single socket for Baileys) and is therefore itself the serialization point for that session's
 * outbound traffic. Routing sends through a queue would add request latency and a Redis hard
 * dependency to the hot path for no throughput benefit — the engine cannot go faster than it
 * already does. BullMQ is reserved for genuine side-effects that benefit from durable
 * retry/back-pressure (webhook delivery, integration ingress); see `QUEUE_NAMES` in
 * `queue-names.ts`, which intentionally defines no MESSAGE queue.
 *
 * Backpressure is applied at the edges instead: bulk sends self-throttle via
 * `delayBetweenMessages` (default 3s) and a per-process concurrent-batch cap (see
 * `BulkMessageService`), and the global throttler enforces per-key rate limits.
 */
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
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'text', dto);

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
      // The SEND itself failed — mark FAILED + fire message:failed (a post-send persistence fault is
      // handled separately by persistSentState and must NOT land here).
      return this.failSend(sessionId, 'text', message, finalDto, error);
    }

    // Note: the `message:sent` hook is emitted solely by SessionService.onMessageCreate (engine
    // `message_create`) with a consistent IncomingMessage payload for ALL sends (text, media,
    // and phone-composed), so it is intentionally not fired here to avoid a double dispatch.
    return this.persistSentState(message, result);
  }

  /**
   * Run the pre-send `message:sending` plugin gate for one outbound message and return the
   * (possibly plugin-modified) input, or throw BadRequestException if a plugin blocked the send.
   * Centralised so EVERY public sender — text, media, and extended (location/contact/poll/sticker/
   * reply/forward) — passes through the same moderation chokepoint, instead of only `sendText`.
   */
  private async applySendingGate<T extends object>(sessionId: string, type: string, input: T): Promise<T> {
    const { continue: shouldContinue, data: hookData } = await this.hookManager.execute(
      'message:sending',
      { sessionId, input, type },
      { sessionId, source: 'MessageService' },
    );
    if (!shouldContinue) {
      throw new BadRequestException('Message sending blocked by plugin');
    }
    // Use the potentially plugin-modified input.
    return (hookData as { input: T }).input;
  }

  /**
   * Mark a send as FAILED, fire the `message:failed` plugin hook, then throw a client-facing error.
   * Centralised so failure notifications cover every sender (previously only `sendText` fired
   * `message:failed`; media/extended sends failed silently to plugins). The post-send persistence-fault
   * path (persistSentState) deliberately does NOT route here — a message the engine already accepted
   * must never be reported as a send failure.
   */
  private async failSend(
    sessionId: string,
    type: string,
    message: Message,
    input: unknown,
    error: unknown,
  ): Promise<never> {
    await this.saveFailedMessage(message);
    // Sanitize the hook payload: an SSRF block's raw .message names the resolved internal address
    // (a recon/DNS-rebind oracle) — the client-facing throw below already maps it to a generic
    // message via toClientFacingError, and the message:failed hook must not expose more than the
    // client sees. Now that every media/extended sender routes here, this is the chokepoint that
    // keeps SSRF detail out of plugin hands (bulk does the same via sanitizeBatchError).
    const hookError =
      error instanceof SsrfBlockedError
        ? SSRF_BLOCKED_CLIENT_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error);
    await this.hookManager.execute(
      'message:failed',
      { sessionId, error: hookError, input, type },
      { sessionId, source: 'MessageService' },
    );
    throw this.toClientFacingError(error);
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
    const finalDto = await this.applySendingGate(sessionId, 'image', dto);
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(finalDto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.caption || '',
      type: 'image',
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: finalDto.base64 || finalDto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendImageMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, 'image', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'video', dto);
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(finalDto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.caption || '',
      type: 'video',
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: finalDto.base64 || finalDto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendVideoMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, 'video', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendAudio(sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
    // Label a PTT send 'voice' in the gate (not 'audio') so message:sending, message:failed, and the
    // persisted row all carry the same type for one outbound voice note — failSend and the saved row
    // already use `finalDto.ptt ? 'voice' : 'audio'`.
    const finalDto = await this.applySendingGate(sessionId, dto.ptt ? 'voice' : 'audio', dto);
    const engine = this.getEngine(sessionId);
    // Voice notes need a real audio codec; default to ogg/opus when the caller omits a mimetype so the
    // wire message and the persisted record agree. Resolved BEFORE buildMediaInput so its base64
    // mimetype guard sees the effective type. buildMediaInput itself stays generic (shared by all media).
    const audioDto =
      finalDto.ptt && !finalDto.mimetype ? { ...finalDto, mimetype: 'audio/ogg; codecs=opus' } : finalDto;
    const media = this.buildMediaInput(audioDto);
    media.ptt = finalDto.ptt;

    // Save message as pending BEFORE sending. A PTT send is a 'voice' note (matches inbound
    // classification, the outbound webhook echo, stats, and the dashboard), not a plain 'audio' file.
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      type: finalDto.ptt ? 'voice' : 'audio',
      metadata: {
        media: { mimetype: audioDto.mimetype, filename: finalDto.filename, data: finalDto.base64 || finalDto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendAudioMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, finalDto.ptt ? 'voice' : 'audio', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'document', dto);
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(finalDto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.caption || finalDto.filename || '',
      type: 'document',
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: finalDto.base64 || finalDto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendDocumentMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, 'document', message, finalDto, error);
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
    const finalDto = await this.applySendingGate(sessionId, 'location', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: `📍 ${finalDto.description || 'Location'}`,
      type: 'location',
    });

    let result: MessageResult;
    try {
      result = await engine.sendLocationMessage(finalDto.chatId, {
        latitude: finalDto.latitude,
        longitude: finalDto.longitude,
        description: finalDto.description,
        address: finalDto.address,
      });
    } catch (error) {
      return this.failSend(sessionId, 'location', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string },
  ): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'contact', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: `📇 ${finalDto.contactName}`,
      type: 'contact',
    });

    let result: MessageResult;
    try {
      result = await engine.sendContactMessage(finalDto.chatId, {
        name: finalDto.contactName,
        number: finalDto.contactNumber,
      });
    } catch (error) {
      return this.failSend(sessionId, 'contact', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendPoll(
    sessionId: string,
    dto: { chatId: string; name: string; options: string[]; allowMultipleAnswers?: boolean },
  ): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'poll', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending. A poll has no plain-text body, so store the
    // question — that keeps the message history readable.
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: `📊 ${finalDto.name}`,
      type: 'poll',
    });

    let result: MessageResult;
    try {
      result = await engine.sendPollMessage(finalDto.chatId, {
        name: finalDto.name,
        options: finalDto.options,
        allowMultipleAnswers: finalDto.allowMultipleAnswers === true,
      });
    } catch (error) {
      return this.failSend(sessionId, 'poll', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'sticker', dto);
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(finalDto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      type: 'sticker',
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: finalDto.base64 || finalDto.url },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.sendStickerMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, 'sticker', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'reply', dto);
    const engine = this.getEngine(sessionId);

    // Resolve the quoted message body (best-effort) so the dashboard can render the reply preview.
    let quotedBody = '';
    try {
      const quoted = await this.messageRepository.findOne({
        where: { sessionId, waMessageId: finalDto.quotedMessageId },
      });
      quotedBody = quoted?.body || '';
    } catch (err) {
      this.logger.warn(`Failed to resolve quoted message ${finalDto.quotedMessageId}`, { error: String(err) });
    }

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
      metadata: {
        quotedMessage: { id: finalDto.quotedMessageId, body: quotedBody },
      },
    });

    let result: MessageResult;
    try {
      result = await engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text);
    } catch (error) {
      return this.failSend(sessionId, 'reply', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'forward', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.toChatId,
      body: '[Forwarded]',
      type: 'forward',
    });

    let result: MessageResult;
    try {
      result = await engine.forwardMessage(finalDto.fromChatId, finalDto.toChatId, finalDto.messageId);
    } catch (error) {
      return this.failSend(sessionId, 'forward', message, finalDto, error);
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
    const saved = await this.messageRepository.save(message);
    // Fire-and-forget: a plugin handler must never break the send path. The built-in FTS search provider
    // is DB-synced and does NOT consume this; it exists for plugin providers (Spec 2) + general use.
    void this.hookManager
      .execute('message:persisted', { sessionId, message: saved }, { sessionId, source: 'MessageService' })
      .catch(() => undefined);
    return saved;
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
    const { simulateTyping, simulateTypingMaxMs } = resolveFeatureFlags(this.configService);
    if (!simulateTyping) return;
    try {
      await engine.sendChatState(chatId, 'typing');
      const maxMs = simulateTypingMaxMs;
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
   * The raw guard message names the resolved internal IP (a recon/DNS-rebind oracle), so return a
   * generic message to the client and keep the detail in the server log only. Others pass through.
   */
  private toClientFacingError(error: unknown): unknown {
    if (error instanceof SsrfBlockedError) {
      this.logger.warn(`Outbound media fetch blocked by SSRF guard: ${error.message}`);
      return new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
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
      // base64 wins over url when both are present: it is the explicit local payload, and a stale
      // `url` (e.g. a Swagger/example default left in the body) must not be fetched in its place.
      // Aligns the send selection with the base64-first persisted metadata and the url field's
      // `@ValidateIf((o) => !o.base64)` (which skips @IsUrl when base64 is present) — #670.
      data: dto.base64 || dto.url!,
      filename: dto.filename,
      caption: dto.caption,
      mentions: dto.mentions,
    };
  }
}
