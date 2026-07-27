import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { createLogger } from '../../common/services/logger.service';

// Dedup rows are a delivery-id oracle, not an audit log: provider retries arrive within minutes, so
// a short window (default 7 days) bounds the table without weakening dedup. Failure rows carry the
// redrive payload and have audit value, so they keep the longer INGRESS_RETENTION_DAYS window.
const DEFAULT_DEDUP_RETENTION_DAYS = 7;
const DEFAULT_FAILURE_RETENTION_DAYS = 90;

/**
 * Bounds the growth of two append-only integration-fabric tables that otherwise grow without bound:
 * `ingress_events` (the inbound dedup/event log) and `integration_delivery_failures` (the DLQ).
 *
 * Mirrors the AuditService / WebhookService retention: runs once at startup then daily via a raw
 * `setInterval` (unref'd). Both tables carry a `createdAt` column (ingress_events is indexed on it),
 * so the prune is an indexed `createdAt < cutoff` delete — the same shape as the sibling prunes.
 *
 * Two independent windows:
 * - `INGRESS_DEDUP_RETENTION_DAYS` (default 7) prunes `ingress_events`. <= 0 does NOT disable it —
 *   an unpruned dedup table grows without bound for zero functional gain (its payloads are retired
 *   on dispatch and its audit value is nil), so a non-positive value falls back to the default with
 *   a warning instead of silently opting into unbounded growth.
 * - `INGRESS_RETENTION_DAYS` (default 90) prunes `integration_delivery_failures` — the redrive
 *   payload store, where long retention can be a deliberate operator choice. <= 0 disables that
 *   prune (and only that prune).
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
    const parsedRetention = Number.parseInt(process.env.INGRESS_RETENTION_DAYS ?? '', 10);
    const retentionDays = Number.isInteger(parsedRetention)
      ? Math.max(0, parsedRetention)
      : DEFAULT_FAILURE_RETENTION_DAYS;

    const parsedDedup = Number.parseInt(process.env.INGRESS_DEDUP_RETENTION_DAYS ?? '', 10);
    let dedupDays = Number.isInteger(parsedDedup) ? parsedDedup : DEFAULT_DEDUP_RETENTION_DAYS;
    if (dedupDays <= 0) {
      this.logger.warn(
        `INGRESS_DEDUP_RETENTION_DAYS <= 0 does not disable dedup pruning (an unpruned ingress_events ` +
          `table grows without bound); falling back to the ${DEFAULT_DEDUP_RETENTION_DAYS}-day default`,
        { action: 'ingress_dedup_retention_clamped' },
      );
      dedupDays = DEFAULT_DEDUP_RETENTION_DAYS;
    }
    if (retentionDays <= 0) {
      this.logger.log(
        'Integration delivery-failure retention disabled (INGRESS_RETENTION_DAYS <= 0); dedup retention still applies',
      );
    }
    const runPrune = (): void => {
      this.pruneOlderThan(dedupDays, retentionDays > 0 ? retentionDays : null)
        .then(({ events, failures }) => {
          if (events > 0) this.logger.log(`Pruned ${events} ingress event(s) older than ${dedupDays} day(s)`);
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
   * Delete ingress_events rows older than `eventsDays` and integration_delivery_failures rows older
   * than `failuresDays` (null skips the failures prune; omitted = same window as events). Returns
   * the number removed from each table.
   */
  async pruneOlderThan(
    eventsDays: number,
    failuresDays: number | null = eventsDays,
  ): Promise<{ events: number; failures: number }> {
    const eventsCutoff = new Date();
    eventsCutoff.setDate(eventsCutoff.getDate() - eventsDays);
    const failuresCutoff = new Date();
    if (failuresDays !== null) failuresCutoff.setDate(failuresCutoff.getDate() - failuresDays);
    const [eventsResult, failuresResult] = await Promise.all([
      this.eventRepository.delete({ createdAt: LessThan(eventsCutoff) }),
      failuresDays === null
        ? Promise.resolve({ affected: 0 })
        : this.failureRepository.delete({ createdAt: LessThan(failuresCutoff) }),
    ]);
    return { events: eventsResult.affected || 0, failures: failuresResult.affected || 0 };
  }
}
