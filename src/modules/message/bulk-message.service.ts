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
import { assertBase64WithinMediaCap } from './media-cap.util';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { renderTemplate } from '../../common/utils/template-render';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';

// Type definitions for bulk message content
interface BulkMessageContent {
  text?: string;
  caption?: string;
  image?: { url?: string; base64?: string; mimetype?: string };
  video?: { url?: string; base64?: string; mimetype?: string };
  audio?: { url?: string; base64?: string; mimetype?: string };
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
    return { code: 'SEND_BLOCKED', message: 'Destination address is not allowed' };
  }
  return { code: 'SEND_FAILED', message: error instanceof Error ? error.message : String(error) };
}

@Injectable()
export class BulkMessageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BulkMessageService.name);
  private readonly processingBatches = new Map<string, boolean>(); // Track active batches for cancellation

  constructor(
    @InjectRepository(MessageBatch, 'data')
    private readonly batchRepository: Repository<MessageBatch>,
    private readonly sessionService: SessionService,
    private readonly messageService: MessageService,
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

    // Check if batchId already exists
    const existing = await this.batchRepository.findOne({ where: { batchId } });
    if (existing) {
      throw new BadRequestException(`Batch ID '${batchId}' already exists`);
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

      try {
        // Apply template variables
        const content: BulkMessageContent = this.applyVariables(msg.content, msg.variables);

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
    await this.batchRepository.save(batch);

    this.processingBatches.delete(batch.id);
    this.logger.log(`Batch ${batch.batchId} completed: ${batch.progress.sent} sent, ${batch.progress.failed} failed`);
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
    try {
      await this.messageService.saveOutgoingMessage(sessionId, {
        waMessageId: result.id,
        chatId,
        body: content.text ?? content.caption ?? '',
        type,
        timestamp: result.timestamp,
        status: MessageStatus.SENT,
        metadata: media
          ? {
              media: {
                mimetype: media.mimetype,
                data: media.url ?? media.base64,
                filename: content.document?.filename,
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
          mimetype: content.audio?.mimetype || 'audio/mpeg',
          data: content.audio?.url || content.audio?.base64 || '',
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
