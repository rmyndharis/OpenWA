import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
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
    private readonly ingressEnqueue: IngressEnqueueService,
  ) {}

  redriveInstance(
    pluginId: string,
    instanceId: string,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    return this.lock.run(`redrive:${pluginId}:${instanceId}`, () => this.redriveBatch(pluginId, instanceId));
  }

  private async redriveBatch(
    pluginId: string,
    instanceId: string,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    const where = { pluginId, instanceId, direction: 'inbound' as const, redriven: false };
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
