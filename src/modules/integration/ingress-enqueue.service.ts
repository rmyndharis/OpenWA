import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { QUEUE_NAMES } from '../queue/queue-names';
import { createLogger } from '../../common/services/logger.service';

/**
 * Shared queue-or-inline enqueue for inbound ingress jobs. Extracted out of IngressService's DI
 * factory (integration.module.ts) so RedriveService can reuse the exact same behavior when replaying
 * DLQ rows: same queue.add args, same inline dispatch-after-persist fallback, same error swallow.
 * The ingress queue is OPTIONAL — it only exists as a provider under QUEUE_ENABLED (QueueModule) —
 * so a missing injection falls back to inline dispatch, mirroring WebhookService's direct fallback.
 */
@Injectable()
export class IngressEnqueueService {
  private readonly logger = createLogger('IngressEnqueueService');

  constructor(
    private readonly loader: PluginLoaderService,
    private readonly config: ConfigService,
    @Optional() @InjectQueue(QUEUE_NAMES.INGRESS) private readonly ingressQueue?: Queue<IngressJobData>,
  ) {}

  async enqueue(data: IngressJobData, jobId: string): Promise<void> {
    const queueEnabled = this.config.get<boolean>('queue.enabled', false);
    const useQueue = queueEnabled && !!this.ingressQueue;

    if (useQueue && this.ingressQueue) {
      // jobId = deliveryId gives BullMQ exactly-once enqueue semantics.
      await this.ingressQueue.add('ingress', data, { jobId });
      return;
    }
    // Queue disabled: dispatch inline AFTER the ingress_events row was persisted
    // (persist-before-dispatch still holds), mirroring the webhook direct-delivery fallback.
    try {
      await this.loader.dispatchWebhookForInstance(data);
    } catch (err) {
      // A duplicate delivery already 200s before this point, so a failure here is a real
      // dispatch error. Log and swallow: the row is durably persisted for a later redrive,
      // and the provider still gets its 202 (at-least-once, like the webhook fallback).
      this.logger.error('Inline ingress dispatch failed', err instanceof Error ? err.message : String(err), {
        pluginId: data.pluginId,
        instanceId: data.instanceId,
        route: data.route,
        deliveryId: data.deliveryId,
        action: 'ingress_inline_dispatch_failed',
      });
    }
  }
}
