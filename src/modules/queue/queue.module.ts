import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookProcessor } from './processors/webhook.processor';
import { IngressProcessor } from './processors/ingress.processor';
import { QUEUE_NAMES } from './queue-names';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { HooksModule } from '../../core/hooks/hooks.module';
import { PluginsModule } from '../../core/plugins/plugins.module';

// Re-export for backward compatibility
export { QUEUE_NAMES } from './queue-names';

@Module({
  imports: [
    // Required for WebhookProcessor to inject Repository<Webhook> + Repository<WebhookDeliveryFailure>;
    // IngressProcessor to inject Repository<IntegrationDeliveryFailure> (both on the 'data' connection).
    TypeOrmModule.forFeature([Webhook, WebhookDeliveryFailure, IntegrationDeliveryFailure], 'data'),
    // Required for WebhookProcessor/IngressProcessor to inject HookManager
    HooksModule,
    // Required for IngressProcessor to inject PluginLoaderService (already @Global(), imported
    // explicitly for clarity, matching HooksModule above).
    PluginsModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host', 'localhost'),
          port: configService.get<number>('redis.port', 6379),
          password: configService.get<string>('redis.password'),
          connectTimeout: configService.get<number>('redis.connectTimeoutMs', 5000),
          enableOfflineQueue: false,
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
    BullModule.registerQueue({
      name: QUEUE_NAMES.INGRESS,
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
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.INGRESS,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [WebhookProcessor, IngressProcessor],
  exports: [BullModule],
})
export class QueueModule {}
