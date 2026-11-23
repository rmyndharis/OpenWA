import { Optional } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, Queue, RATE_LIMIT_ERROR } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, ingressWorkerConcurrency, producerReady } from '../redis-connection';
import { closeWorkerIfStarted, MAX_WORKER_CLOSE_WAIT_MS, startedWorker } from './close-worker';
import { IntegrationDeliveryFailure } from '../../integration/entities/integration-delivery-failure.entity';
import { IngressEvent } from '../../integration/entities/ingress-event.entity';
import { PluginLoaderService } from '../../../core/plugins/plugin-loader.service';
import { HookManager } from '../../../core/hooks';
import { createLogger } from '../../../common/services/logger.service';
import { ShutdownService } from '../../../common/services/shutdown.service';
import { KeyedAsyncLock, orderingKeyFor } from '../../integration/ordering-lock';
import { requeuedJobIds, resolveIngressJobOptions } from '../../integration/ingress-enqueue.service';

// BullMQ's failedReason for a job that stalled more than maxStalledCount (see WebhookProcessor).
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';

// How long a delivery whose dead-letter row could not be written waits before it runs again.
const REQUEUE_DELAY_MS = 60_000;

// How long a job deferred because another delivery for the same ordering key is active waits before retrying.
export const BUSY_KEY_REQUEUE_DELAY_MS = 250;

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
  payload: {
    headers: Record<string, string>;
    query: Record<string, string>;
    body: string;
    rawBody: string;
    // Original provider id when deliveryId is a body-specific storage key.
    providerDeliveryId?: string;
    // The host's verdict when it accepted the request; see IngressEvent.payload.
    admission?: { verified: boolean };
  };
}

// Active ordering keys guarantee no two dispatches for the SAME conversation run concurrently, so
// the worker can run with concurrency > 1 to parallelize unrelated conversations. When a BullMQ job
// arrives for a key that already has an active dispatch, process() moves it back to the delayed set
// (via moveToDelayed + DelayedError) instead of waiting inside a worker slot: this releases the
// concurrency slot immediately so a burst on one busy key cannot head-of-line-block unrelated keys,
// and does not consume attemptsMade or trigger dead-lettering. Synthetic callers without a BullMQ
// lock token (or moveToDelayed) still serialize in-process through KeyedAsyncLock.
//
// Strict end-to-end order is NOT preserved across a busy-key deferral or BullMQ retry: a deferred
// or retried job wakes after its delay and may run after another job for the same key that arrived
// in between. This tradeoff frees worker slots under bursty or failing keys and is acceptable
// because ingress ordering is best-effort regardless (providers deliver over unordered HTTP).
// Order-strict plugins must not assume retry- or burst-deferred events arrive in strict sequence.
@Processor(QUEUE_NAMES.INGRESS, { connection: workerConnectionOptions(), concurrency: ingressWorkerConcurrency() })
export class IngressProcessor extends WorkerHost {
  private readonly logger = createLogger('IngressProcessor');
  private readonly lock = new KeyedAsyncLock();
  private readonly activeKeys = new Set<string>();
  private readonly activeKeyCounts = new Map<string, number>();

  constructor(
    private readonly loader: PluginLoaderService,
    @InjectRepository(IntegrationDeliveryFailure, 'data')
    private readonly failures: Repository<IntegrationDeliveryFailure>,
    private readonly hooks: HookManager,
    @InjectQueue(QUEUE_NAMES.INGRESS)
    private readonly ingressQueue: Queue<IngressJobData>,
    @InjectRepository(IngressEvent, 'data')
    private readonly events: Repository<IngressEvent>,
    @Optional() shutdown?: ShutdownService,
  ) {
    super();
    // A plugin's ingress handler sends through the session engines, and SessionModule tears them down
    // before QueueModule is destroyed, so a job taken in between fails and spends an attempt. Stop taking
    // jobs once shutdown begins: the jobs already running keep the drain window to finish while the
    // engines are up, onModuleDestroy below waits for them, and the rest stay in Redis for another node
    // or the next start. A close that skips ShutdownService (the teardown after a failed boot) closes there only.
    shutdown?.onShutdown(() => {
      const worker = startedWorker(this);
      void worker?.close().catch(() => undefined);
    });
  }

  /**
   * BullModule closes the worker only in onApplicationShutdown, after every destroy hook, so it would
   * keep taking jobs while PluginLoaderService (a global module, destroyed last) disables the plugins:
   * each one would fail against a terminated sandbox, spending an attempt or landing in the DLQ.
   * Closing here, before the global modules, lets the jobs already running finish against live plugins
   * and leaves the rest in Redis for the next start. Running jobs that share an ordering key dispatch
   * one after another, so a full worker of them can outlast any wait; this one takes the whole cap.
   * A job still running at the cap is cut mid-dispatch and re-run after the next start; BullMQ allows one
   * stall per job, so a second one fails it.
   */
  async onModuleDestroy(): Promise<void> {
    await closeWorkerIfStarted(this, MAX_WORKER_CLOSE_WAIT_MS);
  }

