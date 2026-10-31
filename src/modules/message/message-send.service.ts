import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { markNothingSent } from '../../common/errors/engine-not-sent.error';
import { mergeSentMetadata, updateMessageMetadata } from './message-metadata';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, QueryDeepPartialEntity } from 'typeorm';
import { SessionService } from '../session/session.service';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { assertBase64WithinMediaCap, resolveMediaBody, stripBase64DataUri } from './media-cap.util';
import { LINK_PREVIEW_THUMBNAIL_MAX_BYTES } from '../../common/media/load-remote-media';
import { isMediaUrl, MEDIA_URL_MESSAGE } from '../../common/media/media-url';
import {
  CustomLinkPreview,
  MediaInput,
  IWhatsAppEngine,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager, applySendingGate } from '../../core/hooks';
import { SendPacingService, SettleAdmission, countsTowardSendBreaker } from './send-pacing.service';
import { TemplateService } from '../template/template.service';
import { renderedLength, renderTemplate, TemplateRenderError } from '../../common/utils/template-render';
import { createLogger } from '../../common/services/logger.service';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { captureSessionWrites, SessionWriteScope } from '../../common/utils/session-write-scope';

/** Default cap on a rendered template's final text; overridable via TEMPLATE_RENDER_MAX_CHARS. */
export const DEFAULT_TEMPLATE_RENDER_MAX_CHARS = 64 * 1024;

/**
 * True when this write's media is only a remote-URL pointer (a URL-based send, whose bytes the
 * engine fetches and discards). Merging such metadata onto an echo row would REPLACE bytes the
 * gateway already downloaded — wwjs enriches its own-send echo with the real payload — leaving a
 * row that renders as a bare marker and that the archive cannot use.
 */
function isUrlPointerMetadata(metadata: Record<string, unknown> | undefined): boolean {
  const data = (metadata as { media?: { data?: unknown } } | undefined)?.media?.data;
  return typeof data === 'string' && /^https?:\/\//i.test(data);
}

/** Persistence payload for one outbound row written by {@link MessageSendService.saveOutgoingMessage}. */
export interface SaveOutgoingMessageData {
  waMessageId?: string;
  chatId: string;
  body?: string;
  type: string;
  timestamp?: number;
  status?: MessageStatus;
  metadata?: Record<string, unknown>;
  /**
   * Quoted id for a send that quotes something. Folded into `metadata.quotedMessage` at the shared
   * persist rather than by each sender, so the nine send paths and `reply()` record one shape: a row
   * that quoted a message but records nothing is simply wrong history, and the dashboard reads this
   * key to render the quote preview. The quoted body is looked up there too, so a sender does not
   * have to remember; a quoted row with no text of its own (a caption-less image, say) still yields
   * '', which the preview renders as an empty box.
   */
  quotedMessageId?: string;
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
 * `BulkMessageService`), and the global throttler enforces per-route, per-client-IP rate limits.
 */
@Injectable()
export class MessageSendService {
  private readonly logger = createLogger('MessageSend');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly engines: EngineRegistry,
    private readonly hookManager: HookManager,
    private readonly templateService: TemplateService,
    // Required, not @Optional: a missing pacing service would silently mean "no pacing", which is
    // the one failure mode this feature must not have. The service itself no-ops when disabled.
    private readonly pacing: SendPacingService,
    @Optional()
    private readonly configService?: ConfigService,
    // Optional so standalone constructions keep working; absent means outbound media is never
    // archived — the inline row copy and the read endpoint are unaffected either way.
    @Optional()
    private readonly chatMediaArchive?: ChatMediaArchiveService,
    // Optional for the same reason; absent means a quote is matched on the chat's phone and
    // literal forms only, never on its lid.
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    // Optional for the same reason; absent means a quote is read from stored rows only, so a reply
    // sent while the quoted message's `message:received` hooks still run stores an empty quote.
    @Optional()
    private readonly messageProjector?: MessageProjector,
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    // Asking to suppress the preview AND to attach one is a contradiction, and guessing which half
    // the caller meant would send a message they did not ask for either way.
    if (dto.linkPreview === false && dto.customLinkPreview) {
      throw new BadRequestException('linkPreview: false cannot be combined with customLinkPreview');
    }
    const {
      message,
      finalDto,
      engine,
      prepared: customPreview,
    } = await this.applySendingGate(
      sessionId,
      'text',
      dto,
      finalDto => ({
        chatId: finalDto.chatId,
        body: finalDto.text,
        type: 'text',
        quotedMessageId: finalDto.quotedMessageId,
      }),
      (d: SendTextMessageDto) => this.buildCustomPreview(d.customLinkPreview),
    );

