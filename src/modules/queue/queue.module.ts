import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookProcessor } from './processors/webhook.processor';
import { IngressProcessor } from './processors/ingress.processor';
import { QUEUE_NAMES } from './queue-names';
import { queueConnectionOptions } from './redis-connection';
import { ShutdownSafeQueue } from './shutdown-safe-queue';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { HooksModule } from '../../core/hooks/hooks.module';
import { PluginsModule } from '../../core/plugins/plugins.module';

// Re-export for backward compatibility
export { QUEUE_NAMES } from './queue-names';

/**
 * Bounded retention for finished webhook-queue jobs. Failed webhook jobs carry their full payload in
 * Redis until eviction, so the window must stay small — the durable record of a lost delivery is the
 * webhook_delivery_failures row written on the final attempt, not the Redis job. The payload itself
 * is additionally size-gated (media shed) before enqueue, so count × bytes both stay bounded.
 */
export const WEBHOOK_QUEUE_JOB_OPTIONS = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400, count: 5000 },
} as const;

// Read when registerQueue runs below, so it has to be set before the @Module decorator is evaluated.
BullModule.queueClass = ShutdownSafeQueue;

@Module({
  imports: [
    // Required for WebhookProcessor to inject Repository<Webhook> + Repository<WebhookDeliveryFailure>;
    // IngressProcessor to inject Repository<IntegrationDeliveryFailure> + Repository<IngressEvent> (all on
    // the 'data' connection).
    TypeOrmModule.forFeature(
      [Webhook, WebhookDeliveryFailure, WebhookOutboxEvent, IntegrationDeliveryFailure, IngressEvent],
      'data',
    ),
    // Required for WebhookProcessor/IngressProcessor to inject HookManager
    HooksModule,
    // Required for IngressProcessor to inject PluginLoaderService (already @Global(), imported
    // explicitly for clarity, matching HooksModule above).
    PluginsModule,
    BullModule.forRootAsync({
      useFactory: () => ({ connection: queueConnectionOptions() }),
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.WEBHOOK,
      // Auto-evict finished jobs so completed/failed webhook payloads don't accumulate in Redis
      // unbounded. Keep a small recent window for debugging; cap age too.
      defaultJobOptions: WEBHOOK_QUEUE_JOB_OPTIONS,
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
  providers: [WebhookProcessor, IngressProcessor, WebhookOutboxService],
  exports: [BullModule],
})
export class QueueModule {}
