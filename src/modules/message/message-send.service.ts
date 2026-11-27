import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { mergeSentMetadata, updateMessageMetadata } from './message-metadata';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository, QueryDeepPartialEntity, type FindOptionsSelect } from 'typeorm';
import { SessionService, linkPreviewDefault } from '../session/session.service';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { assertBase64WithinMediaCap, resolveMediaBody, stripBase64DataUri } from './media-cap.util';
import { clientFacingSsrfError } from '../../common/media/client-facing-ssrf-error';
import { LINK_PREVIEW_THUMBNAIL_MAX_BYTES } from '../../common/media/load-remote-media';
import { isMediaUrl, MEDIA_URL_MESSAGE } from '../../common/media/media-url';
import {
  CustomLinkPreview,
  MediaInput,
  IWhatsAppEngine,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageEngineRef, MessageStatus } from './entities/message.entity';
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
import { MEDIA_MESSAGE_TYPES, OMITTED_MEDIA } from '../session/message-row.mapper';
import { provablyDifferent } from '../session/message-mutation-guard';
import { engineChatOf } from './engine-chat-of';

/**
 * Outbound statuses whose media is eligible for archiving. An echo row merged after a fast ack can
 * already be DELIVERED or READ when `emitPersisted` runs, while PENDING and FAILED remain excluded.
 */
const ARCHIVABLE_OUTBOUND_STATUSES: ReadonlySet<MessageStatus> = new Set([
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
  MessageStatus.READ,
]);

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

/**
 * The engine ref of a send's row filed under `filed` that the engine delivered to `engineChatId`, when that is another
 * chat (the contact's LID, for a send addressed by phone number): the row keeps the chat its caller addressed, and a
 * change naming the delivered one is judged by that ref.
 */
function addressedRef(filed: string, engineChatId: string | undefined): MessageEngineRef | undefined {
  return engineChatId && provablyDifferent(filed, engineChatId)
    ? { chatId: engineChatId, direction: MessageDirection.OUTGOING, addressed: true }
    : undefined;
}

/** The row of an API send kept beside the own-send echo's row that took its message id (see Message.echoOf). */
type EchoTwin = Pick<Message, 'id' | 'sessionId' | 'chatId' | 'metadata' | 'timestamp'> & {
  echoOf: string;
  engineRef?: MessageEngineRef | null;
};

/**
 * Asking to suppress the preview AND to attach one is a contradiction, and guessing which half
 * the caller meant would send a message they did not ask for either way.
 */
