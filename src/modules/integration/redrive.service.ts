import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { KeyedAsyncLock } from './ordering-lock';
import { INGRESS_DISPATCH_TIMEOUT_MS } from './integration.constants';
import { createLogger } from '../../common/services/logger.service';
import { isAllSessionsScope } from '../../core/plugins/plugin-activation';

const REDRIVE_BATCH_SIZE = 100;

// The ingress processor persists the full ingress payload on the DLQ row as
// { route, providerConversationId?, ingress: <headers/query/body/rawBody> }, so redrive is
// self-contained: it reads stored.ingress back out and re-enqueues without re-reading ingress_events.
interface StoredDlqPayload {
  route?: string;
  method?: string;
  providerConversationId?: string;
  ingress?: IngressJobData['payload'];
}

@Injectable()
export class RedriveService implements OnModuleDestroy {
  private readonly logger = createLogger('IntegrationRedrive');
  private readonly lock = new KeyedAsyncLock();
  // Aborted on destroy: a batch in progress takes no further row.
  private readonly stop = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @InjectRepository(IntegrationDeliveryFailure, 'data') private readonly repo: Repository<IntegrationDeliveryFailure>,
    @InjectRepository(IngressEvent, 'data') private readonly events: Repository<IngressEvent>,
    private readonly ingressEnqueue: IngressEnqueueService,
  ) {}

  /**
   * A redrive runs inside an admitted HTTP request, which shutdown lets finish, and nothing else waits
   * for it: left alone it would go on replaying while the plugins are disabled and the database closes,
   * raising the attempts of rows no live plugin ever saw. Stop at the next row and wait for the replay
   * in hand, as the webhook redrive and the ingress reconciler do. Rows not reached stay open and are
   * counted in `remaining`.
   */
  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => true),
      new Promise<false>(resolve => (timer = setTimeout(resolve, INGRESS_DISPATCH_TIMEOUT_MS, false))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.logger.warn('Ingress redrive still running at shutdown; continuing without it', {
        waitMs: INGRESS_DISPATCH_TIMEOUT_MS,
        action: 'ingress_redrive_shutdown_timeout',
      });
    }
  }

  /**
   * `sessionScope` is the instance's CURRENT binding (null or '*' for all sessions). Only rows written under
   * that binding are replayed or counted: dispatch refuses a delivery whose instance was bound to another
   * session since, so a row of an earlier binding would be retired here and dead-lettered again by its job.
   */
  redriveInstance(
    pluginId: string,
    instanceId: string,
    sessionScope: string | null,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    const run = this.lock.run(`redrive:${pluginId}:${instanceId}`, () =>
      this.redriveBatch(pluginId, instanceId, sessionScope),
    );
    this.inFlight.add(run);
    const forget = () => void this.inFlight.delete(run);
    run.then(forget, forget);
    return run;
  }

  private async redriveBatch(
    pluginId: string,
    instanceId: string,
    sessionScope: string | null,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    const base = { pluginId, instanceId, direction: 'inbound' as const, redriven: false };
    // A job of the all-sessions scope carries no session or '*', whichever way it was stored.
    const where = isAllSessionsScope(sessionScope)
      ? [
          { ...base, sessionId: IsNull() },
          { ...base, sessionId: '*' },
        ]
      : { ...base, sessionId: sessionScope as string };
    // Failed replays increment attempts and move behind never-retried rows, preventing one permanent
    // failure from livelocking the bounded window while keeping it redrivable.
    const order = { attempts: 'ASC', createdAt: 'ASC' } as const;
    let rows: IntegrationDeliveryFailure[];
    try {
      rows = await this.repo.find({ where, order, take: REDRIVE_BATCH_SIZE });
    } catch (err) {
      // A stored payload that does not parse (an imported or hand-edited dead letter) fails the read of
      // the whole window, and it heads the window for good since it is never replayed, so every redrive
      // of the instance would fail with it. Read the window again row by row and skip the unreadable one.
      this.logger.warn('Reading the dead letters of an instance failed; reading them row by row', {
        pluginId,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
        action: 'ingress_redrive_window_unreadable',
      });
      const ids = await this.repo.find({ select: { id: true }, where, order, take: REDRIVE_BATCH_SIZE });
      rows = [];
      for (const { id } of ids) {
        try {
          const row = await this.repo.findOneBy({ id });
          if (row) rows.push(row);
        } catch (rowError) {
          this.logger.error(
            'A dead letter could not be read and is skipped',
            rowError instanceof Error ? rowError.message : String(rowError),
            { id, action: 'ingress_redrive_row_unreadable' },
          );
          // Counted as a failed replay, by id and so without reading the payload: left at attempts 0 it
          // heads every window for good, and a batch of them would starve the rows behind it.
          await this.repo.increment({ id }, 'attempts', 1).catch(() => undefined);
        }
      }
    }

    let redriven = 0;
    for (const row of rows) {
      if (this.stop.signal.aborted) break;
      const stored = (row.payload ?? {}) as StoredDlqPayload;
      // Re-mint a jobId so BullMQ accepts the replay even if the original jobId lingers.
      const jobId = `redrive:${row.id}`;
      // Given the stop signal, enqueue() throws instead of dispatching inline once it has aborted: the
      // row is left open and unchanged, since the plugin may already be torn down.
      const result = await this.ingressEnqueue
        .enqueue(
          {
            pluginId,
            instanceId,
            route: stored.route ?? '',
            method: stored.method ?? 'POST',
            deliveryId: row.deliveryId ?? row.id,
            sessionId: row.sessionId ?? undefined,
            providerConversationId: stored.providerConversationId,
            payload: stored.ingress as IngressJobData['payload'],
          },
          jobId,
          this.stop.signal,
        )
        .catch(err => {
          if (this.stop.signal.aborted) return undefined;
          throw err;
        });
      if (!result) break;
      const { outcome, error } = result;
      // Only retire the DLQ row once the replay was actually accepted (queued) or delivered. A swallowed
      // inline-dispatch failure ('failed') leaves the row redriven=false so it stays redrivable, instead
      // of silently marking it handled and permanently losing the event.
      if (outcome !== 'failed') {
        // Retire the matching ingress_events row FIRST (mirrors the reconciler's own ordering): a
        // live-path inline failure leaves that row 'pending' next to this DLQ row, so without the mark
        // the reconciler would sweep and replay the same delivery — a double delivery to the plugin.
        // Conditional on 'pending' so a row the reconciler already closed is left alone; a legacy DLQ
        // row (deliveryId null) predates persist-before-ack and has no event row to retire.
        if (row.deliveryId) {
          await this.events.update(
            { pluginId, instanceId, providerDeliveryId: row.deliveryId, dispatchState: 'pending' },
            { dispatchState: 'dispatched', lastDispatchAt: new Date(), payload: null },
          );
        }
        await this.repo.update({ id: row.id }, { redriven: true });
        redriven++;
      } else {
        await this.repo.update(
          { id: row.id },
          { attempts: Math.max(0, row.attempts ?? 0) + 1, lastError: error ?? 'redrive dispatch failed' },
        );
      }
    }
    const remaining = await this.repo.count({ where });
    return { redriven, remaining, batchSize: REDRIVE_BATCH_SIZE };
  }
}