  async process(job: Job<IngressJobData>, token?: string): Promise<void> {
    const d = job.data;
    if (this.loader.isRestorePending(d.pluginId)) {
      // The plugin's worker does not exist until the boot restore reaches it, and a restore can outlast the
      // whole retry budget. Before the try below on purpose: this is not an attempt, so it must never be
      // logged as a failure or file a dead-letter row. moveToDelayed does not spend one of the job's attempts.
      // Every held job is delayed to the next multiple of the retry delay (at least a second: a job delayed to
      // "now" is promoted straight back and would spin), so they all wake together and BullMQ promotes them in the
      // order they were delayed. A fixed delay from "now" would give two deliveries of one conversation, a fraction of
      // a period apart, polls a fraction of a period apart, and a restore ending between them lets the later through
      // first. The delay carries no jitter for the same reason. Jobs of one wake that the worker reaches after
      // the restore ends still pass those it held again before, and BullMQ's delayed score has 4096 insertion
      // ranks per millisecond: past them the jobs of one wake come back ordered by id.
      const delay = Math.max(1000, resolveIngressJobOptions().backoff.delay);
      await job.moveToDelayed((Math.floor(Date.now() / delay) + 1) * delay, token);
      throw new DelayedError();
    }
    const key = orderingKeyFor(d);
    if (this.activeKeys.has(key) && token !== undefined && typeof job.moveToDelayed === 'function') {
      // Another delivery for this ordering key is currently executing: release this worker slot
      // immediately back to BullMQ's delayed set without spending an attempt or triggering DLQ.
      await job.moveToDelayed(Date.now() + BUSY_KEY_REQUEUE_DELAY_MS, token);
      throw new DelayedError();
    }

    const activeCount = (this.activeKeyCounts.get(key) ?? 0) + 1;
    this.activeKeyCounts.set(key, activeCount);
    this.activeKeys.add(key);
    try {
      try {
        await this.lock.run(key, () => this.loader.dispatchWebhookForInstance(d, { queued: true }));
      } finally {
        const remaining = (this.activeKeyCounts.get(key) ?? 1) - 1;
        if (remaining > 0) {
          this.activeKeyCounts.set(key, remaining);
        } else {
          this.activeKeyCounts.delete(key);
          this.activeKeys.delete(key);
        }
      }
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

      // BullMQ reads an error with exactly this text as a rate limit, moves the job back to wait without
      // counting the attempt and runs it again: here a hot loop that never reaches the final attempt, or on
      // it writes a dead letter on every run. A handler may relay such text from elsewhere.
      if (errorMessage === RATE_LIMIT_ERROR) {
        throw new Error(`Ingress dispatch failed: ${errorMessage}`, { cause: err });
      }
      // Re-throw to trigger BullMQ's exponential backoff / retry.
      throw err;
    }
    if (REQUEUED_JOB_ID.test(String(job.id))) await this.settleRequeued(d);
    else await this.retireSettled(d);
  }

  /**
   * The delivery reached the plugin, or its dead letter is written: the event row, which kept its payload so a job
   * that Redis loses could be replayed from it, no longer needs it. Only while the row is 'pending', so one that a
   * recovery pass already failed or settled is not touched. Never rejects: the dispatch succeeded and a retry would
   * deliver it again, and a row left 'pending' is settled by the reconciler once it finds the job completed.
   */
  private async retireSettled(d: IngressJobData): Promise<void> {
    try {
      await this.events.update(
        { pluginId: d.pluginId, instanceId: d.instanceId, providerDeliveryId: d.deliveryId, dispatchState: 'pending' },
        { dispatchState: 'dispatched', payload: null },
      );
    } catch (err) {
      this.logger.error(
        'Could not record a settled ingress delivery',
        err instanceof Error ? err.message : String(err),
        {
          pluginId: d.pluginId,
          instanceId: d.instanceId,
          deliveryId: d.deliveryId,
          action: 'ingress_settle_failed',
        },
      );
    }
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
   * emits 'failed'. Without this no DLQ row exists to redrive until the reconciler finds the failed job
   * and writes one from the event row. Any other failure was already recorded by process() on the final
   * attempt, so only the stall sentinel is handled here. `job` is undefined once removeOnFail pruned it.
   */
  @OnWorkerEvent('failed')
  async onWorkerFailed(job: Job<IngressJobData> | undefined, error: Error): Promise<void> {
    // The sentinel text alone is not proof: a failed attempt whose error reads the same is retried and is not
    // this. BullMQ marks a job it fails for stalling by storing the reason as its deferred failure.
    if (!job || job.deferredFailure !== STALL_EXHAUSTION_MESSAGE || error.message !== STALL_EXHAUSTION_MESSAGE) return;
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
      // The dead letter is the payload's home now, so the event row lets go of it. Not when the write failed: the
      // delivery then goes back on the queue and the row keeps its payload.
      await this.retireSettled(d);
    } catch (err) {
      const meta = { jobId: job.id, pluginId: d.pluginId, instanceId: d.instanceId, deliveryId: d.deliveryId };
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const [first, second] = requeuedJobIds(String(job.id).replace(REQUEUED_JOB_ID, ''));
        const jobId = String(job.id) === first ? second : first;
        // The producer queue holds its calls until its first connect, which the worker's own connection does not
        // wait for; bounded, so the recovery gives up instead of waiting on a Redis that never answered it.
        await producerReady(this.ingressQueue);
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
