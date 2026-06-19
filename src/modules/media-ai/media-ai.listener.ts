import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { HookManager } from '../../core/hooks';
import { HookContext, HookResult } from '../../core/hooks/hook.interfaces';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { QUEUE_NAMES } from '../queue/queue-names';
import { MediaAiJobData } from './processors/media-ai.processor';
import { createLogger } from '../../common/services/logger.service';

@Injectable()
export class MediaAiListener implements OnModuleInit {
  private readonly logger = createLogger('MediaAiListener');

  constructor(
    private readonly hookManager: HookManager,
    @Optional()
    @InjectQueue(QUEUE_NAMES.MEDIA_AI)
    private readonly queue: Queue<MediaAiJobData> | null,
  ) {}

  onModuleInit(): void {
    if (!this.queue) {
      this.logger.warn('MEDIA_AI queue not available — media AI hook disabled');
      return;
    }
    this.hookManager.register(
      'media-ai',
      'message:received',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>),
      100, // low priority — runs after business hooks
    );
    this.logger.log('Media AI message hook registered');
  }

  private async onMessage(ctx: HookContext<IncomingMessage>): Promise<HookResult> {
    const message = ctx.data;
    const { sessionId } = ctx;

    if (!sessionId || !message.media?.data || message.media.data === '') {
      return { continue: true };
    }

    const mediaType = this.resolveMediaType(message.type);
    if (!mediaType) return { continue: true };

    const jobData: MediaAiJobData = {
      messageId: message.id,
      sessionId,
      mediaType,
      mediaData: message.media.data,
      mimeType: message.media.mimetype,
    };

    try {
      await this.queue!.add(`media-ai-${message.id}`, jobData, {
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400, count: 1000 },
      });
    } catch (error) {
      this.logger.error('Failed to enqueue media AI job', String(error), { messageId: message.id });
    }

    return { continue: true };
  }

  private resolveMediaType(type: string): 'audio' | 'image' | 'video' | 'document' | null {
    if (type === 'ptt' || type === 'audio') return 'audio';
    if (type === 'image') return 'image';
    if (type === 'video') return 'video';
    if (type === 'document') return 'document';
    return null;
  }
}