function assertOnePreviewChoice(dto: SendTextMessageDto): void {
  if (dto.linkPreview === false && dto.customLinkPreview) {
    throw new BadRequestException('linkPreview: false cannot be combined with customLinkPreview');
  }
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
  /**
   * The id the engine addressed, when its number lookup answered another id than `chatId` names: the number
   * WhatsApp holds, or the contact's lid (see MessageResult.resolvedChatId). The row is filed under it. When the own-send echo wrote its row first, that
   * row is moved under it.
   */
  resolvedChatId?: string;
  /** The chat the engine delivered the message to (see MessageResult.engineChatId). */
  engineChatId?: string;
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

  sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    return this.sendTextInternal(sessionId, dto, this.isInitiatedDuringMessageSent());
  }

  private isInitiatedDuringMessageSent(): boolean {
    return this.hookManager?.isEventInFlight?.('message:sent') === true;
  }

  /**
   * Run an engine send while coordinating async own-send echo suppression.
   * When the send started inside a `message:sent` hook (captured synchronously at send entry so
   * fire-and-forget handlers stay covered), holds an echo-origin barrier across the engine call and
   * records `result.id` BEFORE releasing it so early `message_create` echoes always see the mark.
   */
  private async runEngineSend(
    sessionId: string,
    initiatedDuringMessageSent: boolean,
    invoke: () => Promise<MessageResult>,
  ): Promise<MessageResult> {
    if (!initiatedDuringMessageSent) {
      return invoke();
    }
    const release = this.hookManager?.beginEchoOriginSend?.(sessionId);
    try {
      const result = await invoke();
      if (result.id) {
        this.hookManager?.markEchoOrigin?.(sessionId, result.id);
      }
      return result;
    } finally {
      release?.();
    }
  }

  private async sendTextInternal(
    sessionId: string,
    dto: SendTextMessageDto,
    initiatedDuringMessageSent: boolean,
  ): Promise<MessageResponseDto> {
    assertOnePreviewChoice(dto);
    const {
      message,
      finalDto,
      engine,
      prepared: customPreview,
      sessionLinkPreview,
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
      (d: SendTextMessageDto) => {
        // Again on what the gate returned: a handler can rewrite the send into the same contradiction.
        assertOnePreviewChoice(d);
        return this.buildCustomPreview(d.customLinkPreview);
      },
      initiatedDuringMessageSent,
    );

    // Humanising "typing…" pause before the actual send (anti-automation signal). On by default;
    // SIMULATE_TYPING=false disables it.
    await this.simulateTypingIfEnabled(engine, finalDto.chatId, finalDto.text);

    // The session's default fills in only when the send left the preview open: a value in the
    // request, or a preview the caller supplied, is the caller's choice and always wins. Only a
    // boolean is a choice: a plugin's send and a gate rewrite arrive without the DTO's rules, and
    // the engines read anything else as unset.
    const requested = typeof finalDto.linkPreview === 'boolean' ? finalDto.linkPreview : undefined;
    const linkPreview = requested ?? (customPreview ? undefined : sessionLinkPreview);

    let result: MessageResult;
    try {
      // The call is widened ONLY as far as the caller actually asked. A send with neither mentions
      // nor a preview choice keeps its two-argument shape, and one with mentions alone keeps its
      // three — trailing `undefined`s would be harmless to the engines but would rewrite the call
      // shape of every existing send for no behavioural gain.
      const { quotedMessageId } = finalDto;
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () => {
        if (linkPreview !== undefined || customPreview || quotedMessageId) {
          return engine.sendTextMessage(finalDto.chatId, finalDto.text, finalDto.mentions, {
            ...(linkPreview === undefined ? {} : { linkPreview }),
            ...(customPreview ? { customPreview } : {}),
            ...(quotedMessageId ? { quotedMessageId } : {}),
          });
        }
        if (finalDto.mentions?.length) {
          return engine.sendTextMessage(finalDto.chatId, finalDto.text, finalDto.mentions);
        }
        return engine.sendTextMessage(finalDto.chatId, finalDto.text);
      });
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
    initiatedDuringMessageSentOverride?: boolean,
  ): Promise<{
    finalDto: T;
    engine: IWhatsAppEngine;
    prepared: P;
    message: Message;
    sessionLinkPreview?: boolean;
    initiatedDuringMessageSent: boolean;
  }> {
    // Capture synchronously before the first await so fire-and-forget `message:sent` handlers
    // still propagate echo suppression even after HookManager.runInFlight clears its ALS scope.
    const initiatedDuringMessageSent = initiatedDuringMessageSentOverride ?? this.isInitiatedDuringMessageSent();
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
      let sessionLinkPreview: boolean | undefined;
      const message = await this.saveOutgoingMessage(
        sessionId,
        await buildPending(finalDto, prepared),
        lifetime,
        config => {
          sessionLinkPreview = linkPreviewDefault(config) ?? undefined;
        },
      );
      lifetime.assertCurrent();
      persisted = true;
      return { finalDto, engine, prepared, message, sessionLinkPreview, initiatedDuringMessageSent };
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
      // message via clientFacingSsrfError, and the message:failed hook must not expose more than the
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
      throw clientFacingSsrfError(error);
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
    const initiatedDuringMessageSent = this.isInitiatedDuringMessageSent();
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
    let rendered: string[];
    try {
      const length =
        parts.reduce((sum, part) => sum + renderedLength(part, vars), 0) +
        separator.length * Math.max(0, parts.length - 1);
      if (length > maxChars) {
        throw new BadRequestException(
          `Rendered template is ${length} characters, over the ${maxChars}-character limit`,
        );
      }
      rendered = parts.map(part => renderTemplate(part, vars));
    } catch (error) {
      if (error instanceof TemplateRenderError) throw new BadRequestException(error.message);
      throw error;
    }
    // send-text refuses an empty text before anything is stored or sent; a render that leaves none is the same. Each
    // part is tested, not the joined text: the separator between empty parts would make it non-empty.
    if (rendered.every(part => !part)) throw new BadRequestException('Rendered template is empty');
    const text = rendered.join(separator);

    return this.sendTextInternal(
      sessionId,
      {
        chatId: dto.chatId,
        text,
        mentions: dto.mentions,
        linkPreview: dto.linkPreview,
      },
      initiatedDuringMessageSent,
    );
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const {
      message,
      finalDto,
      engine,
      prepared: media,
      initiatedDuringMessageSent,
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
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendImageMessage(finalDto.chatId, media),
      );
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
      initiatedDuringMessageSent,
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
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendVideoMessage(finalDto.chatId, media),
      );
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
      initiatedDuringMessageSent,
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
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendAudioMessage(finalDto.chatId, media),
      );
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
      initiatedDuringMessageSent,
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
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendDocumentMessage(finalDto.chatId, media),
      );
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
    const { message, finalDto, engine, initiatedDuringMessageSent } = await this.applySendingGate(
      sessionId,
      'location',
      dto,
      finalDto => ({
        chatId: finalDto.chatId,
        body: `📍 ${finalDto.description || 'Location'}`,
        type: 'location',
        quotedMessageId: finalDto.quotedMessageId,
      }),
    );

    let result: MessageResult;
    try {
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendLocationMessage(finalDto.chatId, {
          latitude: finalDto.latitude,
          longitude: finalDto.longitude,
          description: finalDto.description,
          address: finalDto.address,
          quotedMessageId: finalDto.quotedMessageId,
        }),
      );
    } catch (error) {
      return this.failSend(sessionId, 'location', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string; quotedMessageId?: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine, initiatedDuringMessageSent } = await this.applySendingGate(
      sessionId,
      'contact',
      dto,
      finalDto => ({
        chatId: finalDto.chatId,
        body: `📇 ${finalDto.contactName}`,
        type: 'contact',
        quotedMessageId: finalDto.quotedMessageId,
      }),
    );

    let result: MessageResult;
    try {
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendContactMessage(finalDto.chatId, {
          name: finalDto.contactName,
          number: finalDto.contactNumber,
          quotedMessageId: finalDto.quotedMessageId,
        }),
      );
    } catch (error) {
      return this.failSend(sessionId, 'contact', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async sendPoll(
    sessionId: string,
    dto: { chatId: string; name: string; options: string[]; allowMultipleAnswers?: boolean; quotedMessageId?: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine, initiatedDuringMessageSent } = await this.applySendingGate(
      sessionId,
      'poll',
      dto,
      finalDto => ({
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
      }),
    );

    let result: MessageResult;
    try {
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendPollMessage(finalDto.chatId, {
          name: finalDto.name,
          options: finalDto.options,
          allowMultipleAnswers: finalDto.allowMultipleAnswers === true,
          quotedMessageId: finalDto.quotedMessageId,
        }),
      );
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
      initiatedDuringMessageSent,
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
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.sendStickerMessage(finalDto.chatId, media),
      );
    } catch (error) {
      return this.failSend(sessionId, 'sticker', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string; mentions?: string[] },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine, initiatedDuringMessageSent } = await this.applySendingGate(
      sessionId,
      'reply',
      dto,
      async finalDto => {
        const quotedBody = await this.resolveQuotedBody(sessionId, finalDto.quotedMessageId, finalDto.chatId);
        return {
          chatId: finalDto.chatId,
          body: finalDto.text,
          type: 'text',
          metadata: {
            quotedMessage: { id: finalDto.quotedMessageId, body: quotedBody },
          },
        };
      },
    );

    // The reply goes where a send to the caller's chat goes; only the check that the quoted message is in that chat
    // takes the chat an API send it quotes was delivered to.
    const quotedChatId = await this.engineChatOf(sessionId, finalDto.chatId, finalDto.quotedMessageId);
    let result: MessageResult;
    try {
      // Widened only as far as the caller asked, exactly like the send path: a reply with no tags
      // keeps its three-argument shape.
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        quotedChatId !== finalDto.chatId
          ? engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text, finalDto.mentions, {
              quotedChatId,
            })
          : finalDto.mentions?.length
            ? engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text, finalDto.mentions)
            : engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text),
      );
    } catch (error) {
      return this.failSend(sessionId, 'reply', message, finalDto, error);
    }
    return this.persistSentState(message, result);
  }

  async clickButton(
    sessionId: string,
    dto: { chatId: string; messageId: string; buttonId: string; text?: string },
  ): Promise<MessageResponseDto> {
    const { message, finalDto, engine, initiatedDuringMessageSent } = await this.applySendingGate(
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
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.clickButton(finalDto.chatId, finalDto.messageId, finalDto.buttonId, finalDto.text),
      );
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
    // The row carries what is forwarded: the own-send echo that also carries it loses the insert race to this
    // row whenever the send path writes the engine id first, so a placeholder stored here stayed for good.
    const { message, finalDto, engine, initiatedDuringMessageSent } = await this.applySendingGate(
      sessionId,
      'forward',
      dto,
      async finalDto => ({
        chatId: finalDto.toChatId,
        ...((await this.storedForwardContent(sessionId, finalDto.fromChatId, finalDto.messageId)) ?? {
          body: '[Forwarded]',
          type: 'forward',
        }),
      }),
    );

    // Only the engine's check of the forwarded message takes the chat an API send was delivered to.
    const fromChatId = await this.engineChatOf(sessionId, finalDto.fromChatId, finalDto.messageId);
    let result: MessageResult;
    try {
      result = await this.runEngineSend(sessionId, initiatedDuringMessageSent, () =>
        engine.forwardMessage(fromChatId, finalDto.toChatId, finalDto.messageId),
      );
    } catch (error) {
      return this.failSend(sessionId, 'forward', message, finalDto, error);
    }
    // persistSentState preserves the empty-id rule: a forward whose engine couldn't recover the sent
    // copy's id leaves waMessageId NULL so no ack mis-matches it.
    return this.persistSentState(message, result);
  }

  /** The chat the engine acts on the message in (see engineChatOf). */
  private engineChatOf(sessionId: string, chatId: string, messageId: string): Promise<string> {
    const store = this.lidMappingStore;
    return engineChatOf(this.messageRepository, sessionId, chatId, messageId, id =>
      resolveJidCandidates(
        id,
        store && {
          resolveLid: lid => store.findPhoneForLid(lid),
          lidsForPhone: phone => store.findLidsForPhone(phone),
        },
      ),
    );
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
   * The type, text and media of the message a forward copies, from its row in `fromChatId` (any of the chat's
   * phone, lid or group forms, as for a quote), or undefined when no such row is stored, it was revoked, or the
   * read fails. A quote or mention it carried is not copied: the forwarded copy has neither. Media the source row
   * holds no bytes for is stored as the omitted marker, as the echo and history paths store it, without an archive
   * pointer that names the source row's file; it never replaces an echo's bytes (see mergeSentMetadata).
   */
  private async storedForwardContent(
    sessionId: string,
    fromChatId: string,
    messageId: string,
  ): Promise<Pick<SaveOutgoingMessageData, 'body' | 'type' | 'metadata'> | undefined> {
    try {
      const store = this.lidMappingStore;
      const expanded = await resolveJidCandidates(
        fromChatId,
        store && {
          resolveLid: lid => store.findPhoneForLid(lid),
          lidsForPhone: phone => store.findLidsForPhone(phone),
        },
      );
      const source = await this.messageRepository.findOne({
        where: { sessionId, chatId: In([...new Set([fromChatId, ...expanded])]), waMessageId: messageId },
      });
      if (!source || source.type === 'revoked') return undefined;
      const { media, poll } = (source.metadata ?? {}) as { media?: Record<string, unknown>; poll?: unknown };
      let copied = typeof media?.data === 'string' && media.data ? media : undefined;
      if (!copied && MEDIA_MESSAGE_TYPES.has(source.type)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { data, archived, ...kept } = media ?? {};
        copied = { ...OMITTED_MEDIA, ...kept, omitted: true };
      }
      const metadata = { ...(copied ? { media: copied } : {}), ...(poll ? { poll } : {}) };
      return { type: source.type, body: source.body, metadata: Object.keys(metadata).length ? metadata : undefined };
    } catch (err) {
      this.logger.warn(`Failed to read forwarded message ${messageId}`, { error: String(err) });
      return undefined;
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
    onSessionConfig?: (config: unknown) => void,
  ): Promise<Message> {
    const scope =
      lifetime ?? captureSessionWrites(this.messageRepository.manager?.connection ?? this.messageRepository, sessionId);
    try {
      const session = await this.sessionService.findOne(sessionId);
      onSessionConfig?.(session?.config);
      // Resolved here rather than in each sender: reply and click-button build their own
      // `metadata.quotedMessage` and never reach this branch, so every OTHER quoting sender (media,
      // location, contact, poll, quoted text) used to persist an id with an empty body and the
      // dashboard drew a blank quote box above the message.
      const quotedMessage = data.quotedMessageId
        ? { id: data.quotedMessageId, body: await this.resolveQuotedBody(sessionId, data.quotedMessageId) }
        : undefined;
      const chatId = data.resolvedChatId ?? data.chatId;
      if (data.resolvedChatId) this.pacing.rememberResolvedNumber(sessionId, data.chatId, data.resolvedChatId);
      const engineRef = data.waMessageId ? addressedRef(chatId, data.engineChatId) : undefined;
      const message = this.messageRepository.create({
        sessionId,
        // An engine that sent a message but could not read its id back reports an empty id (see the
        // whatsapp-web.js adapter's `toMessageResult`). Store NULL rather than '': the
        // (sessionId, waMessageId) unique index is not partial, so a second id-less send in the same
        // session collides on '' while NULLs stay exempt — and in the bulk path that violation is
        // swallowed into a warning, losing the row silently. Normalizing at this one chokepoint covers
        // every caller instead of relying on each to remember.
        waMessageId: data.waMessageId || undefined,
        chatId,
        // The account's JID, the form the engines' own-send echo stores for the same message; 'me' only while the
        // session has no number to name it by.
        from: session?.phone ? `${session.phone}@c.us` : 'me',
        to: chatId,
        body: data.body,
        type: data.type,
        direction: MessageDirection.OUTGOING,
        timestamp: data.timestamp,
        status: data.status ?? MessageStatus.PENDING,
        metadata: quotedMessage ? { ...data.metadata, quotedMessage } : data.metadata,
        engineRef,
      });
      // No transaction of its own: the unique violation handled below is routine (the own-send echo wins the
      // race), and on SQLite's single shared connection its rollback would discard what other callers wrote
      // while it was open, after they were told it was stored.
      const saved = await scope
        .write(() => this.messageRepository.save(message, { transaction: false }))
        .catch(async (err: unknown) => {
          const waMessageId = message.waMessageId;
          if (!waMessageId || !isUniqueViolation(err)) throw err;
          // The engine has already sent this item: it is kept as the echo row's twin, with its media, until what it
          // holds is on that row (see settleEchoTwin), never lost to a merge that fails.
          const twin = await scope.write(() =>
            this.messageRepository.save(
              this.messageRepository.create({ ...message, waMessageId: undefined, echoOf: waMessageId }),
              { transaction: false },
            ),
          );
          return (await this.settleEchoTwin({ ...twin, echoOf: waMessageId })) ?? twin;
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
  // sites: every terminal state of an outbound row passes here. Gated on SENT/DELIVERED/READ
  // because a PENDING row may still be deleted by the dedup merge or rewritten by the pending
  // reaper, and a FAILED one has had its payload stripped; archiving either would strand a file
  // the row never points at, whereas an echo row merged after a fast ack may already be DELIVERED
  // or READ.
  //
  // Hook emissions keep `source: 'MessageService'` — the string is part of the observable hook
  // contract plugins may filter on, so the send seam must not change it.
  private emitPersisted(sessionId: string, message: Message): void {
    // The chat the engine delivered to stays in the gateway, as for a row a hook moved, and so does the echo row's id
    // a twin is still to be merged onto.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { engineRef, echoOf, ...row } = message;
    void this.hookManager
      .execute('message:persisted', { sessionId, message: row }, { sessionId, source: 'MessageService' })
      .catch(() => undefined);
    if (ARCHIVABLE_OUTBOUND_STATUSES.has(message.status) && this.archiveOutboundEnabled) {
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
    changed: Pick<QueryDeepPartialEntity<Message>, 'body' | 'metadata' | 'chatId' | 'to'> = {},
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
    // WhatsApp holds the number under other digits than the caller wrote, or answered only the contact's lid. The
    // message went there and the reply arrives there, so the row is filed there too, not under a spelling nothing
    // else uses.
    const resolved = result.resolvedChatId ? { chatId: result.resolvedChatId, to: result.resolvedChatId } : {};
    // The id the caller wrote holds no row from here on: pacing has to know it is a contact the account knows.
    if (result.resolvedChatId) {
      this.pacing.rememberResolvedNumber(message.sessionId, message.chatId, result.resolvedChatId);
    }
    Object.assign(message, resolved);
    changed = { ...changed, ...resolved };
    // Kept off `message`, which goes to `message:persisted`: written with the id, so the echo of the send, and any
    // change naming the chat it was delivered to, is judged against both chats from the first moment.
    const engineRef = addressedRef(message.chatId, result.engineChatId);
    // Set when the row was no longer PENDING at the first write: the pending reaper failed it while the engine answered.
    // The reaper can also fail it later, before it is kept as the echo row's twin; keepAsEchoTwin covers both.
    let reaped = false;
    try {
      // No transaction of its own, for the reason given at the first save of this message.
      const sent: QueryDeepPartialEntity<Message> = {
        ...changed,
        waMessageId: message.waMessageId,
        status: message.status,
        timestamp: message.timestamp,
        ...(engineRef ? { engineRef } : {}),
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
        reaped = true;
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
        // Best-effort throughout: the send itself already succeeded.
        await this.keepAsEchoTwin(message, result, changed, engineRef, reaped).catch(error =>
          this.logger.warn(`Keeping the sent row beside the echo-persisted row failed (id=${result.id})`, {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        this.logger.warn(`Persisting SENT state failed after a successful send (id=${result.id})`, {
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
    }
    return { messageId: result.id, timestamp: result.timestamp };
  }

  /**
   * The engine's own-send echo (onMessageCreate) won the race and already persisted a row with the message id. That
   * row carries only what the engine reported (for a Baileys API send, a media-less marker), so this send's row first
   * becomes its twin: SENT, so the pending reaper never fails it and strips the media, and naming the echo row by
   * `echoOf`, with the chat the message was delivered to. What it holds is then merged onto the echo row and the twin
   * dropped (settleEchoTwin); a step that fails leaves the twin for the reaper's sweep. A row the reaper failed first
   * lost its payload: the write guarded on PENDING matches nothing, and the row is marked from the copy this send still
   * holds instead.
   */
  private async keepAsEchoTwin(
    message: Message,
    result: MessageResult,
    changed: QueryDeepPartialEntity<Message>,
    engineRef: MessageEngineRef | undefined,
    reaped: boolean,
  ): Promise<void> {
    this.logger.debug(`Send echo already persisted ${result.id}; merging onto it and dropping this row`, {
      messageId: message.id,
    });
    const twin: QueryDeepPartialEntity<Message> = {
      ...changed,
      status: MessageStatus.SENT,
      timestamp: result.timestamp,
      echoOf: result.id,
      ...(engineRef ? { engineRef } : {}),
    };
    let marked = reaped
      ? undefined
      : await this.messageRepository.update({ id: message.id, status: MessageStatus.PENDING }, twin);
    if (!marked?.affected) {
      marked = await this.messageRepository.update(
        { id: message.id, status: MessageStatus.FAILED },
        { ...twin, metadata: message.metadata as QueryDeepPartialEntity<Record<string, unknown>> },
      );
    }
    // No row: the session was deleted under this send.
    if (!marked?.affected) return;
    const surviving = await this.settleEchoTwin(
      {
        id: message.id,
        sessionId: message.sessionId,
        chatId: message.chatId,
        metadata: message.metadata,
        timestamp: result.timestamp,
        echoOf: result.id,
        engineRef,
      },
      { ...message },
    );
    if (surviving !== undefined) {
      if (surviving) this.emitPersisted(message.sessionId, surviving);
      return;
    }
    // Reconcile the earlier PENDING emission (#906) with the twin that stays until the reaper's sweep settles it.
    const retained = await this.messageRepository.findOne({ where: { id: message.id } }).catch(() => null);
    if (retained) this.emitPersisted(message.sessionId, retained);
  }

  /**
   * Finish an API send whose message id the own-send echo's row took first, from its twin (see Message.echoOf): merge
   * what the twin holds onto the echo row, never onto one revoked since (the twin then goes with what it holds), and
   * not a URL pointer over bytes the engine downloaded; carry its timestamp; move the echo row under the chat the
   * caller addressed; drop the twin. With the echo row gone, the twin takes the message id. No status is written: the
   * echo row is inserted SENT and acks advance it forward only. Every step can run again, so one that fails leaves the
   * twin for the pending reaper's sweep, which calls this again. `announced` is the twin as `message:persisted` last
   * saw it, withdrawn with `message:deleted` once the twin is gone. Resolves the row that holds the message now, null
   * when none does, or undefined when the twin is left.
   */
  private async settleEchoTwin(twin: EchoTwin, announced?: Message): Promise<Message | null | undefined> {
    const { sessionId, echoOf } = twin;
    const where = { sessionId, waMessageId: echoOf };
    try {
      const echo = await this.messageRepository.findOne({ where, select: { id: true, type: true } });
      if (!echo) {
        const claimed = await this.messageRepository.update(
          { id: twin.id, echoOf },
          { waMessageId: echoOf, echoOf: null },
        );
        return claimed?.affected ? this.messageRepository.findOne({ where: { id: twin.id } }) : null;
      }
      const metadata = twin.metadata;
      if (echo.type !== 'revoked' && metadata && !isUrlPointerMetadata(metadata)) {
        // Null: the echo row was revoked or removed since it was read, which the next sweep tells apart.
        const merged = await updateMessageMetadata(this.messageRepository, where, current =>
          mergeSentMetadata(current, metadata),
        );
        if (!merged) return undefined;
      }
      if (twin.timestamp != null) await this.messageRepository.update(where, { timestamp: twin.timestamp });
      if (twin.engineRef?.addressed) await this.moveEchoRow(sessionId, echoOf, twin.chatId, twin.engineRef);
      const deleted = await this.messageRepository.delete({ id: twin.id, echoOf });
      // Only for a row that is gone (#906): a delete that failed or found nothing leaves the provider's copy right.
      if (deleted?.affected && announced) {
        void this.hookManager
          .execute('message:deleted', { sessionId, message: announced }, { sessionId, source: 'MessageService' })
          .catch(() => undefined);
      }
      return this.messageRepository.findOne({ where });
    } catch (error) {
      this.logger.warn(`Merging a sent row onto the echo-persisted row failed (id=${echoOf})`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * The pending reaper's pass over API sends whose merge onto the echo row was left (see settleEchoTwin): the rows
   * with `echoOf` stored before `before`, oldest first, at most `limit`, until `stopped`. Resolves how many settled.
   */
  async reconcileEchoTwins(before: Date, limit: number, stopped: () => boolean = () => false): Promise<number> {
    const columns = Object.fromEntries(
      this.messageRepository.metadata.columns.map(column => [column.propertyName, true]),
    ) as FindOptionsSelect<Message>;
    const twins = await this.messageRepository.find({
      where: { echoOf: Not(IsNull()), createdAt: LessThan(before) },
      select: columns,
      order: { createdAt: 'ASC' },
      take: limit,
    });
    let settled = 0;
    for (const twin of twins) {
      if (stopped()) break;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { engineRef, echoOf, ...announced } = twin;
      const surviving = await this.settleEchoTwin({ ...twin, echoOf: echoOf! }, announced);
      if (surviving === undefined) continue;
      settled++;
      if (surviving) this.emitPersisted(twin.sessionId, surviving);
    }
    return settled;
  }

  /**
   * File the own-send echo's row, which names the chat the engine delivered the message to, under the chat the caller
   * addressed (`filed`), with that delivered chat in its engine ref, so both orders of the two writers store one row.
   * Only a row still where the echo put it moves: one a `message:sent` handler filed elsewhere keeps its engine ref.
   */
  private async moveEchoRow(
    sessionId: string,
    waMessageId: string,
    filed: string,
    engineRef: MessageEngineRef,
  ): Promise<void> {
    await this.messageRepository.update(
      {
        sessionId,
        waMessageId,
        chatId: engineRef.chatId,
        direction: MessageDirection.OUTGOING,
        engineRef: IsNull(),
      },
      { chatId: filed, to: filed, engineRef },
    );
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
