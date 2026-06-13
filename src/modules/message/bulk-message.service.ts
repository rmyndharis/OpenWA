import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
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
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

// Type definitions for bulk message content
interface BulkMessageContent {
  text?: string;
  caption?: string;
  image?: { url?: string; base64?: string; mimetype?: string };
  video?: { url?: string; base64?: string; mimetype?: string };
  audio?: { url?: string; base64?: string; mimetype?: string };
  document?: { url?: string; base64?: string; mimetype?: string; filename?: string };
}

@Injectable()
export class BulkMessageService {
  private readonly logger = new Logger(BulkMessageService.name);
  private readonly processingBatches = new Map<string, boolean>(); // Track active batches for cancellation

  constructor(
    @InjectRepository(MessageBatch, 'data')
    private readonly batchRepository: Repository<MessageBatch>,
    private readonly sessionService: SessionService,
  ) {}

  async createBatch(sessionId: string, dto: SendBulkMessageDto): Promise<MessageBatch> {
    // Validate session exists
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active`);
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

        this.logger.debug(`Batch ${batch.batchId}: Sent message ${i + 1}/${batch.messages.length} to ${msg.chatId}`);
      } catch (error) {
        result.status = BatchMessageStatus.FAILED;
        result.error = {
          code: 'SEND_FAILED',
          message: String(error),
        };
        batch.progress.failed++;
        batch.progress.pending--;

        this.logger.warn(`Batch ${batch.batchId}: Failed message ${i + 1} to ${msg.chatId}: ${String(error)}`);

        if (batch.options.stopOnError) {
          batch.status = BatchStatus.FAILED;
          results.push(result);
          break;
        }
      }

      results.push(result);
      batch.currentIndex = i + 1;
      batch.results = results;

      // Save progress periodically (every 10 messages or last message)
      if (i % 10 === 0 || i === batch.messages.length - 1) {
        await this.batchRepository.save(batch);
      }

      // Delay before next message (except for last)
      if (i < batch.messages.length - 1 && this.processingBatches.get(batch.id)) {
        const delay = this.calculateDelay(batch.options);
        await this.sleep(delay);
      }
    }

    // Final update
    if (this.processingBatches.get(batch.id)) {
      batch.status =
        batch.progress.failed > 0 && batch.progress.sent === 0 ? BatchStatus.FAILED : BatchStatus.COMPLETED;
    }
    batch.completedAt = new Date();
    batch.results = results;
    await this.batchRepository.save(batch);

    this.processingBatches.delete(batch.id);
    this.logger.log(`Batch ${batch.batchId} completed: ${batch.progress.sent} sent, ${batch.progress.failed} failed`);
  }

  private applyVariables(content: BulkMessageContent, variables?: Record<string, string>): BulkMessageContent {
    if (!variables) return content;

    const replaceVars = (str: string): string => {
      return str.replace(/\{(\w+)\}/g, (_, key: string) => variables[key] || `{${key}}`);
    };

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

  private sendMessage(
    engine: IWhatsAppEngine,
    chatId: string,
    type: string,
    content: BulkMessageContent,
  ): Promise<{ id: string }> {
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
