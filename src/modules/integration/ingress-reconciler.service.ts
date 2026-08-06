import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEnqueueService, buildIngressDeadLetterRow } from './ingress-enqueue.service';
import { extractConversationId } from './ingress.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

export interface IngressReconcilerOptions {
  // Sweep cadence. 0 disables the reconciler. A blank or otherwise unparseable value falls back to
  // the default rather than disabling the sweep, so a mis-set variable can never silently turn it off.
  intervalMs: number;
  // A 'pending' row only becomes sweep-eligible once its last activity (creation or latest attempt)
  // is older than this — the live path gets the whole window to record its own outcome first.
  graceMs: number;
  batchSize: number;
  // Replay budget per event. Exhaustion marks the row 'failed' (terminal) and guarantees a DLQ row
  // exists, so recovery continues through RedriveService instead of an infinite replay loop.
  maxAttempts: number;
}

export function resolveIngressReconcilerOptions(env: NodeJS.ProcessEnv = process.env): IngressReconcilerOptions {
  const batch = Number(env.INGRESS_RECONCILE_BATCH_SIZE);
  const maxAttempts = Number(env.INGRESS_RECONCILE_MAX_ATTEMPTS);
  return {
    intervalMs: resolveNonNegativeIntEnv(env.INGRESS_RECONCILE_INTERVAL_MS, 60_000),
    graceMs: resolveNonNegativeIntEnv(env.INGRESS_RECONCILE_GRACE_MS, 60_000),
    batchSize: Number.isInteger(batch) && batch >= 1 ? batch : 50,
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : 5,
  };
}

export interface IngressReconcileStats {
  scanned: number;
  replayed: number;
  failed: number;
  skipped: number;
}

/**
 * Closes the last silent-loss window of the fast-ack ingress pipeline. persist-before-ack makes the
 * ingress_events row durable, but durability alone is not delivery: a crash between the persist and
 * the enqueue, or a fire-and-forget enqueue whose outcome never gets recorded, strands the row
 * 'pending' forever — a provider retry only hits the dedup oracle and 200s as 'duplicate'.
 *
 * The reconciler sweeps small batches of stale 'pending' rows and re-dispatches them through the
 * exact same IngressEnqueueService the live path uses (same deliveryId as BullMQ jobId, so a replay
 * is idempotent against a job that did get enqueued). Re-dispatch from the row is sound because a
 * 'pending' row IS the full verified request: payload carries headers/query/body/rawBody,
 * providerDeliveryId is the delivery id, and the manifest route re-derives the conversation lane.
 * (The payload is retired to NULL the moment an outcome is recorded — 'dispatched' rows and DLQ'd
 * 'failed' rows no longer need it — so only 'pending' rows, which always carry it, are replayable.)
 * 'failed'/'dispatched' rows are never re-queued: a terminal failure lives in the DLQ
 * (RedriveService), a dispatched event is the dispatch tier's concern.
 *
 * Mirrors IntegrationRetentionService's lifecycle: a raw unref'd setInterval started on module init
 * (first sweep after one interval, so plugin sandboxes have time to boot), cleared on destroy.
 */
