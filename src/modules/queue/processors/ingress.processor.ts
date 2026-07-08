import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, ingressWorkerConcurrency } from '../redis-connection';
import { IntegrationDeliveryFailure } from '../../integration/entities/integration-delivery-failure.entity';
import { PluginLoaderService } from '../../../core/plugins/plugin-loader.service';
import { HookManager } from '../../../core/hooks';
import { createLogger } from '../../../common/services/logger.service';
import { KeyedAsyncLock, orderingKeyFor } from '../../integration/ordering-lock';

export interface IngressJobData {
  pluginId: string;
  instanceId: string;
  route: string;
  deliveryId: string;
  sessionId?: string;
  // Best-effort provider conversation id, extracted host-side from the manifest's conversationId
  // pointer. Undefined when the route declares no pointer — the per-conversation ordering lock then
  // serializes per instance instead (see orderingKeyFor in ../../integration/ordering-lock).
  providerConversationId?: string;
  payload: { headers: Record<string, string>; query: Record<string, string>; body: string; rawBody: string };
}

// The KeyedAsyncLock wrapping dispatch below guarantees no two dispatches for the SAME conversation
// run concurrently (mutual exclusion + in-order START for events as they reach the worker), so the
// worker no longer needs concurrency 1 — raising it parallelizes UNRELATED conversations instead of
// head-of-line-blocking every inbound event behind the slowest one. Strict end-to-end order is NOT
// preserved across a BullMQ retry: a retried job re-enters lock.run() after its backoff and chains at
// the conversation's CURRENT tail, so it can overtake a same-conversation successor that dispatched
// during the backoff window. This is a deliberate tradeoff — BullMQ retries release the worker slot
// during backoff (better throughput under transient failure), where retrying inside the lock would
// hold it — and is acceptable because ingress order is best-effort regardless: the provider delivers
// over unordered HTTP. Order-strict plugins must not assume retry-involved events arrive in sequence.
@Processor(QUEUE_NAMES.INGRESS, { connection: workerConnectionOptions(), concurrency: ingressWorkerConcurrency() })
export class IngressProcessor extends WorkerHost {
  private readonly logger = createLogger('IngressProcessor');
  private readonly lock = new KeyedAsyncLock();

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
      await this.lock.run(orderingKeyFor(d), () => this.loader.dispatchWebhookForInstance(d));
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
