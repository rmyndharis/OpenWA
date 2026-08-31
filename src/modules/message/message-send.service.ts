import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryDeepPartialEntity } from 'typeorm';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { assertBase64WithinMediaCap, stripBase64DataUri } from './media-cap.util';
import { MediaInput, IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager, applySendingGate } from '../../core/hooks';
import { SendPacingService, countsTowardSendBreaker } from './send-pacing.service';
import { TemplateService } from '../template/template.service';
import { renderTemplate } from '../../common/utils/template-render';
import { createLogger } from '../../common/services/logger.service';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';

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
   * Quoted id for a send that is a reply. Folded into `metadata.quotedMessage` here rather than
   * by each sender so the nine send paths and `reply()` persist one shape — a row that quoted a
   * message but records nothing is simply wrong history, and the dashboard reads this key to
   * render the reply preview. The body is left empty: unlike `reply()`, the send paths do not
   * look the quoted message up, and '' is already reply()'s own value when that lookup fails.
   */
  quotedMessageId?: string;
  /**
   * Marks the row as written by a bot rather than by a human — see `Message.automated`. Only the
   * automation autoreply path sets it; every other sender leaves it undefined and persists false.
   */
  automated?: boolean;
}

/**
 * Out-of-band send options — deliberately a separate argument rather than fields on the send DTOs:
 * these are decided by the CALLER's identity, not by the request body, and a REST client must not
 * be able to pass `automated: true` and make its own send invisible to the human-reply gates.
 */
