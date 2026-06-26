import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookProcessor } from './processors/webhook.processor';
import { QUEUE_NAMES } from './queue-names';
import { Webhook } from '../webhook/entities/webhook.entity';
import { HooksModule } from '../../core/hooks/hooks.module';

// Re-export for backward compatibility
export { QUEUE_NAMES } from './queue-names';

@Module({
  imports: [
    // Required for WebhookProcessor to inject Repository<Webhook>
    TypeOrmModule.forFeature([Webhook], 'data'),
    // Required for WebhookProcessor to inject HookManager
    HooksModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host', 'localhost'),
          port: configService.get<number>('redis.port', 6379),
          password: configService.get<string>('redis.password'),
        },
      }),
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.WEBHOOK,
      // Auto-evict finished jobs so completed/failed webhook payloads don't accumulate in Redis
      // unbounded. Keep a small recent window for debugging; cap age too.
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 5000 },
      },
    }),
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.WEBHOOK,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [WebhookProcessor],
  exports: [BullModule],
})
export class QueueModule {}
