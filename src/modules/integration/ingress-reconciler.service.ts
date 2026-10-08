import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstance } from './entities/plugin-instance.entity';
import { Session } from '../session/entities/session.entity';
import {
  EnqueueOutcome,
  IngressEnqueueService,
  buildIngressDeadLetterRow,
  resolveIngressJobOptions,
} from './ingress-enqueue.service';
import { extractConversationId } from './ingress.service';
import { INGRESS_DISPATCH_TIMEOUT_MS } from './integration.constants';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

export interface IngressReconcilerOptions {
  // Sweep cadence. 0 disables the reconciler. A blank value falls back to the default; boot validation
  // refuses a negative or unparseable one, so a mis-set variable can never silently turn it off.
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
 * 'pending' forever: a provider retry only hits the dedup oracle and is answered with the route's ack.
 *
 * The reconciler sweeps small batches of stale 'pending' rows and re-dispatches them through the
 * exact same IngressEnqueueService the live path uses (same deliveryId as BullMQ jobId, so a replay
 * is idempotent against a job that did get enqueued; one that already failed is left to the DLQ,
 * never counted as delivered, unless a copy IngressProcessor re-queued under a fresh id still owns
 * the delivery, which then counts as that job). Re-dispatch from the row is sound because a 'pending'
 * row IS the full verified request: payload carries headers/query/body/rawBody,
 * providerDeliveryId is the delivery id, and the manifest route re-derives the conversation lane.
 * (The payload is retired to NULL the moment an outcome is recorded — 'dispatched' rows and DLQ'd
 * 'failed' rows no longer need it — so only 'pending' rows, which always carry it, are replayable.)
 * 'failed'/'dispatched' rows are never re-queued: a terminal failure lives in the DLQ
 * (RedriveService), a dispatched event is the dispatch tier's concern.
 *
 * Same timer lifecycle as IntegrationRetentionService: a raw unref'd setInterval started on module
 * init (first sweep after one interval, so plugin sandboxes have time to boot) and cleared on destroy.
 * Unlike it, destroy also stops a pass in flight and waits a bounded time for it.
 */
@Injectable()
export class IngressReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('IngressReconcilerService');
  private timer?: ReturnType<typeof setInterval>;
  // The pass in flight, settled when it ends; doubles as the overlap guard.
  private inFlight?: Promise<void>;
  private readonly stop = new AbortController();

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
      this.logger.log('Ingress event reconciler disabled (INGRESS_RECONCILE_INTERVAL_MS=0)');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep(opts).catch(err =>
        this.logger.error('Ingress reconcile sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, opts.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Clearing the interval only stops the NEXT pass. A pass already running would go on replaying
   * rows after PluginLoaderService has stopped the plugin sandboxes, so each remaining row fails,
   * spends an attempt and, at its last one, is dead-lettered. Stop it at the next row and wait for
   * the row in hand, while its plugin is still running. The wait is bounded by the inline dispatch
   * timeout: before Redis has ever connected, the row's queue lookup can wait up to
   * REDIS_CONNECT_TIMEOUT_MS ahead of that dispatch, and a stalled Redis holds a lookup or add longer
   * still; waiting it out would delay every later destroy hook (engines, session leases, plugins).
   * A row given up on is never dispatched inline after the stop: it stays 'pending', unless its queue
   * add still succeeds and the queued job takes the delivery.
   */
  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    if (this.timer) clearInterval(this.timer);
    if (!this.inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      this.inFlight.then(() => true),
      new Promise<false>(resolve => (timer = setTimeout(resolve, INGRESS_DISPATCH_TIMEOUT_MS, false))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.logger.warn('Ingress reconcile pass still running at shutdown; continuing without it', {
        waitMs: INGRESS_DISPATCH_TIMEOUT_MS,
        action: 'ingress_reconcile_shutdown_timeout',
      });
    }
  }

  /**
   * One bounded pass over the stale 'pending' backlog. Overlap-guarded: a slow sweep (up to
   * batchSize sequential inline dispatch timeouts) never stacks a second pass on top of itself.
   */
  async sweep(opts: IngressReconcilerOptions, now: Date = new Date()): Promise<IngressReconcileStats> {
    const stats: IngressReconcileStats = { scanned: 0, replayed: 0, failed: 0, skipped: 0 };
    if (this.inFlight || this.stop.signal.aborted) return stats;
    let settle!: () => void;
    this.inFlight = new Promise(resolve => (settle = resolve));
    try {
      const cutoff = new Date(now.getTime() - opts.graceMs);
      // Only rows the sweep can act on may take a batch slot: a row of a disabled or deleted instance,
      // or one without a payload, is skipped without being written, so selecting it would hand the same
      // oldest rows back every sweep and starve every other instance's stranded deliveries. The join is
      // 1:1 (plugin_instances is unique on pluginId+instanceId), so limit() bounds rows, not join fan-out.
      const rows = await this.events
        .createQueryBuilder('e')
        .innerJoin(
          PluginInstance,
          'pi',
          'pi.pluginId = e.pluginId AND pi.instanceId = e.instanceId AND pi.enabled = :enabled',
          { enabled: true },
        )
        .where('e.dispatchState = :state', { state: 'pending' })
        .andWhere('e.createdAt < :cutoff', { cutoff })
        .andWhere('e.payload IS NOT NULL')
        .orderBy('e.createdAt', 'ASC')
        .limit(opts.batchSize)
        .getMany();
      for (const row of rows) {
        if (this.stop.signal.aborted) break;
        // A row whose latest attempt is still inside the grace window cools down between replays;
        // it keeps its batch slot (bounded by maxAttempts, so the leak is capped) but is not hit again.
        if (row.lastDispatchAt && row.lastDispatchAt > cutoff) {
          stats.skipped++;
          continue;
        }
        // A 'pending' row without a payload cannot be replayed (payloads are retired only once an
        // outcome is recorded, so this means an imported/corrupt row). The query already excludes it;
        // this narrows the type and still refuses to dispatch an empty delivery.
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
          // not receive the replay. The row stays 'pending' and a re-enabled instance is replayed by a
          // later sweep; past INGRESS_DEDUP_RETENTION_DAYS the retention prune dead-letters it instead
          // (deadLetterAgedPending), while a deleted one ages out without a dead letter.
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
          else if (outcome === 'failed') stats.failed++;
          else stats.skipped++;
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
      this.inFlight = undefined;
      settle();
    }
  }

  /**
   * Hand every 'pending' row created before `cutoff` that still carries its payload to the DLQ, then
   * retire the payload with a 'failed' mark, so the dedup-window prune never deletes an acknowledged
   * delivery that was never dispatched: one stranded across downtime longer than the window, one of an
   * instance disabled for that long, or any stranded row while the sweep is disabled. Same
   * DLQ-before-retire order as the replay budget path. A row whose writes fail stays 'pending' with its
   * payload, which the prune keeps, and is retried on the next run. Skipped while a sweep is running,
   * and stopped at the next row once shutdown begins, like a sweep.
   * A row whose instance or session was deleted, or whose queue job still owns the delivery, gets no
   * dead letter. Returns the number of rows dead-lettered.
   */
  async deadLetterAgedPending(cutoff: Date, batchSize = 100): Promise<number> {
    if (this.inFlight || this.stop.signal.aborted) return 0;
    let settle!: () => void;
    this.inFlight = new Promise(resolve => (settle = resolve));
    let retired = 0;
    try {
      for (;;) {
        const rows = await this.events.find({
          where: { dispatchState: 'pending', createdAt: LessThan(cutoff), payload: Not(IsNull()) },
          order: { createdAt: 'ASC' },
          take: batchSize,
        });
        let progressed = 0;
        for (const row of rows) {
          if (this.stop.signal.aborted) return retired;
          if (!hasPayload(row)) continue;
          const meta = { pluginId: row.pluginId, instanceId: row.instanceId, deliveryId: row.providerDeliveryId };
          try {
            if (await this.ownerDeleted(row)) {
              // The redrive endpoint refuses a deleted instance, and a session delete purges its dead
              // letters on purpose: retire the payload without writing one back, so the prune drops it.
              await this.events.update(
                { id: row.id, dispatchState: 'pending' },
                { dispatchState: 'failed', payload: null },
              );
              progressed++;
              this.logger.warn('Undispatched ingress event of a deleted instance or session dropped', {
                ...meta,
                action: 'ingress_event_retention_dropped',
              });
              continue;
            }
            const jobData = this.jobDataFor(row);
            // A job still in the queue (or completed) owns the delivery, as in reconcileRow: no dead
            // letter while a copy can still deliver. A failed one falls through to its existing DLQ row.
            const existing = await this.ingressEnqueue.existingJobState(jobData, row.providerDeliveryId);
            // Shutdown began while the lookup was out (destroy may have stopped waiting for it).
            if (this.stop.signal.aborted) return retired;
            if (existing && existing !== 'failed') {
              const settled = await this.events.update(
                { id: row.id, dispatchState: 'pending' },
                { dispatchState: 'dispatched', payload: null },
              );
              // As in reconcileRow: the job delivers it, so an inline-failure dead letter must close.
              if (settled.affected) await this.retireOpenDeadLetters(row);
              progressed++;
              continue;
            }
            const written = await this.ensureDeadLetterRow(
              jobData,
              row.dispatchAttempts,
              'not dispatched within the ingress dedup retention window',
            );
            const marked = await this.events.update(
              { id: row.id, dispatchState: 'pending' },
              { dispatchState: 'failed', payload: null },
            );
            progressed++;
            if (written) {
              // A delivery the dispatch tier made concurrently must not stay redrivable. For a failed
              // event, another node's hand-off may have written a dead letter too, or skipped its own
              // because of this one, so a writer retires its row only when an open one with a lower id
              // exists: the lowest-id open row is never retired, and normally it is the only one left.
              // Ids are random UUIDs, so a writer whose check runs before a lower-id row is visible
              // keeps its own as well, and two open rows can remain.
              const state = marked.affected
                ? 'failed'
                : (await this.events.findOne({ where: { id: row.id }, select: { dispatchState: true } }))
                    ?.dispatchState;
              if (state === 'dispatched' || (state === 'failed' && (await this.hasLowerOpenDeadLetter(row, written)))) {
                await this.failures.update({ id: written, redriven: false }, { redriven: true });
              }
            }
            if (!marked.affected) continue;
            retired++;
            this.logger.warn('Ingress event was never dispatched within the dedup retention window; dead-lettered', {
              ...meta,
              action: 'ingress_event_retention_dead_lettered',
            });
          } catch (err) {
            this.logger.error(
              'Failed to dead-letter an undispatched ingress event; kept for the next run',
              err instanceof Error ? err.message : String(err),
              { ...meta, action: 'ingress_event_retention_dead_letter_failed' },
            );
          }
        }
        if (rows.length < batchSize || progressed === 0) return retired;
      }
    } finally {
      this.inFlight = undefined;
      settle();
    }
  }

  // The row's instance is gone, or it was bound to a session that is gone. A wildcard or non-id scope
  // never names a sessions row, so it is never treated as deleted.
  private async ownerDeleted(row: IngressEvent): Promise<boolean> {
    if (!(await this.instances.resolve(row.pluginId, row.instanceId))) return true;
    const sessionId = row.sessionId;
    return !!sessionId && isUUID(sessionId) && !(await this.events.manager.existsBy(Session, { id: sessionId }));
  }

  private async hasLowerOpenDeadLetter(row: IngressEvent, written: string): Promise<boolean> {
    const lower = await this.failures.count({
      where: {
        direction: 'inbound',
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        redriven: false,
        id: LessThan(written),
      },
    });
    return lower > 0;
  }

  private async retireOpenDeadLetters(row: IngressEvent): Promise<void> {
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
  }

  private async reconcileRow(
    row: IngressEvent & { payload: NonNullable<IngressEvent['payload']> },
    maxAttempts: number,
    now: Date,
  ): Promise<'replayed' | 'failed' | 'interrupted'> {
    const jobData = this.jobDataFor(row);
    // jobId = the ORIGINAL deliveryId, so the replay lands on any job the live path did enqueue before
    // its outcome mark was lost. BullMQ resolves a duplicate add() whatever that job's state, so look
    // first: a live job already owns the delivery, and a failed one would swallow the replay.
    const existing = await this.ingressEnqueue.existingJobState(jobData, row.providerDeliveryId);
    // Shutdown began while the lookup was out, and destroy may have stopped waiting for it: a dispatch
    // now could land after plugin teardown and spend an attempt. Leave the row for the next start.
    if (this.stop.signal.aborted) return 'interrupted';
    if (existing === 'failed') {
      // Every queue attempt already ran and IngressProcessor dead-lettered the delivery, or re-queued it
      // and every copy failed too: a live or completed copy answers for the job (see existingJobState).
      // Nothing is dispatched: the DLQ row stays redrivable (written here if the processor's write was
      // lost, and before the payload is retired, since it becomes the payload's only home). A copy the
      // lookup missed (one pruned once completed) has already marked the event 'dispatched', so the mark
      // only lands on a still-'pending' event, and the row this sweep wrote for an event a copy already
      // dispatched is retired again. Only that row: 'dispatched' is also the mark for a job that was
      // still live, and a row written before this sweep can be the dead letter of a delivery that never
      // arrived.
      const written = await this.ensureDeadLetterRow(
        jobData,
        resolveIngressJobOptions().attempts,
        'ingress queue job failed',
      );
      const marked = await this.events.update(
        { id: row.id, dispatchState: 'pending' },
        { lastDispatchAt: now, dispatchState: 'failed', payload: null },
      );
      if (!marked.affected && written) {
        const current = await this.events.findOne({ where: { id: row.id }, select: { dispatchState: true } });
        if (current?.dispatchState === 'dispatched') {
          await this.failures.update({ id: written, redriven: false }, { redriven: true });
          return 'replayed';
        }
      }
      this.logger.warn('Stranded ingress event already failed in the queue; left for redrive', {
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        action: 'ingress_event_reconcile_job_failed',
      });
      return 'failed';
    }
    // The add can also outlast destroy's wait (see onModuleDestroy). Given the stop signal, enqueue()
    // throws instead of dispatching inline once it has aborted, and the row is left as above.
    const result: EnqueueOutcome | undefined = existing
      ? { outcome: 'queued' }
      : await this.ingressEnqueue.enqueue(jobData, row.providerDeliveryId, this.stop.signal).catch(err => {
          if (this.stop.signal.aborted) return undefined;
          throw err;
        });
    if (!result) return 'interrupted';
    const { outcome, error } = result;
    if (outcome !== 'failed') {
      // Retire the payload with the outcome: the dispatch tier owns the delivery from here (the
      // BullMQ job data, or a DLQ row on an in-tier failure), so the dedup row slims to its marker.
      await this.events.update({ id: row.id }, { dispatchState: 'dispatched', lastDispatchAt: now, payload: null });
      // Retire any dead-letter row the live path already wrote for this delivery (the inline-failure
      // case): the replay, or the job or re-queued copy still live in the queue, delivers it, so a later
      // manual redrive must not deliver it again.
      await this.retireOpenDeadLetters(row);
      this.logger.log('Replayed stranded ingress event', {
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        outcome,
        action: 'ingress_event_replayed',
      });
      return 'replayed';
    }
    // A failure once shutdown began says nothing about the event: the add may have been refused by a
    // queue connection closing under it, or the inline fallback met a plugin being torn down. Spend no
    // attempt and leave the row for the next start.
    if (this.stop.signal.aborted) return 'interrupted';

    const attempts = (row.dispatchAttempts ?? 0) + 1;
    const terminal = attempts >= maxAttempts;
    if (terminal) {
      // DLQ BEFORE the terminal mark + payload retirement: the dead-letter row is the payload's new
      // home, so it must exist first. ensureDeadLetterRow is idempotent (count-guarded), so a crash
      // between the two writes just makes the next sweep re-take this path and finish the mark. A
      // redrive of the live-path row during this replay closes the event and that row, so, as in the
      // failed-job branch, the mark only lands on a still-'pending' event and the row written for an
      // event the redrive already dispatched is retired.
      const written = await this.ensureDeadLetterRow(jobData, attempts, error);
      const marked = await this.events.update(
        { id: row.id, dispatchState: 'pending' },
        { dispatchAttempts: attempts, lastDispatchAt: now, dispatchState: 'failed', payload: null },
      );
      if (!marked.affected && written) {
        const current = await this.events.findOne({ where: { id: row.id }, select: { dispatchState: true } });
        if (current?.dispatchState === 'dispatched') {
          await this.failures.update({ id: written, redriven: false }, { redriven: true });
          return 'replayed';
        }
      }
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
   * Rebuild the dispatch job from the persisted row. A row written before the method was persisted
   * has none, and dispatchWebhookForInstance defaults it to 'POST' (the same tolerance RedriveService
   * applies to legacy DLQ rows). providerConversationId is re-derived from the CURRENT manifest route
   * so the replay joins the same per-conversation ordering lane as live deliveries instead of
   * degrading to the per-instance lane; a hot-swapped/missing route just yields no key.
   */
  private jobDataFor(row: IngressEvent & { payload: NonNullable<IngressEvent['payload']> }): IngressJobData {
    const route = this.loader
      .getPlugin(row.pluginId)
      ?.manifest.ingress?.find(candidate => candidate.route === row.route);
    const { method, ...payload } = row.payload;
    return {
      pluginId: row.pluginId,
      instanceId: row.instanceId,
      route: row.route,
      method,
      deliveryId: row.providerDeliveryId,
      sessionId: row.sessionId ?? undefined,
      providerConversationId: extractConversationId(route?.conversationId, payload.headers, payload.rawBody),
      payload,
    };
  }

  // The live path dead-letters an inline-dispatch failure at request time, so a terminal row may
  // already have its DLQ entry — write one only if missing, and never a second copy. Returns the id of
  // the row it wrote, or undefined when an open one already existed. Only an open row counts: a
  // redriven one is closed for good, so an event re-sent under the same id after the dedup window
  // still needs its own redrivable row.
  private async ensureDeadLetterRow(
    data: IngressJobData,
    attempts: number,
    error?: string,
  ): Promise<string | undefined> {
    const existing = await this.failures.count({
      where: {
        direction: 'inbound',
        pluginId: data.pluginId,
        instanceId: data.instanceId,
        deliveryId: data.deliveryId,
        redriven: false,
      },
    });
    if (existing > 0) return undefined;
    return (await this.failures.save({ ...buildIngressDeadLetterRow(data, error), attempts })).id;
  }
}

// Narrows a swept row to one that still carries its payload (every replayable 'pending' row does —
// the payload is retired only when an outcome is recorded). Lets the sweep skip a payload-less row
// loudly instead of dispatching an empty delivery.
function hasPayload(row: IngressEvent): row is IngressEvent & { payload: NonNullable<IngressEvent['payload']> } {
  return row.payload !== null;
}
