import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IngressJobData } from '../queue/processors/ingress.processor';

// The ingress processor persists the full ingress payload on the DLQ row as
// { route, providerConversationId?, ingress: <headers/query/body/rawBody> }, so redrive is
// self-contained: it reads stored.ingress back out and re-enqueues without re-reading ingress_events.
interface StoredDlqPayload {
  route?: string;
  providerConversationId?: string;
  ingress?: IngressJobData['payload'];
}

@Injectable()
export class RedriveService {
  constructor(
    @InjectRepository(IntegrationDeliveryFailure, 'data') private readonly repo: Repository<IntegrationDeliveryFailure>,
    private readonly ingressEnqueue: IngressEnqueueService,
  ) {}

  async redriveInstance(pluginId: string, instanceId: string): Promise<{ redriven: number }> {
    const rows = await this.repo.find({ where: { pluginId, instanceId, direction: 'inbound', redriven: false } });

    let redriven = 0;
    for (const row of rows) {
      const stored = (row.payload ?? {}) as StoredDlqPayload;
      // Re-mint a jobId so BullMQ accepts the replay even if the original jobId lingers.
      const jobId = `redrive:${row.id}`;
      const { outcome } = await this.ingressEnqueue.enqueue(
        {
          pluginId,
          instanceId,
          route: stored.route ?? '',
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
      }
    }
    return { redriven };
  }
}