@Injectable()
export class IngressReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('IngressReconcilerService');
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @InjectRepository(IngressEvent, 'data') private readonly events: Repository<IngressEvent>,
    @InjectRepository(IntegrationDeliveryFailure, 'data')
    private readonly failures: Repository<IntegrationDeliveryFailure>,
    private readonly ingressEnqueue: IngressEnqueueService,
    private readonly loader: PluginLoaderService,
    private readonly instances: PluginInstanceService,
  ) {}

  onModuleInit(): void {
    const opts = resolveIngressReconcilerOptions();
    if (opts.intervalMs <= 0) {
      this.logger.log('Ingress event reconciler disabled (INGRESS_RECONCILE_INTERVAL_MS <= 0)');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep(opts).catch(err =>
        this.logger.error('Ingress reconcile sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, opts.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One bounded pass over the stale 'pending' backlog. Overlap-guarded: a slow sweep (up to
   * batchSize sequential inline dispatch timeouts) never stacks a second pass on top of itself.
   */
  async sweep(opts: IngressReconcilerOptions, now: Date = new Date()): Promise<IngressReconcileStats> {
    const stats: IngressReconcileStats = { scanned: 0, replayed: 0, failed: 0, skipped: 0 };
    if (this.sweeping) return stats;
    this.sweeping = true;
    try {
      const cutoff = new Date(now.getTime() - opts.graceMs);
      const rows = await this.events.find({
        where: { dispatchState: 'pending', createdAt: LessThan(cutoff) },
        order: { createdAt: 'ASC' },
        take: opts.batchSize,
      });
      for (const row of rows) {
        // A row whose latest attempt is still inside the grace window cools down between replays;
        // it keeps its batch slot (bounded by maxAttempts, so the leak is capped) but is not hit again.
        if (row.lastDispatchAt && row.lastDispatchAt > cutoff) {
          stats.skipped++;
          continue;
        }
        // A 'pending' row without a payload cannot be replayed (payloads are retired only once an
        // outcome is recorded, so this means an imported/corrupt row). Skip it loudly rather than
        // dispatching an empty delivery or spinning the attempt budget on a row that can never fire.
        if (!hasPayload(row)) {
          this.logger.error('Ingress event is pending without a payload; cannot replay', undefined, {
            pluginId: row.pluginId,
            instanceId: row.instanceId,
            deliveryId: row.providerDeliveryId,
            action: 'ingress_reconcile_missing_payload',
          });
          stats.skipped++;
          continue;
        }
        try {
          // Re-apply the eligibility oracle the live path checks at the door (IngressService.handle
          // 404s an unknown/disabled instance): an instance disabled or deleted AFTER persist must
          // not receive the replay. The row stays 'pending' — a re-enabled instance is replayed by a
          // later sweep; a deleted one ages out via INGRESS_DEDUP_RETENTION_DAYS pruning.
          const instance = await this.instances.resolve(row.pluginId, row.instanceId);
          if (!instance || !instance.enabled) {
            this.logger.log('Skipping ingress event for a disabled or deleted instance', {
              pluginId: row.pluginId,
              instanceId: row.instanceId,
              deliveryId: row.providerDeliveryId,
              action: 'ingress_reconcile_instance_ineligible',
            });
            stats.skipped++;
            continue;
          }
          stats.scanned++;
          const outcome = await this.reconcileRow(row, opts.maxAttempts, now);
          if (outcome === 'replayed') stats.replayed++;
          else stats.failed++;
        } catch (err) {
          // A bookkeeping failure (repo update/DLQ write) must not abort the batch; the row stays
          // 'pending' and is retried next sweep.
          this.logger.error('Ingress reconcile row failed', err instanceof Error ? err.message : String(err), {
            pluginId: row.pluginId,
            instanceId: row.instanceId,
            deliveryId: row.providerDeliveryId,
            action: 'ingress_reconcile_row_failed',
          });
          stats.skipped++;
        }
      }
      return stats;
    } finally {
      this.sweeping = false;
    }
  }

  private async reconcileRow(
    row: IngressEvent & { payload: NonNullable<IngressEvent['payload']> },
    maxAttempts: number,
    now: Date,
  ): Promise<'replayed' | 'failed'> {
    const jobData = this.jobDataFor(row);
    // jobId = the ORIGINAL deliveryId: BullMQ dedups a replay against a job that did get enqueued
    // before the crash, so re-dispatch never double-delivers on the queue path.
    const { outcome, error } = await this.ingressEnqueue.enqueue(jobData, row.providerDeliveryId);
    if (outcome !== 'failed') {
      // Retire the payload with the outcome: the dispatch tier owns the delivery from here (the
      // BullMQ job data, or a DLQ row on an in-tier failure), so the dedup row slims to its marker.
      await this.events.update({ id: row.id }, { dispatchState: 'dispatched', lastDispatchAt: now, payload: null });
      // Retire any dead-letter row the live path already wrote for this delivery (the inline-failure
      // case) — the replay just delivered it, so a later manual redrive must not deliver it again.
      await this.failures.update(
        {
          direction: 'inbound',
          pluginId: row.pluginId,
          instanceId: row.instanceId,
          deliveryId: row.providerDeliveryId,
          redriven: false,
        },
        { redriven: true },
      );
      this.logger.log('Replayed stranded ingress event', {
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        outcome,
        action: 'ingress_event_replayed',
      });
      return 'replayed';
    }

    const attempts = (row.dispatchAttempts ?? 0) + 1;
    const terminal = attempts >= maxAttempts;
    if (terminal) {
      // DLQ BEFORE the terminal mark + payload retirement: the dead-letter row is the payload's new
      // home, so it must exist first. ensureDeadLetterRow is idempotent (count-guarded), so a crash
      // between the two writes just makes the next sweep re-take this path and finish the mark.
      await this.ensureDeadLetterRow(jobData, attempts, error);
      await this.events.update(
        { id: row.id },
        { dispatchAttempts: attempts, lastDispatchAt: now, dispatchState: 'failed', payload: null },
      );
      this.logger.warn('Ingress event replay budget exhausted; event is dead-lettered', {
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        attempts,
        action: 'ingress_event_reconcile_exhausted',
      });
      return 'failed';
    }
    // Non-terminal: keep the payload — the next sweep replays from it.
    await this.events.update({ id: row.id }, { dispatchAttempts: attempts, lastDispatchAt: now });
    return 'failed';
  }

  /**
   * Rebuild the dispatch job from the persisted row. `method` is the one request field the row does
   * not persist — dispatchWebhookForInstance defaults it to 'POST' (the same tolerance RedriveService
   * applies to legacy DLQ rows). providerConversationId is re-derived from the CURRENT manifest route
   * so the replay joins the same per-conversation ordering lane as live deliveries instead of
   * degrading to the per-instance lane; a hot-swapped/missing route just yields no key.
   */
  private jobDataFor(row: IngressEvent & { payload: NonNullable<IngressEvent['payload']> }): IngressJobData {
    const route = this.loader
      .getPlugin(row.pluginId)
      ?.manifest.ingress?.find(candidate => candidate.route === row.route);
    return {
      pluginId: row.pluginId,
      instanceId: row.instanceId,
      route: row.route,
      deliveryId: row.providerDeliveryId,
      sessionId: row.sessionId ?? undefined,
      providerConversationId: extractConversationId(route?.conversationId, row.payload.headers, row.payload.rawBody),
      payload: row.payload,
    };
  }

  // The live path dead-letters an inline-dispatch failure at request time, so a terminal row may
  // already have its DLQ entry — write one only if missing, and never a second copy.
  private async ensureDeadLetterRow(data: IngressJobData, attempts: number, error?: string): Promise<void> {
    const existing = await this.failures.count({
      where: {
        direction: 'inbound',
        pluginId: data.pluginId,
        instanceId: data.instanceId,
        deliveryId: data.deliveryId,
      },
    });
    if (existing > 0) return;
    await this.failures.save({ ...buildIngressDeadLetterRow(data, error), attempts });
  }
}

// Narrows a swept row to one that still carries its payload (every replayable 'pending' row does —
// the payload is retired only when an outcome is recorded). Lets the sweep skip a payload-less row
// loudly instead of dispatching an empty delivery.
function hasPayload(row: IngressEvent): row is IngressEvent & { payload: NonNullable<IngressEvent['payload']> } {
  return row.payload !== null;
}
