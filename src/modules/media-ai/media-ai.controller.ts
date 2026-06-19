import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MediaAiResult } from './entities/media-ai-result.entity';
import { QUEUE_NAMES } from '../queue/queue-names';
import { MediaAiJobData } from './processors/media-ai.processor';

@ApiTags('media-ai')
@ApiBearerAuth()
@Controller('api')
export class MediaAiController {
  constructor(
    @InjectRepository(MediaAiResult, 'data')
    private readonly resultRepo: Repository<MediaAiResult>,
    @Optional()
    @InjectQueue(QUEUE_NAMES.MEDIA_AI)
    private readonly queue: Queue<MediaAiJobData> | null,
  ) {}

  @Get('sessions/:id/media-ai/results')
  @ApiOperation({ summary: 'Get paginated media AI results for a session' })
  async listResults(
    @Param('id') sessionId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('search') search?: string,
    @Query('flagged') flagged?: string,
  ) {
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const where: Record<string, unknown> = { sessionId };
    if (flagged === 'true') where['moderationFlagged'] = true;

    let results: MediaAiResult[];
    let total: number;

    if (search) {
      // Fallback search using LIKE since full-text is not universal across SQLite/Postgres
      [results, total] = await this.resultRepo.findAndCount({
        where: [
          { ...where, transcription: Like(`%${search}%`) },
          { ...where, ocrText: Like(`%${search}%`) },
        ],
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        order: { createdAt: 'DESC' },
      });
    } else {
      [results, total] = await this.resultRepo.findAndCount({
        where,
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        order: { createdAt: 'DESC' },
      });
    }

    return { data: results, total, page: pageNum, limit: limitNum };
  }

  @Get('messages/:id/media-ai')
  @ApiOperation({ summary: 'Get AI results for a specific message' })
  async getMessageResult(@Param('id') messageId: string) {
    const result = await this.resultRepo.findOne({ where: { messageId } });
    if (!result) throw new NotFoundException(`No AI result for message ${messageId}`);
    return result;
  }

  @Post('sessions/:id/media-ai/reprocess/:messageId')
  @ApiOperation({ summary: 'Reprocess a media message through AI pipeline' })
  async reprocess(@Param('id') sessionId: string, @Param('messageId') messageId: string) {
    if (!this.queue) {
      return { queued: false, reason: 'Queue not enabled' };
    }

    const existing = await this.resultRepo.findOne({ where: { messageId, sessionId } });
    if (!existing) throw new NotFoundException(`No AI result record for message ${messageId}`);

    await this.queue.add(
      `media-ai-reprocess-${messageId}`,
      {
        messageId,
        sessionId,
        mediaType: existing.mediaType,
        mediaData: '', // reprocessing needs original data — not stored here
        mimeType: '',
      },
      { removeOnComplete: { age: 3600, count: 100 } },
    );

    return { queued: true, messageId };
  }

  @Get('sessions/:id/media-ai/stats')
  @ApiOperation({ summary: 'Get media AI processing stats for a session' })
  async getStats(@Param('id') sessionId: string) {
    const [total, flagged, transcriptions, ocr] = await Promise.all([
      this.resultRepo.count({ where: { sessionId } }),
      this.resultRepo.count({ where: { sessionId, moderationFlagged: true } }),
      this.resultRepo.count({ where: { sessionId, mediaType: 'audio' } }),
      this.resultRepo.count({ where: { sessionId, mediaType: 'image' } }),
    ]);

    return { total, flagged, transcriptions, ocrExtractions: ocr };
  }
}