export interface SendOrigin {
  /** See `Message.automated`. Set only by the automation autoreply path. */
  automated?: boolean;
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
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto, opts?: SendOrigin): Promise<MessageResponseDto> {
    // Asking to suppress the preview AND to attach one is a contradiction, and guessing which half
    // the caller meant would send a message they did not ask for either way.
    if (dto.linkPreview === false && dto.customLinkPreview) {
      throw new BadRequestException('linkPreview: false cannot be combined with customLinkPreview');
    }
    const finalDto = await this.applySendingGate(sessionId, 'text', dto);

    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
      quotedMessageId: finalDto.quotedMessageId,
      automated: opts?.automated,
    });

    // Opt-in humanising "typing…" pause before the actual send (anti-automation signal).
    await this.simulateTypingIfEnabled(engine, finalDto.chatId, finalDto.text);

    let result: MessageResult;
    try {
      // The call is widened ONLY as far as the caller actually asked. A send with neither mentions
      // nor a preview choice keeps its two-argument shape, and one with mentions alone keeps its
      // three — trailing `undefined`s would be harmless to the engines but would rewrite the call
      // shape of every existing send for no behavioural gain.
      const { linkPreview, customLinkPreview, quotedMessageId } = finalDto;
      if (linkPreview !== undefined || customLinkPreview || quotedMessageId) {
        result = await engine.sendTextMessage(finalDto.chatId, finalDto.text, finalDto.mentions, {
          ...(linkPreview === undefined ? {} : { linkPreview }),
          ...(customLinkPreview ? { customPreview: customLinkPreview } : {}),
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
   * (possibly plugin-modified) input, or throw BadRequestException if a plugin blocked the send.
   * Centralised so EVERY public sender in this class — text, media, extended (location/contact/
   * poll/sticker/reply/forward) — passes through the same moderation chokepoint, instead of only
   * `sendText`. The edit path is gated by the twin method in MessageService (the query side of
   * the send/query split), on the same core/hooks/sending-gate implementation shared with
   * StatusService.
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
    // Only failures that say something about the account's standing feed the breaker: adapters also
    // raise client-fault and engine-state errors from inside this call (a blocked media URL, an
    // unsupported capability, a disconnected socket), and counting those let a client sending bad
    // requests trip the breaker on a healthy session.
    if (countsTowardSendBreaker(error)) {
      this.pacing.recordSendFailure(sessionId);
    }
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
   *
   * The FINAL rendered text is capped at template.renderMaxChars (default 64 KiB): caller-supplied
   * variables can inflate a small template unboundedly, so an over-cap render is rejected with a
   * 400 naming the limit rather than truncated silently or pushed to the engine/DB as-is.
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

    const maxChars =
      this.configService?.get<number>('template.renderMaxChars', DEFAULT_TEMPLATE_RENDER_MAX_CHARS) ??
      DEFAULT_TEMPLATE_RENDER_MAX_CHARS;
    if (text.length > maxChars) {
      throw new BadRequestException(
        `Rendered template is ${text.length} characters, over the ${maxChars}-character limit`,
      );
    }

    return this.sendText(sessionId, {
      chatId: dto.chatId,
      text,
      mentions: dto.mentions,
      linkPreview: dto.linkPreview,
    });
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
      quotedMessageId: finalDto.quotedMessageId,
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
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
      quotedMessageId: finalDto.quotedMessageId,
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
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
        media: { mimetype: audioDto.mimetype, filename: finalDto.filename, data: media.data },
      },
      quotedMessageId: finalDto.quotedMessageId,
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
      quotedMessageId: finalDto.quotedMessageId,
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
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
    const finalDto = await this.applySendingGate(sessionId, 'location', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: `📍 ${finalDto.description || 'Location'}`,
      type: 'location',
      quotedMessageId: finalDto.quotedMessageId,
    });

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
    const finalDto = await this.applySendingGate(sessionId, 'contact', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: `📇 ${finalDto.contactName}`,
      type: 'contact',
      quotedMessageId: finalDto.quotedMessageId,
    });

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
    const finalDto = await this.applySendingGate(sessionId, 'poll', dto);
    const engine = this.getEngine(sessionId);

    // Save message as pending BEFORE sending. A poll has no plain-text body, so store the
    // question — that keeps the message history readable.
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: `📊 ${finalDto.name}`,
      type: 'poll',
      quotedMessageId: finalDto.quotedMessageId,
    });

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
    const finalDto = await this.applySendingGate(sessionId, 'sticker', dto);
    const engine = this.getEngine(sessionId);
    const media = this.buildMediaInput(finalDto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      type: 'sticker',
      quotedMessageId: finalDto.quotedMessageId,
      metadata: {
        media: { mimetype: finalDto.mimetype, filename: finalDto.filename, data: media.data },
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
    dto: { chatId: string; quotedMessageId: string; text: string; mentions?: string[] },
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
  async saveOutgoingMessage(sessionId: string, data: SaveOutgoingMessageData): Promise<Message> {
    const session = await this.sessionService.findOne(sessionId);
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
      from: session?.phone || 'me',
      to: data.chatId,
      body: data.body,
      type: data.type,
      direction: MessageDirection.OUTGOING,
      timestamp: data.timestamp,
      status: data.status ?? MessageStatus.PENDING,
      automated: data.automated ?? false,
      metadata: data.quotedMessageId
        ? { ...data.metadata, quotedMessage: { id: data.quotedMessageId, body: '' } }
        : data.metadata,
    });
    const saved = await this.messageRepository.save(message).catch(async (err: unknown) => {
      const waMessageId = message.waMessageId;
      if (!waMessageId || !isUniqueViolation(err)) throw err;
      const patch: QueryDeepPartialEntity<Message> = {
        status: message.status,
        timestamp: message.timestamp,
      };
      // Carry the bot marker onto the surviving row. The echo writer cannot know a send was
      // automated, so losing this race would leave an autoreply looking human — and a
      // `pauseOnHumanReply` rule would then silence itself on its own reply.
      if (message.automated) patch.automated = true;
      // Only when this write actually carries metadata worth merging: a text item must not blank
      // the echo's, and a URL pointer must not replace bytes the engine already downloaded.
      if (message.metadata && !isUrlPointerMetadata(message.metadata)) {
        patch.metadata = message.metadata as QueryDeepPartialEntity<Record<string, unknown>>;
      }
      await this.messageRepository.update({ sessionId, waMessageId }, patch);
      const surviving = await this.messageRepository.findOne({ where: { sessionId, waMessageId } });
      if (!surviving) throw err;
      return surviving;
    });
    this.emitPersisted(sessionId, saved);
    return saved;
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
    await this.messageRepository.save(message);
    // Reconcile the earlier PENDING emission (#906): a provider must see the terminal FAILED state.
    this.emitPersisted(message.sessionId, message);
  }

  /**
   * Persist the SENT state AFTER the engine has already accepted the message. The send already
   * succeeded, so a failure to write the SENT row must NOT be surfaced as a send failure — a transient
   * DB fault would otherwise mark a delivered message permanently FAILED and (for text) fire
   * `message:failed`. Log and return success instead.
   */
  private async persistSentState(message: Message, result: MessageResult): Promise<MessageResponseDto> {
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
      await this.messageRepository.save(message);
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
        const patch: QueryDeepPartialEntity<Message> = { status: MessageStatus.SENT, timestamp: result.timestamp };
        // Same reason as in saveOutgoingMessage: the echo row defaults to automated=false, so the
        // marker has to ride the merge or the autoreply is indistinguishable from a human send.
        if (message.automated) patch.automated = true;
        if (message.metadata && !isUrlPointerMetadata(message.metadata)) {
          patch.metadata = message.metadata as QueryDeepPartialEntity<Record<string, unknown>>;
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
    const base64 = stripBase64DataUri(dto.base64);
    if (!dto.url && !base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }

    if (base64 && !dto.mimetype) {
      throw new BadRequestException('mimetype is required when using base64 data');
    }

    // Bound an outbound base64 payload to the same byte cap as URL/inbound media, before it is
    // persisted or handed to the engine. URL media is already capped while streaming.
    assertBase64WithinMediaCap(base64);

    return {
      mimetype: dto.mimetype || 'application/octet-stream',
      // base64 wins over url when both are present: it is the explicit local payload, and a stale
      // `url` (e.g. a Swagger/example default left in the body) must not be fetched in its place.
      // Aligns the send selection with the base64-first persisted metadata and the url field's
      // `@ValidateIf((o) => !o.base64)` (which skips @IsUrl when base64 is present) — #670.
      data: base64 || dto.url!,
      filename: dto.filename,
      caption: dto.caption,
      mentions: dto.mentions,
      quotedMessageId: dto.quotedMessageId,
    };
  }
}