    // Humanising "typing…" pause before the actual send (anti-automation signal). On by default;
    // SIMULATE_TYPING=false disables it.
    await this.simulateTypingIfEnabled(engine, finalDto.chatId, finalDto.text);

    let result: MessageResult;
    try {
      // The call is widened ONLY as far as the caller actually asked. A send with neither mentions
      // nor a preview choice keeps its two-argument shape, and one with mentions alone keeps its
      // three — trailing `undefined`s would be harmless to the engines but would rewrite the call
      // shape of every existing send for no behavioural gain.
      const { linkPreview, quotedMessageId } = finalDto;
      if (linkPreview !== undefined || customPreview || quotedMessageId) {
        result = await engine.sendTextMessage(finalDto.chatId, finalDto.text, finalDto.mentions, {
          ...(linkPreview === undefined ? {} : { linkPreview }),
          ...(customPreview ? { customPreview } : {}),
          ...(quotedMessageId ? { quotedMessageId } : {}),
        });
      } else if (finalDto.mentions?.length) {
        result = await engine.sendTextMessage(finalDto.chatId, finalDto.text, finalDto.mentions);
      } else {
        result = await engine.sendTextMessage(finalDto.chatId, finalDto.text);
      }
    } catch (error) {
      // The SEND itself failed — mark FAILED + fire message:failed (a post-send persistence fault is
      // handled separately by persistSentState and must NOT land here).
      return this.failSend(sessionId, 'text', message, finalDto, error);
    }

