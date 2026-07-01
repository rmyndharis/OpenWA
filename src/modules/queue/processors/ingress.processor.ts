import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions } from '../redis-connection';
import { IntegrationDeliveryFailure } from '../../integration/entities/integration-delivery-failure.entity';
import { PluginLoaderService } from '../../../core/plugins/plugin-loader.service';
import { HookManager } from '../../../core/hooks';
import { createLogger } from '../../../common/services/logger.service';

export interface IngressJobData {
  pluginId: string;
  instanceId: string;
  route: string;
  deliveryId: string;
  sessionId?: string;
  // Best-effort provider conversation id, extracted host-side from the manifest's conversationId
  // pointer. Undefined when the route declares no pointer — the per-conversation ordering lock then
  // serializes per instance. Carried unused today (concurrency=1) so the scale phase needs no re-plumb.
  providerConversationId?: string;
  payload: { headers: Record<string, string>; query: Record<string, string>; body: string; rawBody: string };
}

// concurrency 1 by design: per-conversation FIFO ordering is refined to a keyed advisory lock in a
// later phase; a single worker keeps ordering correct-by-default until that lock exists.
@Processor(QUEUE_NAMES.INGRESS, { connection: workerConnectionOptions(), concurrency: 1 })
export class IngressProcessor extends WorkerHost {
  private readonly logger = createLogger('IngressProcessor');

  constructor(
    private readonly loader: PluginLoaderService,
    @InjectRepository(IntegrationDeliveryFailure, 'data')
    private readonly failures: Repository<IntegrationDeliveryFailure>,
    private readonly hooks: HookManager,
  ) {
    super();
  }

  async process(job: Job<IngressJobData>): Promise<void> {
    const d = job.data;
    try {
      await this.loader.dispatchWebhookForInstance(d);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      this.logger.error('Ingress dispatch failed', errorMessage, {
        pluginId: d.pluginId,
        instanceId: d.instanceId,
        route: d.route,
        deliveryId: d.deliveryId,
        attempt: job.attemptsMade + 1,
        isFinalAttempt,
        action: 'ingress_dispatch_failed',
      });

      if (isFinalAttempt) {
        await this.hooks.execute(
          'ingress:error',
          { ...d, error: errorMessage },
          { sessionId: d.sessionId, source: 'IngressProcessor' },
        );
        await this.failures.save({
          direction: 'inbound',
          pluginId: d.pluginId,
          instanceId: d.instanceId,
          sessionId: d.sessionId ?? null,
          deliveryId: d.deliveryId,
          attempts: job.attemptsMade + 1,
          lastError: errorMessage,
          // Persist the FULL ingress payload (route + headers/rawBody) so P1 redrive is
          // self-contained and never has to re-read ingress_events.
          payload: { route: d.route, providerConversationId: d.providerConversationId, ingress: d.payload },
          redriven: false,
        });
      }

      // Re-throw to trigger BullMQ's exponential backoff / retry.
      throw err;
    }
  }
}
