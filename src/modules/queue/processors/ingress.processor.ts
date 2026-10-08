import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, ingressWorkerConcurrency } from '../redis-connection';
import { closeWorkerIfStarted, MAX_WORKER_CLOSE_WAIT_MS } from './close-worker';
import { IntegrationDeliveryFailure } from '../../integration/entities/integration-delivery-failure.entity';
import { IngressEvent } from '../../integration/entities/ingress-event.entity';
import { PluginLoaderService } from '../../../core/plugins/plugin-loader.service';
import { HookManager } from '../../../core/hooks';
import { createLogger } from '../../../common/services/logger.service';
import { KeyedAsyncLock, orderingKeyFor } from '../../integration/ordering-lock';
import { requeuedJobIds } from '../../integration/ingress-enqueue.service';

// BullMQ's failedReason for a job that stalled more than maxStalledCount (see WebhookProcessor).
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';

// How long a delivery whose dead-letter row could not be written waits before it runs again.
const REQUEUE_DELAY_MS = 60_000;

// The id suffix deadLetterOrRequeue gives a re-queued delivery (see requeuedJobIds).
const REQUEUED_JOB_ID = /-requeued-[12]$/;

export interface IngressJobData {
  pluginId: string;
  instanceId: string;
  route: string;
  // Optional for backward compatibility with jobs and DLQ rows persisted before method forwarding.
  method?: string;
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
// worker no longer needs concurrency 1: raising it parallelizes unrelated conversations. The lock is
// taken inside the job, though, so a job waiting on a busy key still holds a worker slot. A burst on
// one key larger than the concurrency fills every slot with waiters, and other keys queue behind it
// until it drains. The key is per instance when the route declares no conversationId pointer, so
// routes should declare one, and the concurrency should exceed the largest expected per-key burst.
//
// Strict end-to-end order is NOT preserved across a BullMQ retry: a retried job re-enters lock.run()
// after its backoff and chains at the conversation's CURRENT tail, so it can overtake a
// same-conversation successor that dispatched
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
    @InjectQueue(QUEUE_NAMES.INGRESS)
    private readonly ingressQueue: Queue<IngressJobData>,
    @InjectRepository(IngressEvent, 'data')
    private readonly events: Repository<IngressEvent>,
  ) {
    super();
  }

  /**
   * BullModule closes the worker only in onApplicationShutdown, after every destroy hook, so it would
   * keep taking jobs while PluginLoaderService (a global module, destroyed last) disables the plugins:
   * each one would fail against a terminated sandbox, spending an attempt or landing in the DLQ.
   * Closing here, before the global modules, lets the jobs already running finish against live plugins
   * and leaves the rest in Redis for the next start. Running jobs that share an ordering key dispatch
   * one after another, so a full worker of them can outlast any wait; this one takes the whole cap.
   */
  async onModuleDestroy(): Promise<void> {
    await closeWorkerIfStarted(this, MAX_WORKER_CLOSE_WAIT_MS);
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

      if (isFinalAttempt) await this.deadLetterOrRequeue(job, job.attemptsMade + 1, errorMessage);

      // Re-throw to trigger BullMQ's exponential backoff / retry.
      throw err;
    }
    if (REQUEUED_JOB_ID.test(String(job.id))) await this.settleRequeued(d);
  }

  /**
   * A re-queued copy runs while the original job stays 'failed' under the original id. The reconciler
   * takes a live or completed copy for the job, but one it misses (pruned once completed) reads as
   * dead-lettered: for an event still 'pending' it writes a DLQ row and marks the event 'failed'.
   * Record the delivery on both so neither is left redrivable for an event the plugin already
   * received. Never rejects: the dispatch succeeded, and a retry would deliver it again.
   */
  private async settleRequeued(d: IngressJobData): Promise<void> {
    try {
      await this.events.update(
        { pluginId: d.pluginId, instanceId: d.instanceId, providerDeliveryId: d.deliveryId },
        { dispatchState: 'dispatched', payload: null },
      );
      await this.failures.update(
        {
          direction: 'inbound',
          pluginId: d.pluginId,
          instanceId: d.instanceId,
          deliveryId: d.deliveryId,
          redriven: false,
        },
        { redriven: true },
      );
    } catch (err) {
      this.logger.error(
        'Could not record a re-queued ingress delivery',
        err instanceof Error ? err.message : String(err),
        {
          pluginId: d.pluginId,
          instanceId: d.instanceId,
          deliveryId: d.deliveryId,
          action: 'ingress_requeue_settle_failed',
        },
      );
    }
  }

  /**
   * A job failed by stall exhaustion never enters process(): the worker fails it internally and only
   * emits 'failed'. The ingress_events row already retired its payload when the enqueue returned
   * 'queued', so without this the failed BullMQ job (pruned by removeOnFail) is the only copy and no
   * DLQ row exists to redrive. Any other failure was already recorded by process() on the final
   * attempt, so only the stall sentinel is handled here. `job` is undefined once removeOnFail pruned it.
   */
  @OnWorkerEvent('failed')
  async onWorkerFailed(job: Job<IngressJobData> | undefined, error: Error): Promise<void> {
    if (!job || error.message !== STALL_EXHAUSTION_MESSAGE) return;
    const d = job.data;
    this.logger.error('Ingress job failed after stalling beyond the recovery limit', error.message, {
      pluginId: d.pluginId,
      instanceId: d.instanceId,
      route: d.route,
      deliveryId: d.deliveryId,
      attemptsMade: job.attemptsMade,
      action: 'ingress_stall_exhausted',
    });
    // Never rejects: an event listener's rejection would surface as an unhandled rejection.
    await this.deadLetterOrRequeue(job, job.attemptsMade, error.message);
  }

  /**
   * Dead-letter a job that has spent its attempts. That row is the only durable copy left, so when the
   * data database refuses it too (an outage longer than the retry window fails dispatch and the write
   * alike), the delivery goes back on the queue, which still works, and runs again once the database
   * is back. A fresh job id, because the failed job keeps the original one until removeOnFail prunes it
   * and BullMQ would resolve an add under that id to the existing job. A copy that fails the same way
   * takes the other of the two copy ids, removing the failed copy before it that still holds it, so the
   * reconciler can find the live one by id. Never rejects.
   */
  private async deadLetterOrRequeue(job: Job<IngressJobData>, attempts: number, errorMessage: string): Promise<void> {
    const d = job.data;
    try {
      await this.deadLetter(d, attempts, errorMessage, REQUEUED_JOB_ID.test(String(job.id)));
    } catch (err) {
      const meta = { jobId: job.id, pluginId: d.pluginId, instanceId: d.instanceId, deliveryId: d.deliveryId };
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const [first, second] = requeuedJobIds(String(job.id).replace(REQUEUED_JOB_ID, ''));
        const jobId = String(job.id) === first ? second : first;
        await this.ingressQueue.remove(jobId);
        await this.ingressQueue.add(job.name, d, {
          jobId,
          attempts: job.opts.attempts,
          backoff: job.opts.backoff,
          delay: REQUEUE_DELAY_MS,
        });
        this.logger.error('Could not dead-letter a failed ingress job; re-queued it', reason, {
          ...meta,
          action: 'ingress_dlq_failed_requeued',
        });
      } catch (queueErr) {
        // Only the failed BullMQ job is left; the job id lets an operator retry it before it is pruned.
        this.logger.error('Could not dead-letter or re-queue a failed ingress job', reason, {
          ...meta,
          requeueError: queueErr instanceof Error ? queueErr.message : String(queueErr),
          action: 'ingress_dlq_failed',
        });
      }
    }
  }

  private async deadLetter(
    d: IngressJobData,
    attempts: number,
    errorMessage: string,
    requeued: boolean,
  ): Promise<void> {
    await this.hooks.execute(
      'ingress:error',
      { ...d, error: errorMessage },
      { sessionId: d.sessionId, source: 'IngressProcessor' },
    );
    // The reconciler writes this row itself when it finds the original job failed with none, so a
    // re-queued copy that fails again must not add a second redrivable one. Only a re-queued copy: a
    // redrive job can fail while the row it replays is still open, and that row is retired regardless.
    if (
      requeued &&
      (await this.failures.count({
        where: {
          direction: 'inbound',
          pluginId: d.pluginId,
          instanceId: d.instanceId,
          deliveryId: d.deliveryId,
          redriven: false,
        },
      })) > 0
    ) {
      return;
    }
    await this.failures.save({
      direction: 'inbound',
      pluginId: d.pluginId,
      instanceId: d.instanceId,
      sessionId: d.sessionId ?? null,
      deliveryId: d.deliveryId,
      attempts,
      lastError: errorMessage,
      // Persist the FULL ingress payload (route + headers/rawBody) so P1 redrive is
      // self-contained and never has to re-read ingress_events.
      payload: {
        route: d.route,
        method: d.method,
        providerConversationId: d.providerConversationId,
        ingress: d.payload,
      },
      redriven: false,
    });
  }
}
