import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, Raw, Repository } from 'typeorm';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { KeyedAsyncLock } from './ordering-lock';
import { INGRESS_SHUTDOWN_WAIT_MS } from './integration.constants';
import { createLogger } from '../../common/services/logger.service';
import { DateTransformer } from '../../common/transformers/date.transformer';
import { markAfterEffect } from '../../common/filters/database-unavailable.filter';
import { isAllSessionsScope } from '../../core/plugins/plugin-activation';

const REDRIVE_BATCH_SIZE = 100;
// A take of a row outlives any dispatch by far (an inline one has five seconds); one this old was never settled.
const REDRIVE_CLAIM_EXPIRY_MS = 5 * 60_000;

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
      new Promise<false>(resolve => (timer = setTimeout(resolve, INGRESS_SHUTDOWN_WAIT_MS, false))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.logger.warn('Ingress redrive still running at shutdown; continuing without it', {
        waitMs: INGRESS_SHUTDOWN_WAIT_MS,
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
    // Only rows no other redrive holds: one taken by a redrive still running is left to it.
    const free = () => {
      const claimedAt = this.unclaimed();
      return Array.isArray(where) ? where.map(scope => ({ ...scope, claimedAt })) : { ...where, claimedAt };
    };
    // Read one body as its replay starts, so the window holds only ids and malformed payloads stay isolated.
    const rows = this.stop.signal.aborted
      ? []
      : await this.repo.find({ select: { id: true }, where: free(), order, take: REDRIVE_BATCH_SIZE });

    let redriven = 0;
    for (const { id } of rows) {
      if (this.stop.signal.aborted) break;
      let row: IntegrationDeliveryFailure | null;
      try {
        const scopes = free();
        row = await this.repo.findOneBy(
          Array.isArray(scopes) ? scopes.map(scope => ({ ...scope, id })) : { ...scopes, id },
        );
      } catch (rowError) {
        this.logger.error(
          'A dead letter could not be read and is skipped',
          rowError instanceof Error ? rowError.message : String(rowError),
          { id, action: 'ingress_redrive_row_unreadable' },
        );
        // Move an unreadable row behind the others so it cannot occupy every later window.
        await this.repo.increment({ id }, 'attempts', 1).catch(() => undefined);
        continue;
      }
      if (!row) continue;
      if (this.stop.signal.aborted) break;
      const stored = (row.payload ?? {}) as StoredDlqPayload;
      // The delivery is taken before it goes out. Its event first, so the reconciler does not replay it: a live-path
      // inline failure leaves it 'pending' beside this row, with the payload the reconciler replays, which stays until
      // the dispatch went out. Then the row, taken only while no other redrive holds it, so a redrive running on another
      // node leaves it alone. A take never settled (the node stopped, or the database refused the write that retires or
      // puts back the row) is taken again once it is five minutes old: the handler may then receive the delivery twice,
      // under the delivery id it keys its side effects on, rather than never. A legacy row (deliveryId null) predates
      // persist-before-ack and has no event.
      const heldEvent = row.deliveryId ? await this.holdEvent(pluginId, instanceId, row.deliveryId) : false;
      const { affected } = await this.repo
        .update({ id: row.id, redriven: false, claimedAt: this.unclaimed() }, { claimedAt: new Date() })
        .catch(async (error: unknown) => {
          // Nothing went out: the event goes back to the reconciler. A row another redrive took keeps it held.
          if (heldEvent) await this.restoreEvent(row);
          throw error;
        });
      if (!affected) continue;
      if (row.claimedAt) {
        this.logger.warn(
          'A delivery an earlier redrive took and never settled is taken again; its handler may get it twice',
          {
            id: row.id,
            deliveryId: row.deliveryId,
            claimedAt: row.claimedAt.toISOString(),
            action: 'ingress_redrive_claim_expired',
          },
        );
      }
      // A jobId of its own for each dispatch, so a row put back after one that did not go out is never taken for it.
      const jobId = `redrive:${row.id}:${Math.max(0, row.attempts ?? 0)}:${randomUUID()}`;
      // Given the stop signal, enqueue() throws instead of dispatching inline once it has aborted, since the plugin may
      // already be torn down: nothing went out, so what this redrive took is put back.
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
      if (!result) {
        await this.putBack(row, heldEvent);
        break;
      }
      const { outcome, error } = result;
      // Queued or delivered: the row is retired. A swallowed inline-dispatch failure ('failed') sent nothing, so the row
      // is redrivable again with one more attempt, rather than retired and the event lost for good.
      if (outcome !== 'failed') {
        redriven++;
        await this.repo.update({ id: row.id }, { redriven: true, claimedAt: null }).catch((error: unknown) =>
          this.logger.warn('A redriven delivery went out but could not be retired; a redrive takes it again later', {
            id: row.id,
            deliveryId: row.deliveryId,
            error: error instanceof Error ? error.message : String(error),
            action: 'ingress_redrive_retire_failed',
          }),
        );
        // The reconciler's replay source is not needed any more, held by this redrive or by one that never settled; a
        // row left with it is pruned with the others.
        if (row.deliveryId) {
          await this.events
            .update(
              { pluginId, instanceId, providerDeliveryId: row.deliveryId, dispatchState: 'dispatched' },
              { payload: null },
            )
            .catch(() => undefined);
        }
      } else {
        await this.putBack(row, heldEvent, error ?? 'redrive dispatch failed');
      }
    }
    const remaining = await this.repo.count({ where });
    return { redriven, remaining, batchSize: REDRIVE_BATCH_SIZE };
  }

  /** Retires a delivery's event while still 'pending', so the reconciler does not replay it; whether it did. */
  private async holdEvent(pluginId: string, instanceId: string, providerDeliveryId: string): Promise<boolean> {
    const { affected } = await this.events.update(
      { pluginId, instanceId, providerDeliveryId, dispatchState: 'pending' },
      { dispatchState: 'dispatched', lastDispatchAt: new Date() },
    );
    return Boolean(affected);
  }

  /** A row free to take: no redrive holds it, or the one that took it never settled it. */
  private unclaimed() {
    const expired = DateTransformer.to(new Date(Date.now() - REDRIVE_CLAIM_EXPIRY_MS)) as Date | string;
    return Raw(column => `(${column} IS NULL OR ${column} <= :claimExpired)`, { claimExpired: expired });
  }

  /**
   * Puts back what a redrive took for a dispatch that did not go out: the row redrivable again (one more attempt when
   * the dispatch failed) and its event 'pending'. A database that refuses the row leaves it taken until a redrive takes
   * it again; that is logged with both ids and never answered as a success.
   */
  private async putBack(row: IntegrationDeliveryFailure, heldEvent: boolean, failure?: string): Promise<void> {
    try {
      await this.repo.update(
        { id: row.id },
        failure === undefined
          ? { claimedAt: null }
          : { claimedAt: null, attempts: Math.max(0, row.attempts ?? 0) + 1, lastError: failure },
      );
    } catch (error) {
      this.logger.error(
        'A redrive that did not go out could not be put back; a redrive takes it again five minutes after it was taken',
        error instanceof Error ? error.message : String(error),
        { id: row.id, deliveryId: row.deliveryId, action: 'ingress_redrive_put_back_failed' },
      );
      throw markAfterEffect(error);
    }
    if (heldEvent) await this.restoreEvent(row);
  }

  /** Hands a held event back to the reconciler. Refused, it stays held, and the dead letter still redrives it. */
  private async restoreEvent(row: IntegrationDeliveryFailure): Promise<void> {
    await this.events
      .update(
        {
          pluginId: row.pluginId,
          instanceId: row.instanceId,
          providerDeliveryId: row.deliveryId!,
          dispatchState: 'dispatched',
        },
        { dispatchState: 'pending' },
      )
      .catch((error: unknown) =>
        this.logger.warn(
          'A held ingress event could not be handed back to the reconciler; its dead letter redrives it',
          {
            id: row.id,
            deliveryId: row.deliveryId,
            error: error instanceof Error ? error.message : String(error),
            action: 'ingress_redrive_event_restore_failed',
          },
        ),
      );
  }
}
