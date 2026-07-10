import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { createLogger } from '../../common/services/logger.service';

/**
 * Bounds the growth of two append-only integration-fabric tables that otherwise grow without bound:
 * `ingress_events` (the inbound dedup/event log) and `integration_delivery_failures` (the DLQ).
 *
 * Mirrors the AuditService / WebhookService retention: runs once at startup then daily via a raw
 * `setInterval` (unref'd), gated by INGRESS_RETENTION_DAYS (default 90; set <= 0 to disable). Both
 * tables carry a `createdAt` column (ingress_events is indexed on it), so the prune is an indexed
 * `createdAt < cutoff` delete — the same shape as the sibling prunes.
 */
@Injectable()
export class IntegrationRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('IntegrationRetentionService');
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(IngressEvent, 'data') private readonly eventRepository: Repository<IngressEvent>,
    @InjectRepository(IntegrationDeliveryFailure, 'data')
    private readonly failureRepository: Repository<IntegrationDeliveryFailure>,
  ) {}

  onModuleInit(): void {
    const parsed = Number.parseInt(process.env.INGRESS_RETENTION_DAYS ?? '', 10);
    const retentionDays = Number.isInteger(parsed) ? Math.max(0, parsed) : 90;
    if (retentionDays <= 0) {
      this.logger.log('Integration ingress retention disabled (INGRESS_RETENTION_DAYS <= 0)');
      return;
    }
    const runPrune = (): void => {
      this.pruneOlderThan(retentionDays)
        .then(({ events, failures }) => {
          if (events > 0) this.logger.log(`Pruned ${events} ingress event(s) older than ${retentionDays} day(s)`);
          if (failures > 0) {
            this.logger.log(`Pruned ${failures} integration delivery-failure(s) older than ${retentionDays} day(s)`);
          }
        })
        .catch(err =>
          this.logger.error('Integration ingress retention failed', err instanceof Error ? err.stack : String(err)),
        );
    };
    runPrune(); // prune once at startup
    this.cleanupTimer = setInterval(runPrune, 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  /**
   * Delete ingress_events + integration_delivery_failures rows older than the retention window.
   * Returns the number removed from each table.
   */
  async pruneOlderThan(olderThanDays: number): Promise<{ events: number; failures: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const [eventsResult, failuresResult] = await Promise.all([
      this.eventRepository.delete({ createdAt: LessThan(cutoff) }),
      this.failureRepository.delete({ createdAt: LessThan(cutoff) }),
    ]);
    return { events: eventsResult.affected || 0, failures: failuresResult.affected || 0 };
  }
}
