import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository, UpdateResult } from 'typeorm';
import { IngressDispatchState, IngressEvent } from './entities/ingress-event.entity';
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
import { INGRESS_SHUTDOWN_WAIT_MS } from './integration.constants';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { createLogger } from '../../common/services/logger.service';
import { isTransientDbError } from '../../common/utils/db-errors';
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

/**
 * How long a row stays out of the sweep's batch, and how many such rows are remembered, after the sweep found no
 * use in reading it again soon. Two reasons: its stored payload could not be read, which is looked at again after
 * an hour; and its queue job is still live (waiting behind a backlog, running, delayed), which the worker settles on
 * its own and which only needs another look after a quarter of an hour at the earliest. A completed job is kept for
 * an hour or until 1000 newer ones have completed (removeOnComplete age and count), whichever comes first, so a look
 * that comes later than that finds no job and the row is replayed. Held in memory, not in the attempt budget: the
 * row is not touched, so nothing of its budget is spent, and it is looked at again after the wait or a restart. The
 * list only spares the reads: it holds at most (wait / sweep interval) * batch size rows back, so what keeps such
 * rows from starving the ones behind them is the walk below.
 */
const UNREADABLE_RETRY_MS = 60 * 60 * 1000;
const LIVE_JOB_RETRY_MS = 15 * 60 * 1000;
const SET_ASIDE_MAX = 1000;

/**
 * Where the sweep's walk through the stale rows stands: `after` is the last row a pass finished with, `before` the
 * creation time the walk began with, `restoring` the plugins it left out because the boot restore had not reached them.
 */
interface IngressWalk {
  after: string;
  before: Date;
  restoring: string[];
}

// A row that became old enough after the walk began belongs to the next walk, and the clock never widens the grace.
const walkBound = (walk: IngressWalk | undefined, cutoff: Date): Date =>
  walk && walk.before < cutoff ? walk.before : cutoff;

export interface IngressReconcileStats {
  scanned: number;
  replayed: number;
  failed: number;
  skipped: number;
}

