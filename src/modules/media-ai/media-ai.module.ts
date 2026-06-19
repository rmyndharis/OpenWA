import { Module, DynamicModule, Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MediaAiResult } from './entities/media-ai-result.entity';
import { MediaAiService } from './media-ai.service';
import { MediaAiController } from './media-ai.controller';
import { MediaAiListener } from './media-ai.listener';
import { MediaAiProcessor } from './processors/media-ai.processor';
import { WebhookModule } from '../webhook/webhook.module';
import { QUEUE_NAMES } from '../queue/queue-names';

// Only register BullMQ queue + processor when Redis queue is enabled
const queueProviders: Array<Type> = [];
const queueImports: Array<DynamicModule> = [];

if (process.env.QUEUE_ENABLED === 'true') {
  queueImports.push(
    BullModule.registerQueue({
      name: QUEUE_NAMES.MEDIA_AI,
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400, count: 1000 },
      },
    }),
  );
  queueProviders.push(MediaAiProcessor);
}

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([MediaAiResult], 'data'),
    WebhookModule,
    ...queueImports,
  ],
  providers: [MediaAiService, MediaAiListener, ...queueProviders],
  controllers: [MediaAiController],
  exports: [MediaAiService],
})
export class MediaAiModule {}
