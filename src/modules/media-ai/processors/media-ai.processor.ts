import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { MediaAiResult } from '../entities/media-ai-result.entity';
import { MediaAiService } from '../media-ai.service';
import { QUEUE_NAMES } from '../../queue/queue-names';
import { WebhookService } from '../../webhook/webhook.service';
import { createLogger } from '../../../common/services/logger.service';

export interface MediaAiJobData {
  messageId: string;
  sessionId: string;
  mediaType: 'audio' | 'image' | 'video' | 'document';
  mediaData: string; // base64
  mimeType: string;
}

@Processor(QUEUE_NAMES.MEDIA_AI, { concurrency: 2 })
export class MediaAiProcessor extends WorkerHost {
  private readonly logger = createLogger('MediaAiProcessor');
  private readonly quarantinePath: string;

  constructor(
    @InjectRepository(MediaAiResult, 'data')
    private readonly resultRepo: Repository<MediaAiResult>,
    private readonly mediaAiService: MediaAiService,
    private readonly webhookService: WebhookService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.quarantinePath = configService.get<string>('mediaAi.quarantinePath', './data/quarantine');
  }

  async process(job: Job<MediaAiJobData>): Promise<void> {
    const { messageId, sessionId, mediaType, mediaData, mimeType } = job.data;
    const start = Date.now();

    this.logger.log(`Processing media AI job`, { messageId, sessionId, mediaType });

    const buffer = Buffer.from(mediaData, 'base64');
    const result = this.resultRepo.create({ messageId, sessionId, mediaType });
    const aiPayload: Record<string, unknown> = {};

    try {
      if (mediaType === 'audio' && this.mediaAiService.isSttConfigured()) {
        const sttResult = await this.mediaAiService.transcribe(buffer, mimeType);
        result.transcription = sttResult.text;
        result.detectedLanguage = sttResult.language;
        aiPayload['transcription'] = {
          text: sttResult.text,
          language: sttResult.language,
          duration: sttResult.durationMs,
        };
      }

      if (mediaType === 'image' && this.mediaAiService.isOcrConfigured()) {
        // Moderation FIRST (before any storage)
        if (this.mediaAiService.isModerationConfigured()) {
          const modResult = await this.mediaAiService.moderateImage(buffer, mimeType);
          result.moderationFlagged = modResult.flagged;
          result.moderationCategories = JSON.stringify(modResult.categories);
          aiPayload['moderation'] = { flagged: modResult.flagged, categories: modResult.categories };

          if (modResult.flagged) {
            await this.quarantine(messageId, buffer, mimeType);
            void this.webhookService.dispatch(sessionId, 'media.flagged', {
              messageId,
              categories: modResult.categories,
            });
          }
        }

        const ocrResult = await this.mediaAiService.extractText(buffer);
        if (ocrResult.text.trim().length > 0) {
          result.ocrText = ocrResult.text;
          aiPayload['ocr'] = { text: ocrResult.text, confidence: ocrResult.confidence };
        } else {
          const description = await this.mediaAiService.describeImage(buffer);
          result.imageDescription = description;
          aiPayload['imageDescription'] = description;
        }
      }

      result.processingTimeMs = Date.now() - start;
      await this.resultRepo.save(result);

      if (Object.keys(aiPayload).length > 0) {
        void this.webhookService.dispatch(sessionId, 'message.ai', { messageId, ai: aiPayload });
      }

      this.logger.log(`Media AI processed`, { messageId, mediaType, ms: result.processingTimeMs });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Media AI processing failed`, msg, { messageId, mediaType });
      // Save partial result so the job is tracked even on partial failure
      result.processingTimeMs = Date.now() - start;
      await this.resultRepo.save(result).catch(() => undefined);
      // Don't rethrow — failures should not block message delivery
    }
  }

  private async quarantine(messageId: string, buffer: Buffer, mimeType: string): Promise<void> {
    try {
      if (!fs.existsSync(this.quarantinePath)) {
        fs.mkdirSync(this.quarantinePath, { recursive: true });
      }
      const ext = mimeType.split('/')[1] ?? 'bin';
      const filename = path.join(this.quarantinePath, `${messageId}.${ext}`);
      fs.writeFileSync(filename, buffer);
      this.logger.warn(`Flagged media quarantined`, { messageId, filename });
    } catch (err) {
      this.logger.error(`Quarantine write failed`, String(err), { messageId });
    }
  }
}