/**
 * Closes the last silent-loss window of the fast-ack ingress pipeline. persist-before-ack makes the
 * ingress_events row durable, but durability alone is not delivery: a crash between the persist and
 * the enqueue, a fire-and-forget enqueue whose outcome never gets recorded, or a queued job that Redis loses
 * strands the row 'pending' forever: a provider retry only hits the dedup oracle and is answered with the
 * route's ack.
 *
 * The reconciler sweeps small batches of stale 'pending' rows and re-dispatches them through the
 * exact same IngressEnqueueService the live path uses (same deliveryId as BullMQ jobId, so a replay
 * is idempotent against a job that did get enqueued; one that already failed is left to the DLQ,
 * never counted as delivered, unless a copy IngressProcessor re-queued under a fresh id still owns
 * the delivery, which then counts as that job). Re-dispatch from the row is sound because a 'pending'
 * row IS the full verified request: payload carries headers/query/body/rawBody,
 * providerDeliveryId is the delivery id, and the manifest route re-derives the conversation lane.
 * The row keeps its payload until the delivery has settled: the inline dispatch succeeded, the worker finished
 * the queue job, or the dead letter is written. So a 'pending' row always carries it, and a job that Redis loses
 * (a restart without its data, a failover to a replica that was behind, an eviction, a job removed in the queue
 * dashboard) is found by the sweep and replayed from the row, counted against the replay budget. A job that
 * is still live (waiting behind a backlog, running, delayed) is left alone, and one that already completed
 * settles the row without a second delivery. The sweep never replays inline while the queue cannot be asked,
 * since the job may be alive.
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
  // Row id to the time it may be looked at again, for rows the sweep set aside (see above).
  private readonly setAsideUntil = new Map<string, number>();
  // The walk through the stale rows, oldest first, or none when the next pass starts at the oldest. A pass that fills
  // its batch is followed by one that goes on after its last row, so rows that are only looked at and left alone (a
  // live job, a payload that cannot be read) cannot keep the rows behind them from being reached: a stranded row
  // behind N others is looked at within ceil((N + 1) / batchSize) passes, however many of them hold a live job. A pass
  // that does not fill its batch has reached the end, and the next one starts over. The creation time bound is kept
  // from the start of the walk so that rows arriving while it runs cannot keep it from ending. Held in memory: a
  // restart, or another node, begins at the oldest row, and replaying a row is idempotent by its job id.
  private walk?: IngressWalk;

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
      new Promise<false>(resolve => (timer = setTimeout(resolve, INGRESS_SHUTDOWN_WAIT_MS, false))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.logger.warn('Ingress reconcile pass still running at shutdown; continuing without it', {
        waitMs: INGRESS_SHUTDOWN_WAIT_MS,
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
      // Ids only: a stored payload that does not parse (an imported or hand-edited row) fails the read of the
      // whole batch, so no row behind it would ever be replayed. Each row is read on its own below, and one
      // that cannot be read is kept out of the next batches for a while, so it is not read again on every walk.
      const unreadable = this.setAsideRows(now);
      // A plugin the boot restore has not reached has no worker to take a replay, and the loop below skips its
      // rows, so they are left out here too: a batch's worth of them would otherwise be handed back by every
      // pass until the restore ends, with no other plugin's stranded delivery replayed in the meantime.
      const restoring = this.loader.restorePendingIds();
      // A plugin the walk left out has finished restoring, and its rows lie behind the walk: begin again at the oldest.
      let walk = this.walk?.restoring.every(id => restoring.includes(id)) ? this.walk : undefined;
      const readPage = (from?: IngressWalk): Promise<IngressEvent[]> => {
        const query = this.events
          .createQueryBuilder('e')
          .select('e.id')
          .innerJoin(
            PluginInstance,
            'pi',
            'pi.pluginId = e.pluginId AND pi.instanceId = e.instanceId AND pi.enabled = :enabled',
            { enabled: true },
          )
          .where('e.dispatchState = :state', { state: 'pending' })
          .andWhere('e.createdAt < :before', { before: walkBound(from, cutoff) })
          .andWhere('e.payload IS NOT NULL');
        if (from) {
          // Compared in SQL, as the webhook outbox reconciler does, so the microseconds of a PostgreSQL timestamp are
          // never rounded through a Date; the id orders the rows that share a creation time.
          const position = this.events.createQueryBuilder('c').select(['c.createdAt', 'c.id']).where('c.id = :after');
          query.andWhere(`(e.createdAt, e.id) > (${position.getQuery()})`, { after: from.after });
        }
        if (unreadable.length) query.andWhere('e.id NOT IN (:...unreadable)', { unreadable });
        if (restoring.length) query.andWhere('e.pluginId NOT IN (:...restoring)', { restoring });
        return query.orderBy('e.createdAt', 'ASC').addOrderBy('e.id', 'ASC').limit(opts.batchSize).getMany();
      };
      let batch = await readPage(walk);
      // Nothing left after the walk's position: it ended on a full page, or the row it stands on is gone.
      if (!batch.length && walk) {
        walk = undefined;
        batch = await readPage();
      }
      // The walk goes on after a full page, and from the row before the one a pass stopped at.
      let passed = batch.at(-1)?.id;
      let goesOn = batch.length === opts.batchSize;
      for (const [index, { id }] of batch.entries()) {
        if (this.stop.signal.aborted) break;
        let row: IngressEvent | null;
        try {
          row = await this.events.findOneBy({ id });
        } catch (err) {
          this.logger.error('Ingress reconcile row failed', err instanceof Error ? err.message : String(err), {
            id,
            action: 'ingress_reconcile_row_unreadable',
          });
          // Set aside only a row whose payload could not be read. A read that failed because the database
          // said "not now" (a lock, a dropped connection) is looked at again when the walk gets back to it:
          // by the next pass, as before, unless more rows than a batch are waiting.
          // A payload that does not parse is told by its error class: the message of a SyntaxError quotes
          // the start of the text, which may read like a connection error.
          if ((err instanceof Error && err.name === 'SyntaxError') || !isTransientDbError(err)) {
            this.setAside(id, now, UNREADABLE_RETRY_MS);
          }
          stats.skipped++;
          continue;
        }
        if (!row || row.dispatchState !== 'pending') continue; // settled or removed since the batch was read
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
          // The door answers a plugin the boot restore has not reached with a 503, because no worker can take
          // the delivery yet. A replay is that delivery arriving later: it would only spend an attempt of the
          // row's budget on the same refusal, so the row waits, untouched, for a pass after the restore.
          if (this.loader.isRestorePending(row.pluginId)) {
            stats.skipped++;
            continue;
          }
          stats.scanned++;
          const outcome = await this.reconcileRow(row, opts.maxAttempts, now);
          if (outcome === 'replayed') stats.replayed++;
          else if (outcome === 'failed') stats.failed++;
          else stats.skipped++;
          if (outcome === 'unreachable') {
            this.logger.warn('Ingress queue unreachable; the rest of the reconcile pass waits for the next one', {
              action: 'ingress_reconcile_queue_unreachable',
            });
            // This row was not looked up, so the walk goes on from the one before it and the next pass begins here.
            passed = batch[index - 1]?.id ?? walk?.after;
            goesOn = true;
            break;
          }
        } catch (err) {
          // A bookkeeping failure (repo update/DLQ write) must not abort the batch; the row stays
          // 'pending' and is retried when the walk gets back to it.
          this.logger.error('Ingress reconcile row failed', err instanceof Error ? err.message : String(err), {
            pluginId: row.pluginId,
            instanceId: row.instanceId,
            deliveryId: row.providerDeliveryId,
            action: 'ingress_reconcile_row_failed',
          });
          stats.skipped++;
        }
      }
      this.walk = goesOn && passed ? { after: passed, before: walkBound(walk, cutoff), restoring } : undefined;
      return stats;
    } finally {
      this.inFlight = undefined;
      settle();
    }
  }

  /** Ids of the rows still to be left out of a batch; forgets those whose time to be looked at again came. */
  private setAsideRows(now: Date): string[] {
    for (const [id, until] of this.setAsideUntil) {
      if (until <= now.getTime()) this.setAsideUntil.delete(id);
    }
    return [...this.setAsideUntil.keys()];
  }

  private setAside(id: string, now: Date, retryMs: number): void {
    this.setAsideUntil.delete(id);
    this.setAsideUntil.set(id, now.getTime() + retryMs);
    // Oldest first, as the map keeps insertion order; a store with more of them than this is not a store
    // an operator can leave alone, and the oldest are looked at again.
    while (this.setAsideUntil.size > SET_ASIDE_MAX) {
      const oldest = this.setAsideUntil.keys().next().value as string;
      this.setAsideUntil.delete(oldest);
    }
  }

  /**
   * Hand every 'pending' row created before `cutoff` that still carries its payload to the DLQ, then
   * retire the payload with a 'failed' mark, so the dedup-window prune never deletes an acknowledged
   * delivery that was never dispatched: one stranded across downtime longer than the window, one of an
   * instance disabled for that long, or any stranded row while the sweep is disabled. Same
   * DLQ-before-retire order as the replay budget path. A row the run could not settle, because its
   * hand-off threw or its stored payload cannot be read or reads back as null, is not fetched again in
   * this run, so every row is fetched at most once per run; one still 'pending' keeps its payload, which
   * the prune keeps, and the next run retries it. Once 10 batches' worth of rows could not be settled,
   * the run stops with one warning, which bounds a run against a store that rejects every write. A row
   * whose payload is unreadable or reads back as null never settles on its own: ten batches of them
   * ahead of healthy rows hold those rows back on every run until an operator removes them. Waits for a running sweep rather than skipping
   * the day's run; once shutdown begins, the wait ends with the sweep and the hand-off does nothing,
   * and a running hand-off stops at the next row, like a sweep.
   * A row whose instance or session was deleted, or whose queue job still owns the delivery, gets no
   * dead letter. Returns the number of rows dead-lettered.
   */
  async deadLetterAgedPending(cutoff: Date, batchSize = 100): Promise<number> {
    while (this.inFlight && !this.stop.signal.aborted) await this.inFlight;
    if (this.stop.signal.aborted) return 0;
    let settle!: () => void;
    this.inFlight = new Promise(resolve => (settle = resolve));
    let retired = 0;
    const kept: string[] = [];
    try {
      for (;;) {
        // Ids only. A stored payload that does not parse (an imported or hand-edited row) fails the read of
        // every batch it sits in, so reading the payloads here would hold all rows behind it back on every
        // run. Each payload is read on its own below, where such a row is kept like any other failure.
        const rows = await this.events.find({
          select: { id: true },
          where: {
            dispatchState: 'pending',
            createdAt: LessThan(cutoff),
            payload: Not(IsNull()),
            ...(kept.length ? { id: Not(In(kept)) } : {}),
          },
          order: { createdAt: 'ASC' },
          take: batchSize,
        });
        for (const { id } of rows) {
          // A synchronous database driver (the SQLite default) answers every statement at once, so without
          // this the pass over a large backlog never lets a timer, request or keep-alive run.
          await yieldToEventLoop();
          if (this.stop.signal.aborted) return retired;
          let row: IngressEvent | null;
          try {
            row = await this.events.findOneBy({ id });
          } catch (err) {
            kept.push(id);
            this.logger.error(
              'Failed to read an undispatched ingress event; kept for the next run',
              err instanceof Error ? err.message : String(err),
              { id, action: 'ingress_event_retention_unreadable' },
            );
            continue;
          }
          if (!row || row.dispatchState !== 'pending') continue; // settled or removed since the batch was read
          if (!hasPayload(row)) {
            kept.push(row.id);
            continue;
          }
          const meta = { pluginId: row.pluginId, instanceId: row.instanceId, deliveryId: row.providerDeliveryId };
          try {
            if (await this.ownerDeleted(row)) {
              // The redrive endpoint refuses a deleted instance, and a session delete purges its dead
              // letters on purpose: retire the payload without writing one back, so the prune drops it.
              await this.events.update(
                { id: row.id, dispatchState: 'pending' },
                { dispatchState: 'failed', payload: null },
              );
              this.logger.warn('Undispatched ingress event of a deleted instance or session dropped', {
                ...meta,
                action: 'ingress_event_retention_dropped',
              });
              continue;
            }
            const jobData = this.jobDataFor(row);
            // A job still in the queue (or completed) owns the delivery, as in reconcileRow: no dead
            // letter while a copy can still deliver. A failed one falls through to its existing DLQ row.
            const looked = await this.ingressEnqueue.existingJobState(jobData, row.providerDeliveryId);
            // Past the dedup window a row is not held back for a queue that cannot be asked: it is handed a dead
            // letter, with the payload kept there, as a row with no job is.
            const existing = looked === 'unreachable' ? undefined : looked;
            // Shutdown began while the lookup was out (destroy may have stopped waiting for it).
            if (this.stop.signal.aborted) return retired;
            if (existing && existing !== 'failed') {
              const settled = await this.events.update(
                { id: row.id, dispatchState: 'pending' },
                { dispatchState: 'dispatched', payload: null },
              );
              // As in reconcileRow: the job delivers it, so an inline-failure dead letter must close.
              if (settled.affected) await this.retireOpenDeadLetters(row);
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
            if (written) await this.settleDeadLetter(row, written, marked);
            if (!marked.affected) continue;
            retired++;
            this.logger.warn('Ingress event was never dispatched within the dedup retention window; dead-lettered', {
              ...meta,
              action: 'ingress_event_retention_dead_lettered',
            });
          } catch (err) {
            kept.push(row.id);
            this.logger.error(
              'Failed to dead-letter an undispatched ingress event; kept for the next run',
              err instanceof Error ? err.message : String(err),
              { ...meta, action: 'ingress_event_retention_dead_letter_failed' },
            );
          }
        }
        if (rows.length < batchSize) return retired;
        if (kept.length >= 10 * batchSize) {
          this.logger.warn('Ingress retention hand-off stopped early; the remaining events wait for the next run', {
            kept: kept.length,
            action: 'ingress_event_retention_handoff_stopped',
          });
          return retired;
        }
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

  /**
   * Called after a dead letter was ensured and the event marked 'failed' only while still 'pending'.
   * Returns the event's state, re-read when the mark missed because another writer settled it first.
   * `written` (the row this call wrote, if any) must not stay redrivable for a delivery the dispatch
   * tier made concurrently. For a failed event, another writer (a hand-off or a sweep, here or on
   * another node) may have written a dead letter too, or skipped its own because of this one, so a
   * writer retires its row only when an open one with a lower id exists: the lowest-id open row is
   * never retired, and normally it is the only one left. Ids are random UUIDs, so a writer whose check
   * runs before a lower-id row is visible keeps its own as well, and two open rows can remain.
   */
  private async settleDeadLetter(
    row: IngressEvent,
    written: string | undefined,
    marked: UpdateResult,
  ): Promise<IngressDispatchState | null | undefined> {
    const state = marked.affected
      ? 'failed'
      : (await this.events.findOne({ where: { id: row.id }, select: { dispatchState: true } }))?.dispatchState;
    if (written && (state === 'dispatched' || (state === 'failed' && (await this.hasOpenDeadLetter(row, written))))) {
      await this.failures.update({ id: written, redriven: false }, { redriven: true });
    }
    return state;
  }

  // An open dead letter for the row's delivery, or only one with an id below `below` when given.
  private async hasOpenDeadLetter(row: IngressEvent, below?: string): Promise<boolean> {
    const open = await this.failures.count({
      where: {
        direction: 'inbound',
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        redriven: false,
        ...(below !== undefined && { id: LessThan(below) }),
      },
    });
    return open > 0;
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
  ): Promise<'replayed' | 'failed' | 'interrupted' | 'unreachable'> {
    const jobData = this.jobDataFor(row);
    // jobId = the ORIGINAL deliveryId, so the replay lands on any job the live path did enqueue before
    // its outcome mark was lost. BullMQ resolves a duplicate add() whatever that job's state, so look
    // first: a live job already owns the delivery, and a failed one would swallow the replay.
    const existing = await this.ingressEnqueue.existingJobState(jobData, row.providerDeliveryId);
    // Shutdown began while the lookup was out, and destroy may have stopped waiting for it: a dispatch
    // now could land after plugin teardown and spend an attempt. Leave the row for the next start.
    if (this.stop.signal.aborted) return 'interrupted';
    // The queue could not be asked, so the job may well exist: a replay would dispatch inline beside it, and
    // again once Redis answers. The row is left as it is, and the sweep stops here, since no other row of
    // the pass can be looked up either.
    if (existing === 'unreachable') return 'unreachable';
    if (existing === 'failed') {
      // Every queue attempt already ran and IngressProcessor dead-lettered the delivery, or re-queued it
      // and every copy failed too: a live or completed copy answers for the job (see existingJobState).
      // Nothing is dispatched: the DLQ row stays redrivable (written here if the processor's write was
      // lost, and before the payload is retired, since it becomes the payload's only home). A copy the
      // lookup missed (one pruned once completed), or a redrive of the open row, has already marked the
      // event 'dispatched', so the mark only lands on a still-'pending' event, and the row this sweep
      // wrote is settled as in the hand-off. Only that row: 'dispatched' is also the mark for a job that
      // was still live, and a row written before this sweep can be the dead letter of a delivery that
      // never arrived, so the event counts as replayed only once no open row is left.
      const written = await this.ensureDeadLetterRow(
        jobData,
        resolveIngressJobOptions().attempts,
        'ingress queue job failed',
      );
      const marked = await this.events.update(
        { id: row.id, dispatchState: 'pending' },
        { lastDispatchAt: now, dispatchState: 'failed', payload: null },
      );
      if (await this.settledElsewhere(row, written, marked)) return 'replayed';
      this.logger.warn('Stranded ingress event already failed in the queue; left for redrive', {
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        action: 'ingress_event_reconcile_job_failed',
      });
      return 'failed';
    }
    if (existing === 'completed') {
      // The worker delivered it and the write that retires the row did not land. Settle the row and deliver
      // nothing: a replay would hand the plugin the same event again. Only while still 'pending', so a row
      // another writer failed or settled meanwhile is left as it is. Any dead letter the live path wrote for
      // it (the inline-failure case) closes too, so a manual redrive does not deliver it a second time.
      await this.events.update(
        { id: row.id, dispatchState: 'pending' },
        { dispatchState: 'dispatched', lastDispatchAt: now, payload: null },
      );
      await this.retireOpenDeadLetters(row);
      this.logger.log('Settled stranded ingress event whose queue job already completed', {
        pluginId: row.pluginId,
        instanceId: row.instanceId,
        deliveryId: row.providerDeliveryId,
        action: 'ingress_event_reconcile_job_completed',
      });
      return 'replayed';
    }
    if (existing) {
      // The job is waiting behind a backlog, running or delayed, and the worker settles the row when it
      // finishes: the row keeps its payload until then and is looked at again after a while. Any dead
      // letter the live path wrote for it (the inline-failure case) closes, since the job delivers it.
      await this.retireOpenDeadLetters(row);
      this.setAside(row.id, now, LIVE_JOB_RETRY_MS);
      return 'interrupted';
    }
    // No job: Redis lost it (a restart without its data, a failover to a replica that was behind, an
    // eviction, a job removed in the queue dashboard), or it was never added (a crash before the add). A
    // delivery whose replayed job keeps vanishing has spent its budget: it is dead-lettered for redrive. Only
    // with the queue on: without it there is no job to vanish, and a row with a budget left of one replay
    // gets that replay, as before, before its failure goes terminal below.
    if (this.ingressEnqueue.isQueueActive() && (row.dispatchAttempts ?? 0) >= maxAttempts) {
      return this.deadLetterExhausted(row, jobData, row.dispatchAttempts, 'ingress queue job lost', now);
    }
    // The add can also outlast destroy's wait (see onModuleDestroy). Given the stop signal, enqueue()
    // throws instead of dispatching inline once it has aborted, and the row is left as above.
    const result: EnqueueOutcome | undefined = await this.ingressEnqueue
      .enqueue(jobData, row.providerDeliveryId, this.stop.signal)
      .catch(err => {
        if (this.stop.signal.aborted) return undefined;
        throw err;
      });
    if (!result) return 'interrupted';
    const { outcome, error } = result;
    if (outcome !== 'failed') {
      if (outcome === 'queued') {
        // The new job is how the delivery reaches the plugin again: the row keeps its payload until the worker
        // settles it, and the replay counts against the budget, so a job that keeps vanishing ends in a dead
        // letter. Only while 'pending': the worker may already have finished it.
        await this.events.update(
          { id: row.id, dispatchState: 'pending' },
          { lastDispatchAt: now, dispatchAttempts: (row.dispatchAttempts ?? 0) + 1 },
        );
      } else {
        // The inline dispatch ran and succeeded: the plugin has the delivery, so the row retires its payload and
        // slims to its marker.
        await this.events.update({ id: row.id }, { dispatchState: 'dispatched', lastDispatchAt: now, payload: null });
      }
      // Retire any dead-letter row the live path already wrote for this delivery (the inline-failure
      // case): the replay delivers it, so a later manual redrive must not deliver it again.
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
    if (terminal) return this.deadLetterExhausted(row, jobData, attempts, error, now);
    // Non-terminal: keep the payload — the next sweep replays from it.
    await this.events.update({ id: row.id }, { dispatchAttempts: attempts, lastDispatchAt: now });
    return 'failed';
  }

  // The replay budget is spent: DLQ BEFORE the terminal mark + payload retirement, since the dead-letter row is
  // the payload's new home and must exist first. ensureDeadLetterRow is idempotent (count-guarded), so a crash
  // between the two writes just makes the next sweep re-take this path and finish the mark. A redrive of the
  // live-path row during this replay closes the event and that row, so, as in the failed-job branch, the mark
  // only lands on a still-'pending' event and the row this sweep wrote is settled as in the hand-off.
  private async deadLetterExhausted(
    row: IngressEvent,
    jobData: IngressJobData,
    attempts: number,
    error: string | undefined,
    now: Date,
  ): Promise<'replayed' | 'failed'> {
    const written = await this.ensureDeadLetterRow(jobData, attempts, error);
    const marked = await this.events.update(
      { id: row.id, dispatchState: 'pending' },
      { dispatchAttempts: attempts, lastDispatchAt: now, dispatchState: 'failed', payload: null },
    );
    if (await this.settledElsewhere(row, written, marked)) return 'replayed';
    this.logger.warn('Ingress event replay budget exhausted; event is dead-lettered', {
      pluginId: row.pluginId,
      instanceId: row.instanceId,
      deliveryId: row.providerDeliveryId,
      attempts,
      action: 'ingress_event_reconcile_exhausted',
    });
    return 'failed';
  }

  // Settles the sweep's dead letter, then tells whether another writer dispatched the event and left
  // nothing to redrive, so the sweep neither logs nor counts it as dead-lettered.
  private async settledElsewhere(
    row: IngressEvent,
    written: string | undefined,
    marked: UpdateResult,
  ): Promise<boolean> {
    const state = await this.settleDeadLetter(row, written, marked);
    return state === 'dispatched' && !(await this.hasOpenDeadLetter(row));
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
