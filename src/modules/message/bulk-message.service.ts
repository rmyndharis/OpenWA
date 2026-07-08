import { Injectable, Logger, BadRequestException, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  MessageBatch,
  BatchStatus,
  BatchMessageStatus,
  BatchProgress,
  BatchMessageResult,
} from './entities/message-batch.entity';
import { SendBulkMessageDto } from './dto/bulk-message.dto';
import { MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
import { HookManager } from '../../core/hooks';
import { assertBase64WithinMediaCap } from './media-cap.util';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { renderTemplate } from '../../common/utils/template-render';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';

// Type definitions for bulk message content
interface BulkMessageContent {
  text?: string;
  caption?: string;
  image?: { url?: string; base64?: string; mimetype?: string; filename?: string };
  video?: { url?: string; base64?: string; mimetype?: string; filename?: string };
  audio?: { url?: string; base64?: string; mimetype?: string; filename?: string; ptt?: boolean };
  document?: { url?: string; base64?: string; mimetype?: string; filename?: string };
}

/**
 * Resolve a batch's terminal status, in precedence order:
 *  - cancelled (cancelBatch flipped the flag) → CANCELLED. Must win over the in-memory PROCESSING
 *    status set at the start of processBatch, which would otherwise be saved back over the cancellation.
 *  - stopped on the first error (stopOnError) → FAILED, even if some messages were already sent.
 *  - otherwise → COMPLETED, or FAILED only when every attempt failed.
 */
export function resolveFinalBatchStatus(
  cancelled: boolean,
  stoppedOnError: boolean,
  progress: Pick<BatchProgress, 'sent' | 'failed'>,
): BatchStatus {
  if (cancelled) return BatchStatus.CANCELLED;
  if (stoppedOnError) return BatchStatus.FAILED;
  return progress.failed > 0 && progress.sent === 0 ? BatchStatus.FAILED : BatchStatus.COMPLETED;
}

/**
 * Build the error stored on a batch result. An SSRF block names the internal host/IP it refused, so
 * it must never be persisted/returned verbatim — it would be readable via GET batch status. Map it to
 * a generic, code-tagged message; ordinary errors keep their (non-sensitive) message.
 */
export function sanitizeBatchError(error: unknown): { code: string; message: string } {
  if (error instanceof SsrfBlockedError) {
    return { code: 'SEND_BLOCKED', message: SSRF_BLOCKED_CLIENT_MESSAGE };
  }
  return { code: 'SEND_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Per-process cap on concurrently-processing bulk batches. Each in-flight batch holds its full message
 * set (with base64 media) in memory and is dispatched fire-and-forget, so without a ceiling a burst of
 * batches can exhaust host memory. Env-overridable; 0 disables the cap. Default is generous — it only
 * trips a genuine runaway, not normal use. Per-process (not cluster-wide).
 */
const DEFAULT_MAX_CONCURRENT_BATCHES = 50;
export function resolveMaxConcurrentBatches(): number {
  const raw = Number(process.env.BULK_MAX_CONCURRENT_BATCHES);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_CONCURRENT_BATCHES;
  return Math.floor(raw); // 0 = unlimited
}

@Injectable()
export class BulkMessageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BulkMessageService.name);
  private readonly processingBatches = new Map<string, boolean>(); // Track active batches for cancellation
  private inFlightBatches = 0; // count of batches currently in processBatch (memory bound, see cap above)

  constructor(
    @InjectRepository(MessageBatch, 'data')
    private readonly batchRepository: Repository<MessageBatch>,
    private readonly sessionService: SessionService,
    private readonly messageService: MessageService,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * Transition orphaned batches on startup. A batch still in PROCESSING belongs to a
   * previous (crashed/restarted) process — this fresh process is not driving it, so it would
   * otherwise be stuck in PROCESSING forever. Mark it FAILED. Auto-resume is intentionally NOT
   * done here: resuming risks re-sending messages already delivered before the crash.
   */
  async onApplicationBootstrap(): Promise<void> {
    const orphaned = await this.batchRepository.find({ where: { status: BatchStatus.PROCESSING } });
    for (const batch of orphaned) {
      batch.status = BatchStatus.FAILED;
      await this.batchRepository.save(batch);
    }
    if (orphaned.length > 0) {
      this.logger.warn(
        `Marked ${orphaned.length} orphaned PROCESSING batch(es) FAILED on startup (interrupted by a restart)`,
      );
    }
  }

  async createBatch(sessionId: string, dto: SendBulkMessageDto): Promise<MessageBatch> {
    // Validate session exists
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active`);
    }

    // Bound every outbound base64 blob to the media byte cap before the whole messages array (with
    // its base64 payloads) is persisted into the batch row. Mirrors the single-send cap in
    // MessageService.buildMediaInput.
    for (const { content } of dto.messages) {
      assertBase64WithinMediaCap(content?.image?.base64);
      assertBase64WithinMediaCap(content?.video?.base64);
      assertBase64WithinMediaCap(content?.audio?.base64);
      assertBase64WithinMediaCap(content?.document?.base64);
    }

    const batchId = dto.batchId || `batch_${randomUUID().split('-')[0]}`;

    // Check if this batchId already exists FOR THIS SESSION. Scoping by sessionId (matching how
    // getBatchStatus/cancelBatch already query) makes (sessionId, batchId) the namespace: one session
    // can't deny another a batchId, and the 400-vs-202 difference can't probe another session's ids.
    const existing = await this.batchRepository.findOne({ where: { batchId, sessionId } });
    if (existing) {
      throw new BadRequestException(`Batch ID '${batchId}' already exists`);
    }

    // Reject before persisting a row when too many batches are already processing, so a burst can't
    // hold an unbounded number of full message sets (base64 media included) in memory at once.
    const maxConcurrentBatches = resolveMaxConcurrentBatches();
    if (maxConcurrentBatches > 0 && this.inFlightBatches >= maxConcurrentBatches) {
      throw new BadRequestException(`Too many bulk batches in progress (max ${maxConcurrentBatches}); retry shortly`);
    }

    const options = {
      delayBetweenMessages: dto.options?.delayBetweenMessages ?? 3000,
      randomizeDelay: dto.options?.randomizeDelay ?? true,
      stopOnError: dto.options?.stopOnError ?? false,
    };

    const progress: BatchProgress = {
      total: dto.messages.length,
      sent: 0,
      failed: 0,
      pending: dto.messages.length,
      cancelled: 0,
    };

    const batch = this.batchRepository.create({
      batchId,
      sessionId,
      status: BatchStatus.PENDING,
      messages: dto.messages as MessageBatch['messages'],
      options,
      progress,
      results: [],
      currentIndex: 0,
    });

    await this.batchRepository.save(batch);
    this.logger.log(`Created batch ${batchId} with ${dto.messages.length} messages`);

    // Start processing asynchronously
    this.processBatch(batch.id).catch(err => {
      this.logger.error(`Batch ${batchId} processing error: ${String(err)}`);
    });

    return batch;
  }

  async getBatchStatus(sessionId: string, batchId: string): Promise<MessageBatch> {
    const batch = await this.batchRepository.findOne({
      where: { batchId, sessionId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch '${batchId}' not found`);
    }

    return batch;
  }

  async cancelBatch(sessionId: string, batchId: string): Promise<MessageBatch> {
    const batch = await this.batchRepository.findOne({
      where: { batchId, sessionId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch '${batchId}' not found`);
    }

    if (batch.status === BatchStatus.COMPLETED || batch.status === BatchStatus.CANCELLED) {
      throw new BadRequestException(`Batch '${batchId}' is already ${batch.status}`);
    }

    // Signal cancellation
    this.processingBatches.set(batch.id, false);

    // Update status
    batch.status = BatchStatus.CANCELLED;
    batch.progress.cancelled = batch.progress.pending;
    batch.progress.pending = 0;
    batch.completedAt = new Date();

    await this.batchRepository.save(batch);
    this.logger.log(`Cancelled batch ${batchId}`);

    return batch;
  }

  private async processBatch(batchDbId: string): Promise<void> {
    const batch = await this.batchRepository.findOne({ where: { id: batchDbId } });
    if (!batch) return;

    this.processingBatches.set(batch.id, true);
    // Always release the in-flight marker on every exit path (engine-not-found early return, a thrown
    // save/send, or normal completion) — otherwise the map leaks an entry per such batch.
    try {
      this.inFlightBatches++;
      await this.executeBatch(batch);
    } finally {
      this.inFlightBatches--;
      this.processingBatches.delete(batch.id);
    }
  }

  private async executeBatch(batch: MessageBatch): Promise<void> {
    // Update status to processing
    batch.status = BatchStatus.PROCESSING;
    batch.startedAt = new Date();
    await this.batchRepository.save(batch);

    const engine = this.sessionService.getEngine(batch.sessionId);
    if (!engine) {
      batch.status = BatchStatus.FAILED;
      batch.completedAt = new Date();
      await this.batchRepository.save(batch);
      return;
    }

    const results: BatchMessageResult[] = batch.results || [];
    let stoppedOnError = false;
    let cancelledByDb = false;

    for (let i = batch.currentIndex; i < batch.messages.length; i++) {
      // Check for cancellation
      if (!this.processingBatches.get(batch.id)) {
        this.logger.log(`Batch ${batch.batchId} cancelled at index ${i}`);
        break;
      }

      const msg = batch.messages[i];
      const result: BatchMessageResult = {
        chatId: msg.chatId,
        status: BatchMessageStatus.PENDING,
      };

      // Hoisted so the failure hook below can report the exact (variable-applied / plugin-modified)
      // content that was attempted, even when applyVariables or the send throws.
      let content: BulkMessageContent = msg.content;
      // Set when the message:sending gate blocked this item, so the catch treats it as a moderation
      // decision (not a delivery failure) and skips message:failed — matching the single-send path,
      // where a block is a 400 with no failure hook.
      let blockedByPlugin = false;
      try {
        // Apply template variables
        content = this.applyVariables(msg.content, msg.variables);

        // Per-message moderation gate — the SAME message:sending hook single sends use, so a
        // compliance/moderation plugin sees bulk traffic too (bulk previously bypassed it entirely).
        // A block fails just THIS message (honouring stopOnError below); a plugin may also rewrite it.
        const gate = await this.hookManager.execute(
          'message:sending',
          { sessionId: batch.sessionId, input: content, type: msg.type },
          { sessionId: batch.sessionId, source: 'BulkMessageService' },
        );
        if (!gate.continue) {
          blockedByPlugin = true;
          throw new BadRequestException('Message sending blocked by plugin');
        }
        content = (gate.data as { input: BulkMessageContent }).input;

        // Send message based on type
        const messageResult = await this.sendMessage(engine, msg.chatId, msg.type, content);

        result.status = BatchMessageStatus.SENT;
        result.messageId = messageResult.id;
        result.sentAt = new Date();
        batch.progress.sent++;
        batch.progress.pending--;

        // Persist like a single send so the message shows in chat history + stats. The engine echo
        // (onMessageCreate) fires the webhook/WS but does NOT write the DB, so without this the
        // bulk-sent message is invisible to the messages table.
        await this.persistSentMessage(batch.sessionId, msg.chatId, msg.type, content, messageResult);

        this.logger.debug(`Batch ${batch.batchId}: Sent message ${i + 1}/${batch.messages.length} to ${msg.chatId}`);
      } catch (error) {
        result.status = BatchMessageStatus.FAILED;
        // Sanitize: an SSRF block names an internal address — never store/return/log it verbatim.
        const sanitized = sanitizeBatchError(error);
        result.error = sanitized;
        batch.progress.failed++;
        batch.progress.pending--;

        // Fire message:failed so alerting/analytics plugins observe bulk failures too (previously
        // none) — but NOT for a plugin gate-block, which is a moderation decision, not a delivery
        // failure (matches single send, where a block is a 400 with no message:failed).
        if (!blockedByPlugin) {
          await this.hookManager.execute(
            'message:failed',
            { sessionId: batch.sessionId, error: sanitized.message, input: content, type: msg.type },
            { sessionId: batch.sessionId, source: 'BulkMessageService' },
          );
        }

        this.logger.warn(`Batch ${batch.batchId}: Failed message ${i + 1} to ${msg.chatId}: ${sanitized.message}`);

        if (batch.options.stopOnError) {
          batch.status = BatchStatus.FAILED;
          stoppedOnError = true;
          results.push(result);
          break;
        }
      }

      results.push(result);
      batch.currentIndex = i + 1;
      batch.results = results;

      // Save progress periodically (every 10 messages or last message)
      if (i % 10 === 0 || i === batch.messages.length - 1) {
        // Honor a cancellation issued by ANOTHER instance / after a restart — the in-memory Map only
        // sees same-process cancels. Re-read the status BEFORE saving so we don't clobber a CANCELLED
        // back to PROCESSING.
        const fresh = await this.batchRepository.findOne({ where: { id: batch.id }, select: ['status'] });
        if (fresh?.status === BatchStatus.CANCELLED) {
          cancelledByDb = true;
          this.logger.log(`Batch ${batch.batchId} cancelled (DB) at index ${i}`);
          break;
        }
        await this.batchRepository.save(batch);
      }

      // Delay before next message (except for last)
      if (i < batch.messages.length - 1 && this.processingBatches.get(batch.id)) {
        const delay = this.calculateDelay(batch.options);
        await this.sleep(delay);
      }
    }

    // Final update. NOTE: `batch` still holds the in-memory PROCESSING status from the start, so a
    // cancellation persisted by cancelBatch would be overwritten if we saved without re-deriving it.
    // A cancel may also have landed AFTER the last cadence re-read (multi-replica / post-restart); the
    // unconditional save below would clobber it back to a terminal non-cancelled status, so re-read
    // once more here unless we already know the batch was cancelled.
    if (!cancelledByDb) {
      const fresh = await this.batchRepository.findOne({ where: { id: batch.id }, select: ['status'] });
      if (fresh?.status === BatchStatus.CANCELLED) {
        cancelledByDb = true;
      }
    }
    const cancelled = cancelledByDb || !this.processingBatches.get(batch.id);
    batch.status = resolveFinalBatchStatus(cancelled, stoppedOnError, batch.progress);
    if (cancelled) {
      // Reconcile the counters the same way cancelBatch does, so the persisted state is consistent.
      batch.progress.cancelled = batch.progress.pending;
      batch.progress.pending = 0;
    }
    batch.completedAt = new Date();
    batch.results = results;
    // The batch is terminal now (never resumed), so drop the base64 media payloads before persisting —
    // otherwise the message_batches row retains multi-MB media forever. Intermediate (cadence) saves
    // above keep the payload so a batch interrupted mid-run can still resume from currentIndex.
    this.stripBatchMediaPayloads(batch.messages);
    await this.batchRepository.save(batch);

    this.logger.log(`Batch ${batch.batchId} completed: ${batch.progress.sent} sent, ${batch.progress.failed} failed`);
  }

  /**
   * Drop base64 payloads from a finished batch's stored message list. A completed/cancelled batch is
   * terminal (never resumed), so the (often multi-MB) base64 in `message_batches.messages` is dead
   * weight; the descriptive fields (mimetype/filename/caption/url) are kept.
   */
  private stripBatchMediaPayloads(messages: MessageBatch['messages']): void {
    for (const m of messages) {
      for (const key of ['image', 'video', 'audio', 'document']) {
        const media = m.content[key] as { base64?: unknown } | undefined;
        if (media && typeof media === 'object' && 'base64' in media) {
          delete media.base64;
        }
      }
    }
  }

  private applyVariables(content: BulkMessageContent, variables?: Record<string, string>): BulkMessageContent {
    if (!variables) return content;

    // Delegate to the shared renderer so the gateway exposes one templating syntax (#69). It
    // substitutes canonical `{{name}}` placeholders and still honors the legacy single-brace
    // `{name}` this endpoint historically used (deprecated — prefer `{{name}}`).
    const replaceVars = (str: string): string => renderTemplate(str, variables);

    const processValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return replaceVars(value);
      }
      if (Array.isArray(value)) {
        return value.map(processValue);
      }
      if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          result[k] = processValue(v);
        }
        return result;
      }
      return value;
    };

    return processValue(content) as BulkMessageContent;
  }

  /**
   * Persist a successfully-sent batch message via the shared single-send persistence path, so it
   * shows up in chat history and stats like any other outgoing message. Best-effort: a persistence
   * failure must never flip a message that actually went out to FAILED.
   */
  private async persistSentMessage(
    sessionId: string,
    chatId: string,
    type: string,
    content: BulkMessageContent,
    result: MessageResult,
  ): Promise<void> {
    const media = content.image ?? content.video ?? content.audio ?? content.document;
    // A bulk audio item flagged ptt is a voice note; store it in the 'voice' bucket like inbound PTT.
    const persistType = type === 'audio' && content.audio?.ptt ? 'voice' : type;
    try {
      await this.messageService.saveOutgoingMessage(sessionId, {
        waMessageId: result.id,
        chatId,
        body: content.text ?? content.caption ?? '',
        type: persistType,
        timestamp: result.timestamp,
        status: MessageStatus.SENT,
        metadata: media
          ? {
              media: {
                mimetype: media.mimetype,
                data: media.url ?? media.base64,
                filename: media.filename,
              },
            }
          : undefined,
      });
    } catch (error) {
      this.logger.warn(`Batch message persisted-after-send failed: ${String(error)}`);
    }
  }

  private sendMessage(
    engine: IWhatsAppEngine,
    chatId: string,
    type: string,
    content: BulkMessageContent,
  ): Promise<MessageResult> {
    switch (type) {
      case 'text':
        return engine.sendTextMessage(chatId, content.text || '');
      case 'image':
        return engine.sendImageMessage(chatId, {
          mimetype: content.image?.mimetype || 'image/jpeg',
          data: content.image?.url || content.image?.base64 || '',
          caption: content.caption,
        });
      case 'video':
        return engine.sendVideoMessage(chatId, {
          mimetype: content.video?.mimetype || 'video/mp4',
          data: content.video?.url || content.video?.base64 || '',
          caption: content.caption,
        });
      case 'audio':
        return engine.sendAudioMessage(chatId, {
          mimetype: content.audio?.mimetype || (content.audio?.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
          data: content.audio?.url || content.audio?.base64 || '',
          ptt: content.audio?.ptt,
        });
      case 'document':
        return engine.sendDocumentMessage(chatId, {
          mimetype: content.document?.mimetype || 'application/octet-stream',
          data: content.document?.url || content.document?.base64 || '',
          filename: content.document?.filename,
          caption: content.caption,
        });
      default:
        return Promise.reject(new Error(`Unsupported message type: ${type}`));
    }
  }

  private calculateDelay(options: { delayBetweenMessages: number; randomizeDelay: boolean }): number {
    let delay = options.delayBetweenMessages;
    if (options.randomizeDelay) {
      delay += Math.random() * 2000; // Add 0-2 seconds random
    }
    return delay;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
