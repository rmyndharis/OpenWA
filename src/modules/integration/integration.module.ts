import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { IngressEventService } from './ingress-event.service';
import { IngressService, IngressRouteDescriptor } from './ingress.service';
import { IngressController } from './ingress.controller';
import { IngressEnqueueService, buildIngressDeadLetterRow } from './ingress-enqueue.service';
import { RedriveService } from './redrive.service';
import { RedriveController } from './redrive.controller';
import { IntegrationRetentionService } from './integration-retention.service';
import { IntegrationInstanceController } from './integration-instance.controller';
import { ScopeBindingService } from './scope-binding.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { createLogger } from '../../common/services/logger.service';

/**
 * Wires the @Public ingress HTTP surface: instance/event persistence services and the fast-ack
 * IngressService, whose deps are built by a factory so the pure pipeline stays DI-free and testable.
 * Queue-vs-inline enqueue is delegated to IngressEnqueueService (its own optional-queue injection),
 * shared with RedriveService so a DLQ replay goes through the exact same path a live delivery would.
 * PluginLoaderService is @Global (PluginsModule), so it injects without importing that module.
 */
@Module({
  imports: [
    SessionModule,
    TypeOrmModule.forFeature([PluginInstance, IngressEvent, IntegrationDeliveryFailure], 'data'),
  ],
  controllers: [IngressController, RedriveController, IntegrationInstanceController],
  providers: [
    PluginInstanceService,
    IngressEventService,
    IngressEnqueueService,
    RedriveService,
    ScopeBindingService,
    IntegrationRetentionService,
    {
      provide: IngressService,
      inject: [
        PluginInstanceService,
        IngressEventService,
        PluginLoaderService,
        IngressEnqueueService,
        getRepositoryToken(IntegrationDeliveryFailure, 'data'),
        SessionService,
      ],
      useFactory: (
        instances: PluginInstanceService,
        events: IngressEventService,
        loader: PluginLoaderService,
        ingressEnqueue: IngressEnqueueService,
        failures: Repository<IntegrationDeliveryFailure>,
        sessions: SessionService,
      ) => {
        const dlqLogger = createLogger('IngressEnqueue');
        const ingressLogger = createLogger('Ingress');
        return new IngressService({
          instances: { resolve: (pluginId, instanceId) => instances.resolve(pluginId, instanceId) },
          manifestRoute: (pluginId, route): IngressRouteDescriptor | undefined =>
            loader.getPlugin(pluginId)?.manifest.ingress?.find(r => r.route === route),
          events: { recordOrSkip: input => events.recordOrSkip(input) },
          // O(1) in-memory liveness probe for the `session-alive` preflight: a Map read + a field read.
          // MUST stay cheap — never call engine.initialize() here (that is the slow/blocking path bounded
          // separately by the #667/#696 init-timeout). Undefined = no live engine (stopped/deleted).
          sessionStatus: (scope: string) => sessions.getEngine(scope)?.getStatus(),
          // Audit sink for preflight rejections (they leave no dedup/DLQ row). The Prometheus counter is
          // a separate follow-up (see plan notes); the structured log is the MVP audit surface.
          log: (event, meta) => ingressLogger.warn(event, meta),
          // Live ingress delivery: on a swallowed inline-dispatch failure, persist a dead-letter row so
          // RedriveService can replay it — IngressService.handle() ignores the outcome and always 202s, so
          // nothing else would. RedriveService calls enqueue() directly (it is already replaying a DLQ
          // row) so it never double-writes here. The DLQ save is itself best-effort: a failure must not
          // 500 the ingress request (the delivery is already dedup-persisted, so the provider won't re-send).
          enqueue: async (data, jobId) => {
            const result = await ingressEnqueue.enqueue(data, jobId);
            if (result.outcome === 'failed') {
              try {
                await failures.save(buildIngressDeadLetterRow(data, result.error));
              } catch (err) {
                dlqLogger.error(
                  'Failed to persist ingress dead-letter row after inline dispatch failure',
                  err instanceof Error ? err.message : String(err),
                  { pluginId: data.pluginId, instanceId: data.instanceId, deliveryId: data.deliveryId },
                );
              }
            }
            return result;
          },
          now: () => Date.now(),
        });
      },
    },
  ],
  exports: [PluginInstanceService, IngressEventService],
})
export class IntegrationModule {}
