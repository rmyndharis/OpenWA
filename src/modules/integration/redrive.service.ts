import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { KeyedAsyncLock } from './ordering-lock';

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
export class RedriveService {
  private readonly lock = new KeyedAsyncLock();

  constructor(
    @InjectRepository(IntegrationDeliveryFailure, 'data') private readonly repo: Repository<IntegrationDeliveryFailure>,
    @InjectRepository(IngressEvent, 'data') private readonly events: Repository<IngressEvent>,
    private readonly ingressEnqueue: IngressEnqueueService,
  ) {}

  redriveInstance(
    pluginId: string,
    instanceId: string,
    sessionIdFilter: string | null,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    return this.lock.run(`redrive:${pluginId}:${instanceId}`, () =>
      this.redriveBatch(pluginId, instanceId, sessionIdFilter),
    );
  }

  private async redriveBatch(
    pluginId: string,
    instanceId: string,
    sessionIdFilter: string | null,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    const where = {
      pluginId,
      instanceId,
      direction: 'inbound' as const,
      redriven: false,
      ...(sessionIdFilter === null ? {} : { sessionId: sessionIdFilter }),
    };
    const rows = await this.repo.find({
      where,
      // Failed replays increment attempts and move behind never-retried rows, preventing one permanent
      // failure from livelocking the bounded window while keeping it redrivable.
      order: { attempts: 'ASC', createdAt: 'ASC' },
      take: REDRIVE_BATCH_SIZE,
    });

    let redriven = 0;
    for (const row of rows) {
      const stored = (row.payload ?? {}) as StoredDlqPayload;
      // Re-mint a jobId so BullMQ accepts the replay even if the original jobId lingers.
      const jobId = `redrive:${row.id}`;
      const { outcome, error } = await this.ingressEnqueue.enqueue(
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
      );
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
