import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PluginInstance } from './entities/plugin-instance.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { IngressEventService } from './ingress-event.service';
import { IngressService, IngressRouteDescriptor } from './ingress.service';
import { IngressController } from './ingress.controller';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { QUEUE_NAMES } from '../queue/queue-names';
import { createLogger } from '../../common/services/logger.service';

// The ingress queue token. The queue provider only exists when QueueModule is imported
// (QUEUE_ENABLED=true); otherwise this token has no value and the factory below falls back to inline
// dispatch — mirroring WebhookService's direct-delivery fallback.
const INGRESS_QUEUE_TOKEN = getQueueToken(QUEUE_NAMES.INGRESS);

/**
 * Wires the @Public ingress HTTP surface: instance/event persistence services and the fast-ack
 * IngressService, whose deps are built by a factory so the pure pipeline stays DI-free and testable.
 * The optional ingress queue is resolved by token — present only under QUEUE_ENABLED — and the
 * factory picks enqueue-vs-inline exactly like the webhook producer. PluginLoaderService is @Global
 * (PluginsModule), so it injects without importing that module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PluginInstance, IngressEvent], 'data')],
  controllers: [IngressController],
  providers: [
    PluginInstanceService,
    IngressEventService,
    {
      provide: IngressService,
      // The queue token is OPTIONAL: without QUEUE_ENABLED there is no provider for it, and a required
      // dependency would fail to resolve at boot. Optional → undefined, and the factory falls back to inline.
      inject: [
        PluginInstanceService,
        IngressEventService,
        PluginLoaderService,
        ConfigService,
        { token: INGRESS_QUEUE_TOKEN, optional: true },
      ],
      useFactory: (
        instances: PluginInstanceService,
        events: IngressEventService,
        loader: PluginLoaderService,
        config: ConfigService,
        ingressQueue?: Queue<IngressJobData>,
      ) => {
        const logger = createLogger('IngressService');
        const queueEnabled = config.get<boolean>('queue.enabled', false);
        const useQueue = queueEnabled && !!ingressQueue;

        return new IngressService({
          instances: { resolve: (pluginId, instanceId) => instances.resolve(pluginId, instanceId) },
          manifestRoute: (pluginId, route): IngressRouteDescriptor | undefined =>
            loader.getPlugin(pluginId)?.manifest.ingress?.find(r => r.route === route),
          events: { recordOrSkip: input => events.recordOrSkip(input) },
          enqueue: async (data, jobId) => {
            if (useQueue && ingressQueue) {
              // jobId = deliveryId gives BullMQ exactly-once enqueue semantics.
              await ingressQueue.add('ingress', data, { jobId });
              return;
            }
            // Queue disabled: dispatch inline AFTER the ingress_events row was persisted
            // (persist-before-dispatch still holds), mirroring the webhook direct-delivery fallback.
            try {
              await loader.dispatchWebhookForInstance(data);
            } catch (err) {
              // A duplicate delivery already 200s before this point, so a failure here is a real
              // dispatch error. Log and swallow: the row is durably persisted for a later redrive,
              // and the provider still gets its 202 (at-least-once, like the webhook fallback).
              logger.error('Inline ingress dispatch failed', err instanceof Error ? err.message : String(err), {
                pluginId: data.pluginId,
                instanceId: data.instanceId,
                route: data.route,
                deliveryId: data.deliveryId,
                action: 'ingress_inline_dispatch_failed',
              });
            }
          },
          now: () => Date.now(),
        });
      },
    },
  ],
  exports: [PluginInstanceService, IngressEventService],
})
export class IntegrationModule {}