    // Note: the `message:sent` hook is emitted solely by the onMessageCreate wiring in
    // SessionEngineLifecycle (engine `message_create`, handled by MessageProjector) with a
    // consistent IncomingMessage payload for ALL sends (text, media,
    // and phone-composed), so it is intentionally not fired here to avoid a double dispatch.
    return this.persistSentState(message, result);
  }

  /**
   * Run the pre-send `message:sending` plugin gate for one outbound message and return the
   * (possibly plugin-modified) input with the session's engine, prepared data and durable PENDING
   * row, or throw BadRequestException if a plugin blocked the send.
   * Centralised so EVERY public sender in this class — text, media, extended (location/contact/
   * poll/sticker/reply/forward) — passes through the same moderation chokepoint, instead of only
   * `sendText`. The edit path is gated by the twin method in MessageService (the query side of
   * the send/query split), on the same core/hooks/sending-gate implementation shared with
   * StatusService.
   */
  private async applySendingGate<T extends object, P = undefined>(
    sessionId: string,
    type: string,
    input: T,
    buildPending: (finalDto: T, prepared: P) => SaveOutgoingMessageData | Promise<SaveOutgoingMessageData>,
    prepare?: (finalDto: T) => P,
  ): Promise<{ finalDto: T; engine: IWhatsAppEngine; prepared: P; message: Message }> {
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
    const lifetime = captureSessionWrites(
      this.messageRepository.manager?.connection ?? this.messageRepository,
      sessionId,
    );
    let release: SettleAdmission | undefined;
    // Everything a sender does before its PENDING row is written runs in here (the plugin gate, the
    // engine lookup, preparation and initial persistence), so a failure hands its pacing admission back: with no
    // row it never counts, and holding it would refuse the caller's next send near the cap.
    let persisted = false;
    try {
      release = await this.pacing.assertSendAllowed(sessionId, target.chatId ?? target.toChatId, {
        whilePreparing: true,
      });
      if (release) lifetime.onRetire(release);
      lifetime.assertCurrent();
      const finalDto = await applySendingGate(this.hookManager, sessionId, type, input, 'MessageService');
      lifetime.assertCurrent();
      const engine = this.getEngine(sessionId);
      const prepared = prepare?.(finalDto) as P;
      const message = await this.saveOutgoingMessage(sessionId, await buildPending(finalDto, prepared), lifetime);
      lifetime.assertCurrent();
      persisted = true;
      return { finalDto, engine, prepared, message };
    } finally {
      release?.(persisted);
      lifetime.close();
    }
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
    try {
      // Only failures that say something about the account's standing feed the breaker: adapters also
      // raise client-fault and engine-state errors from inside this call (a blocked media URL, an
      // unsupported capability, a disconnected socket), and counting those let a client sending bad
      // requests trip the breaker on a healthy session.
      if (countsTowardSendBreaker(error)) {
        this.pacing.recordSendFailure(sessionId);
        // The same classification picks the failures worth a log line. Otherwise an engine-side failure
        // leaves only Nest's generic `[ExceptionsHandler]` line, with no session, chat or message type to
        // correlate it with.
        this.logger.warn(`Send failed in the engine (${type})`, {
          sessionId,
          chatId: message.chatId,
          messageId: message.id,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          // An EnginePageError keeps the full in-page summary (stack, own properties) here only.
          ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
        });
      }
      await this.saveFailedMessage(message);
      // Sanitize the hook payload: an SSRF block's raw .message names the resolved internal address
      // (a recon/DNS-rebind oracle); the client-facing throw below already maps it to a generic
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
    } catch (failure) {
      // HTTP status alone cannot prove whether an engine accepted the message before failing.
      throw markEngineSendFailure(failure);
    }
  }

  /**
   * Resolve a stored template, render its body (with optional header/footer
   * flattened using newlines) using the supplied variables, and delegate to the
   * existing {@link sendText} path so plugin hooks, persistence, and status
   * tracking are reused. Throws NotFoundException when the identifier matches
   * nothing, BadRequestException when neither templateId nor templateName is
   * given.
   *
   * The FINAL rendered text is capped at template.renderMaxChars (default 64 KiB): caller-supplied
   * variables can inflate a small template unboundedly, so an over-cap render is rejected with a
   * 400 naming the limit rather than truncated silently or pushed to the engine/DB as-is. The length
   * is measured before anything is rendered, so a refused request never allocates the oversized text.
   */
  async sendTemplate(sessionId: string, dto: SendTemplateMessageDto): Promise<MessageResponseDto> {
    const template = await this.templateService.resolve(sessionId, {
      templateId: dto.templateId,
      templateName: dto.templateName,
    });

    const vars = dto.vars ?? {};
    const parts = [template.header, template.body, template.footer].filter(
      (segment): segment is string => segment != null && segment.length > 0,
    );
    const separator = '\n\n';

    const maxChars =
      this.configService?.get<number>('template.renderMaxChars', DEFAULT_TEMPLATE_RENDER_MAX_CHARS) ??
      DEFAULT_TEMPLATE_RENDER_MAX_CHARS;
    let text: string;
    try {
      const length =
        parts.reduce((sum, part) => sum + renderedLength(part, vars), 0) +
        separator.length * Math.max(0, parts.length - 1);
      if (length > maxChars) {
        throw new BadRequestException(
          `Rendered template is ${length} characters, over the ${maxChars}-character limit`,
        );
      }
      text = parts.map(part => renderTemplate(part, vars)).join(separator);
    } catch (error) {
      if (error instanceof TemplateRenderError) throw new BadRequestException(error.message);
      throw error;
    }

    return this.sendText(sessionId, {
      chatId: dto.chatId,
      text,
      mentions: dto.mentions,
      linkPreview: dto.linkPreview,
    });
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const {
      message,
      finalDto,
      engine,
      prepared: media,
    } = await this.applySendingGate(
      sessionId,
      'image',
      dto,
      (finalDto, media) => ({
        chatId: finalDto.chatId,
        body: finalDto.caption || '',
        type: 'image',
        quotedMessageId: finalDto.quotedMessageId,
        metadata: {
          media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
        },
      }),
      (d: SendMediaMessageDto) => this.buildMediaInput(d),
    );

    let result: MessageResult;
    try {
      result = await engine.sendImageMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, 'image', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const {
      message,
      finalDto,
      engine,
      prepared: media,
    } = await this.applySendingGate(
      sessionId,
      'video',
      dto,
      (finalDto, media) => ({
        chatId: finalDto.chatId,
        body: finalDto.caption || '',
        type: 'video',
        quotedMessageId: finalDto.quotedMessageId,
        metadata: {
          media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
        },
      }),
      (d: SendMediaMessageDto) => this.buildMediaInput(d),
    );

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
    const {
      message,
      finalDto,
      engine,
      prepared: { media },
    } = await this.applySendingGate(
      sessionId,
      dto.ptt ? 'voice' : 'audio',
      dto,
      (finalDto, { audioDto, media }) => ({
        chatId: finalDto.chatId,
        type: finalDto.ptt ? 'voice' : 'audio',
        metadata: {
          media: { mimetype: audioDto.mimetype, filename: finalDto.filename, data: media.data },
        },
        quotedMessageId: finalDto.quotedMessageId,
      }),
      (gated: SendAudioMessageDto) => {
        // Voice notes need a real audio codec; default to ogg/opus when the caller omits a mimetype so the
        // wire message and the persisted record agree. Resolved BEFORE buildMediaInput so its base64
        // mimetype guard sees the effective type. buildMediaInput itself stays generic (shared by all media).
        const audioDto = gated.ptt && !gated.mimetype ? { ...gated, mimetype: 'audio/ogg; codecs=opus' } : gated;
        const media = this.buildMediaInput(audioDto);
        media.ptt = gated.ptt;
        return { audioDto, media };
      },
    );

    let result: MessageResult;
    try {
      result = await engine.sendAudioMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, finalDto.ptt ? 'voice' : 'audio', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const {
      message,
      finalDto,
      engine,
      prepared: media,
    } = await this.applySendingGate(
      sessionId,
      'document',
      dto,
      (finalDto, media) => ({
        chatId: finalDto.chatId,
        body: finalDto.caption || finalDto.filename || '',
        type: 'document',
        quotedMessageId: finalDto.quotedMessageId,
        metadata: {
          media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
        },
      }),
      (d: SendMediaMessageDto) => this.buildMediaInput(d),
    );

    let result: MessageResult;
    try {
      result = await engine.sendDocumentMessage(finalDto.chatId, media);
    } catch (error) {
      return this.failSend(sessionId, 'document', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendLocation(
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
    const { message, finalDto, engine } = await this.applySendingGate(sessionId, 'location', dto, finalDto => ({
      chatId: finalDto.chatId,
      body: `📍 ${finalDto.description || 'Location'}`,
      type: 'location',
      quotedMessageId: finalDto.quotedMessageId,
    }));

    let result: MessageResult;
    try {
      result = await engine.sendLocationMessage(finalDto.chatId, {
        latitude: finalDto.latitude,
        longitude: finalDto.longitude,
        description: finalDto.description,
        address: finalDto.address,
        quotedMessageId: finalDto.quotedMessageId,
      });
    } catch (error) {
      return this.failSend(sessionId, 'location', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string; quotedMessageId?: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine } = await this.applySendingGate(sessionId, 'contact', dto, finalDto => ({
      chatId: finalDto.chatId,
      body: `📇 ${finalDto.contactName}`,
      type: 'contact',
      quotedMessageId: finalDto.quotedMessageId,
    }));

    let result: MessageResult;
    try {
      result = await engine.sendContactMessage(finalDto.chatId, {
        name: finalDto.contactName,
        number: finalDto.contactNumber,
        quotedMessageId: finalDto.quotedMessageId,
      });
    } catch (error) {
      return this.failSend(sessionId, 'contact', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendPoll(
    sessionId: string,
    dto: { chatId: string; name: string; options: string[]; allowMultipleAnswers?: boolean; quotedMessageId?: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine } = await this.applySendingGate(sessionId, 'poll', dto, finalDto => ({
      chatId: finalDto.chatId,
      body: `📊 ${finalDto.name}`,
      type: 'poll',
      metadata: {
        poll: {
          name: finalDto.name,
          options: [...finalDto.options],
          allowMultipleAnswers: finalDto.allowMultipleAnswers === true,
        },
      },
      quotedMessageId: finalDto.quotedMessageId,
    }));

    let result: MessageResult;
    try {
      result = await engine.sendPollMessage(finalDto.chatId, {
        name: finalDto.name,
        options: finalDto.options,
        allowMultipleAnswers: finalDto.allowMultipleAnswers === true,
        quotedMessageId: finalDto.quotedMessageId,
      });
    } catch (error) {
      return this.failSend(sessionId, 'poll', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const {
      message,
      finalDto,
      engine,
      prepared: media,
    } = await this.applySendingGate(
      sessionId,
      'sticker',
      dto,
      (finalDto, media) => ({
        chatId: finalDto.chatId,
        type: 'sticker',
        quotedMessageId: finalDto.quotedMessageId,
        metadata: {
          media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
        },
      }),
      (d: SendMediaMessageDto) => this.buildMediaInput(d),
    );

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
    dto: { chatId: string; quotedMessageId: string; text: string; mentions?: string[] },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine } = await this.applySendingGate(sessionId, 'reply', dto, async finalDto => {
      const quotedBody = await this.resolveQuotedBody(sessionId, finalDto.quotedMessageId, finalDto.chatId);
      return {
        chatId: finalDto.chatId,
        body: finalDto.text,
        type: 'text',
        metadata: {
          quotedMessage: { id: finalDto.quotedMessageId, body: quotedBody },
        },
      };
    });

    let result: MessageResult;
    try {
      // Widened only as far as the caller asked, exactly like the send path: a reply with no tags
      // keeps its three-argument shape.
      result = finalDto.mentions?.length
        ? await engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text, finalDto.mentions)
        : await engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text);
    } catch (error) {
      return this.failSend(sessionId, 'reply', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async clickButton(
    sessionId: string,
    dto: { chatId: string; messageId: string; buttonId: string; text?: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine } = await this.applySendingGate(
      sessionId,
      'click-button',
      dto,
      async finalDto => {
        const promptBody = await this.resolveQuotedBody(sessionId, finalDto.messageId, finalDto.chatId);
        return {
          chatId: finalDto.chatId,
          body: finalDto.text || finalDto.buttonId,
          type: 'text',
          metadata: {
            quotedMessage: { id: finalDto.messageId, body: promptBody },
            button: { id: finalDto.buttonId, text: finalDto.text },
          },
        };
      },
    );

    let result: MessageResult;
    try {
      result = await engine.clickButton(finalDto.chatId, finalDto.messageId, finalDto.buttonId, finalDto.text);
    } catch (error) {
      return this.failSend(sessionId, 'click-button', message, finalDto, error);
    }
    // The engine resolves the visible label from the stored prompt when the caller omitted `text`.
    // Persist that label (not the raw buttonId) so the row agrees with what went on the wire.
    if (result.body) {
      message.body = result.body;
      message.metadata = {
        ...(message.metadata ?? {}),
        button: { id: finalDto.buttonId, text: result.body },
      };
    }
    return this.persistSentState(
      message,
      result,
      result.body
        ? { body: result.body, metadata: message.metadata as QueryDeepPartialEntity<Record<string, unknown>> }
        : undefined,
    );
  }

  async forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine } = await this.applySendingGate(sessionId, 'forward', dto, finalDto => ({
      chatId: finalDto.toChatId,
      body: '[Forwarded]',
      type: 'forward',
    }));

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
   * The body of the message a send is quoting, for the dashboard's quote preview. Best-effort in
   * every direction: an id that names nothing stored (evicted, or sent from the phone before this
   * gateway saw the chat) and a read that fails both answer '', because a preview is never worth
   * failing a send over. The row is looked up by engine id within the session. A reply and a button
   * click answer a message in the chat they send into, so for them `chatId` also restricts the lookup
   * to that chat (any of its phone, lid or group forms): the pending row is saved before the engine
   * refuses a cross-chat quote, and copying a foreign body would store it under a chat a
   * chat-restricted key may use. The send routes may quote across chats, and the guard refuses a
   * chat-restricted key any quotedMessageId there, so they pass no chat. While the quoted message's
   * `message:received` hooks are still running it has no row yet, so the copy that hook chain
   * carries answers instead, under the same chat restriction.
   */
  private async resolveQuotedBody(sessionId: string, quotedMessageId: string, chatId?: string): Promise<string> {
    try {
      const store = this.lidMappingStore;
      const expanded = chatId
        ? await resolveJidCandidates(
            chatId,
            store && {
              resolveLid: lid => store.findPhoneForLid(lid),
              lidsForPhone: phone => store.findLidsForPhone(phone),
            },
          )
        : [];
      // A `message:received` hook that answers the message runs before its row is written. A hook
      // rewrite is checked for its id and chatId only, so a body that is not text quotes as ''.
      const inFlight = this.messageProjector?.inFlightInbound(sessionId, quotedMessageId);
      if (inFlight && (!chatId || inFlight.chatId === chatId || expanded.includes(inFlight.chatId))) {
        return typeof inFlight.body === 'string' ? inFlight.body : '';
      }
      const quoted = await this.messageRepository.findOne({
        where: chatId
          ? { sessionId, chatId: In([...new Set([chatId, ...expanded])]), waMessageId: quotedMessageId }
          : { sessionId, waMessageId: quotedMessageId },
      });
      return quoted?.body || '';
    } catch (err) {
      this.logger.warn(`Failed to resolve quoted message ${quotedMessageId}`, { error: String(err) });
      return '';
    }
  }

  /**
   * Save outgoing message to database.
   * When called before sending, creates a record with PENDING status; bulk send reuses this after a
   * successful send (status SENT) so batch messages are persisted like single sends.
   *
   * A caller that already knows the engine id races the own-send echo on
   * UNIQUE(sessionId, waMessageId) — only the bulk path does today, since every single send persists
   * its PENDING row before the id exists. Losing that race merges onto the echo's row rather than
   * failing, mirroring `persistSentState`: the echo carries only what the engine reported (for a
   * Baileys API send, a media-less marker), so dropping this write would lose the media payload.
   */
  async saveOutgoingMessage(
    sessionId: string,
    data: SaveOutgoingMessageData,
    lifetime?: SessionWriteScope,
  ): Promise<Message> {
    const scope =
      lifetime ?? captureSessionWrites(this.messageRepository.manager?.connection ?? this.messageRepository, sessionId);
    try {
      const session = await this.sessionService.findOne(sessionId);
      // Resolved here rather than in each sender: reply and click-button build their own
      // `metadata.quotedMessage` and never reach this branch, so every OTHER quoting sender (media,
      // location, contact, poll, quoted text) used to persist an id with an empty body and the
      // dashboard drew a blank quote box above the message.
      const quotedMessage = data.quotedMessageId
        ? { id: data.quotedMessageId, body: await this.resolveQuotedBody(sessionId, data.quotedMessageId) }
        : undefined;
      const message = this.messageRepository.create({
        sessionId,
        // An engine that sent a message but could not read its id back reports an empty id (see the
        // whatsapp-web.js adapter's `toMessageResult`). Store NULL rather than '': the
        // (sessionId, waMessageId) unique index is not partial, so a second id-less send in the same
        // session collides on '' while NULLs stay exempt — and in the bulk path that violation is
        // swallowed into a warning, losing the row silently. Normalizing at this one chokepoint covers
        // every caller instead of relying on each to remember.
        waMessageId: data.waMessageId || undefined,
        chatId: data.chatId,
        // The account's JID, the form the engines' own-send echo stores for the same message; 'me' only while the
        // session has no number to name it by.
        from: session?.phone ? `${session.phone}@c.us` : 'me',
        to: data.chatId,
        body: data.body,
        type: data.type,
        direction: MessageDirection.OUTGOING,
        timestamp: data.timestamp,
        status: data.status ?? MessageStatus.PENDING,
        metadata: quotedMessage ? { ...data.metadata, quotedMessage } : data.metadata,
      });
      // No transaction of its own: the unique violation handled below is routine (the own-send echo wins the
      // race), and on SQLite's single shared connection its rollback would discard what other callers wrote
      // while it was open, after they were told it was stored.
      const saved = await scope
        .write(() => this.messageRepository.save(message, { transaction: false }))
        .catch(async (err: unknown) => {
          const waMessageId = message.waMessageId;
          if (!waMessageId || !isUniqueViolation(err)) throw err;
          // No `status` here on purpose. The row this collides with is the own-send echo's, inserted
          // SENT, and the ack path advances it forward-only (ackStatusTransitionFrom). This write only
          // ever carries PENDING or SENT, so it can never be an upgrade: it is a no-op, or it drags a
          // DELIVERED/READ row back to SENT when an ack won the race. Leave the delivery state to the
          // one writer that owns it.
          const patch: QueryDeepPartialEntity<Message> = {
            timestamp: message.timestamp,
          };
          // Only when this write actually carries metadata worth merging: a text item must not blank
          // the echo's, and a URL pointer must not replace bytes the engine already downloaded.
          const metadata = message.metadata;
          if (metadata && !isUrlPointerMetadata(metadata)) {
            try {
              await updateMessageMetadata(this.messageRepository, { sessionId, waMessageId }, current =>
                mergeSentMetadata(current, metadata),
              );
            } catch (error) {
              if (message.status !== MessageStatus.SENT) throw error;
              this.logger.warn(`Merging sent metadata onto the echo row failed (id=${waMessageId})`, {
                error: error instanceof Error ? error.message : String(error),
              });
              // The bulk engine has already sent this item. Keep its media in an id-less SENT row
              // when the echo cannot accept it, instead of losing the only payload-bearing copy.
              return scope.write(() =>
                this.messageRepository.save(this.messageRepository.create({ ...message, waMessageId: undefined })),
              );
            }
          }
          if (message.timestamp !== undefined) await this.messageRepository.update({ sessionId, waMessageId }, patch);
          const surviving = await this.messageRepository.findOne({ where: { sessionId, waMessageId } });
          if (!surviving) throw err;
          return surviving;
        });
      this.emitPersisted(sessionId, saved);
      return saved;
    } finally {
      if (!lifetime) scope.close();
    }
  }

  // Fire-and-forget: a plugin handler must never break the send path. The built-in FTS search provider
  // is DB-synced and does NOT consume this; it exists for plugin providers (Spec 2) + general use.
  // Emitted for EVERY persisted state of an outbound row — the initial PENDING write AND each later
  // transition (SENT / FAILED / merge) — so a provider's copy never stays stuck at PENDING (#906).
  // The payload is a shallow snapshot: the same entity instance is mutated as the send progresses
  // (PENDING → SENT/FAILED), and fire-and-forget execution must still see the state at emission time.
  //
  // Outbound archiving rides the same chokepoint rather than a call at each of the four persist
  // sites: every terminal state of an outbound row passes here. Gated on SENT because a PENDING row
  // may still be deleted by the dedup merge or rewritten by the pending reaper, and a FAILED one has
  // had its payload stripped — archiving either would strand a file the row never points at.
  //
  // Hook emissions keep `source: 'MessageService'` — the string is part of the observable hook
  // contract plugins may filter on, so the send seam must not change it.
  private emitPersisted(sessionId: string, message: Message): void {
    void this.hookManager
      .execute('message:persisted', { sessionId, message: { ...message } }, { sessionId, source: 'MessageService' })
      .catch(() => undefined);
    if (message.status === MessageStatus.SENT && this.archiveOutboundEnabled) {
      void this.chatMediaArchive?.archive(message).catch(() => undefined);
    }
  }

  /** Whether media this account sent is archived too — a sub-flag of the archive itself. */
  private get archiveOutboundEnabled(): boolean {
    return this.configService?.get<boolean>('chatMedia.archiveOutbound', false) === true;
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
    const result = await this.messageRepository.update(
      { id: message.id, sessionId: message.sessionId },
      {
        status: MessageStatus.FAILED,
        metadata: message.metadata as QueryDeepPartialEntity<Record<string, unknown>>,
      },
    );
    if (!result.affected) return;
    // Reconcile the earlier PENDING emission (#906): a provider must see the terminal FAILED state.
    this.emitPersisted(message.sessionId, message);
  }

  /**
   * Persist the SENT state AFTER the engine has already accepted the message. The send already
   * succeeded, so a failure to write the SENT row must NOT be surfaced as a send failure — a transient
   * DB fault would otherwise mark a delivered message permanently FAILED and (for text) fire
   * `message:failed`. Log and return success instead.
   */
  private async persistSentState(
    message: Message,
    result: MessageResult,
    // Columns a sender changed in memory after its PENDING insert. The write below is an UPDATE of
    // fixed columns, so anything not listed here (the resolved button label, for one) is never stored.
    // `metadata` is listed only when it changed: the insert already stored it, and a base64 media
    // payload inside it would otherwise be written a second time on every send.
    changed: Pick<QueryDeepPartialEntity<Message>, 'body' | 'metadata'> = {},
  ): Promise<MessageResponseDto> {
    // A send whose engine couldn't read the sent message's id back reports an empty id — a forward that
    // can't recover the copy, or a WhatsApp Web build that renamed the id field out from under the
    // engine. Leave waMessageId unset (NULL) so no ack mis-matches it.
    // The engine accepted the message, so whatever streak the breaker was tracking is over. Recorded
    // here rather than at each call site for the same reason failSend is: one funnel, twelve senders.
    this.pacing.recordSendSuccess(message.sessionId);
    if (result.id) message.waMessageId = result.id;
    message.status = MessageStatus.SENT;
    message.timestamp = result.timestamp;
    try {
      // No transaction of its own, for the reason given at the first save of this message.
      const sent: QueryDeepPartialEntity<Message> = {
        ...changed,
        waMessageId: message.waMessageId,
        status: message.status,
        timestamp: message.timestamp,
      };
      // Guarded on the row still being PENDING, so the common write carries no metadata. A row the pending
      // reaper failed while the engine was still answering has lost its media payload and gained a marker:
      // it is written again, unguarded, with the metadata the insert stored. No row at all means the
      // session was deleted under this send.
      let updated = await this.messageRepository.update(
        { id: message.id, sessionId: message.sessionId, status: MessageStatus.PENDING },
        sent,
      );
      if (!updated.affected) {
        updated = await this.messageRepository.update(
          { id: message.id, sessionId: message.sessionId },
          { ...sent, metadata: message.metadata as QueryDeepPartialEntity<Record<string, unknown>> },
        );
      }
      if (!updated.affected) return { messageId: result.id, timestamp: result.timestamp };
      // Reconcile the earlier PENDING emission with the finalized row (#906).
      this.emitPersisted(message.sessionId, message);
    } catch (persistError) {
      if (result.id && isUniqueViolation(persistError)) {
        // The engine's own-send echo (onMessageCreate) won the race and already persisted a row with
        // this waMessageId. That row carries only what the engine reported — for a Baileys API send,
        // a media-less marker — so merge our SENT state AND our metadata (the actual media payload)
        // onto it BEFORE dropping this redundant PENDING row, or the payload-bearing row is the one
        // that gets deleted and the media is gone after a reload.
        // Best-effort throughout: the send itself already succeeded.
        this.logger.debug(
          `Send echo already persisted ${result.id}; merging state and dropping the redundant pending row`,
          {
            messageId: message.id,
          },
        );
        // `status` is deliberately absent: the echo row is already SENT, and an ack that landed
        // first has advanced it further. Writing SENT here would undo that. See the sibling merge
        // in saveOutgoingMessage.
        const patch: QueryDeepPartialEntity<Message> = { timestamp: result.timestamp };
        const metadata = message.metadata;
        let metadataMerged = true;
        if (metadata && !isUrlPointerMetadata(metadata)) {
          await updateMessageMetadata(
            this.messageRepository,
            { sessionId: message.sessionId, waMessageId: result.id },
            current => mergeSentMetadata(current, metadata),
          ).catch(err => {
            metadataMerged = false;
            this.logger.warn(`Merging media onto the echo-persisted row failed (id=${result.id})`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        if (!metadataMerged) {
          // Keep the payload-bearing row when the echo merge fails. Mark it SENT without the
          // conflicting engine id so the pending reaper cannot strip successfully sent media. This is the
          // row that survives, so it carries what the send resolved too (a clicked button's label).
          await this.messageRepository
            .update(
              { id: message.id, status: MessageStatus.PENDING },
              { status: MessageStatus.SENT, timestamp: result.timestamp, ...changed },
            )
            .catch(err =>
              this.logger.warn(`Preserving the sent media row failed (id=${message.id})`, {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          const retained = await this.messageRepository.findOne({ where: { id: message.id } }).catch(() => null);
          if (retained) this.emitPersisted(message.sessionId, retained);
          return { messageId: result.id, timestamp: result.timestamp };
        }
        await this.messageRepository
          .update({ sessionId: message.sessionId, waMessageId: result.id }, patch)
          .catch(err =>
            this.logger.warn(`Merging SENT state onto the echo-persisted row failed (id=${result.id})`, {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        await this.messageRepository.delete({ id: message.id }).catch(() => undefined);
        // Reconcile provider indexes (#906): upsert the surviving echo row (now carrying our SENT
        // state + media) and drop the ghost PENDING document this redundant row produced earlier.
        const surviving = await this.messageRepository
          .findOne({ where: { sessionId: message.sessionId, waMessageId: result.id } })
          .catch(() => null);
        if (surviving) this.emitPersisted(message.sessionId, surviving);
        void this.hookManager
          .execute(
            'message:deleted',
            { sessionId: message.sessionId, message: { ...message } },
            { sessionId: message.sessionId, source: 'MessageService' },
          )
          .catch(() => undefined);
      } else {
        this.logger.warn(`Persisting SENT state failed after a successful send (id=${result.id})`, {
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
    }
    return { messageId: result.id, timestamp: result.timestamp };
  }

  private getEngine(sessionId: string) {
    return this.engines.require(
      sessionId,
      () => new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`),
    );
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
      await new Promise(resolve => setTimeout(resolve, Math.min(maxMs, jittered)));
    } catch (error) {
      this.logger.warn(`simulateTyping skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Map a blocked outbound media fetch (SSRF guard) to an HTTP 400 so a
   * caller-supplied internal/unsafe URL returns a client error instead of a 500.
   * The raw guard message names the resolved internal IP (a recon/DNS-rebind oracle), so return a
   * generic message to the client and keep the detail in the server log only. Others pass through.
   * The guard refuses before any fetch, so the replacement keeps the proof that nothing was sent.
   */
  private toClientFacingError(error: unknown): unknown {
    if (error instanceof SsrfBlockedError) {
      this.logger.warn(`Outbound media fetch blocked by SSRF guard: ${error.message}`);
      return markNothingSent(new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE));
    }
    return error;
  }

  private buildMediaInput(dto: SendMediaMessageDto): MediaInput {
    const { mimetype, data } = resolveMediaBody(dto, {
      fallbackMimetype: 'application/octet-stream',
      requireMimetypeForBase64: true,
      checkUrl: true,
    });
    return {
      mimetype,
      data,
      filename: dto.filename,
      caption: dto.caption,
      mentions: dto.mentions,
      quotedMessageId: dto.quotedMessageId,
    };
  }

  /**
   * The custom preview the engine is handed. Its image is checked here, before the PENDING row, as a
   * media body is: base64 loses a data: prefix and wins over a URL, an oversized one is a 413, and a URL
   * that is not http(s) is a 400. The MCP tool reaches this without the ValidationPipe, so the DTO's
   * rules alone would not hold there.
   */
  private buildCustomPreview(preview: SendTextMessageDto['customLinkPreview']): CustomLinkPreview | undefined {
    if (!preview) return undefined;
    const { thumbnailUrl, thumbnailBase64, ...metadata } = preview;
    const base64 = stripBase64DataUri(thumbnailBase64);
    if (base64) {
      assertBase64WithinMediaCap(base64, LINK_PREVIEW_THUMBNAIL_MAX_BYTES);
      return { ...metadata, thumbnailBase64: base64 };
    }
    // A null passes the DTO's @IsOptional, so it means absent here too.
    if (thumbnailUrl != null) {
      if (!isMediaUrl(thumbnailUrl)) {
        throw new BadRequestException(`customLinkPreview.thumbnailUrl: ${MEDIA_URL_MESSAGE}`);
      }
      return { ...metadata, thumbnailUrl };
    }
    return metadata;
  }
}
