import { Module, DynamicModule, Type } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThrottlerStorage } from '@nestjs/throttler';
import { PluginInstance } from './entities/plugin-instance.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { IngressEventService } from './ingress-event.service';
import { IngressService, IngressRouteDescriptor } from './ingress.service';
import { IngressController } from './ingress.controller';
import { admitIngressInstance } from './ingress-instance-limit';
import { IngressEnqueueService, buildIngressDeadLetterRow } from './ingress-enqueue.service';
import { IngressReconcilerService } from './ingress-reconciler.service';
import { RedriveService } from './redrive.service';
import { RedriveController } from './redrive.controller';
import { IntegrationRetentionService } from './integration-retention.service';
import { IntegrationInstanceController } from './integration-instance.controller';
import { ScopeBindingService } from './scope-binding.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PLUGIN_INSTANCE_PORT } from '../../core/plugins/plugin-host-ports';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session } from '../session/entities/session.entity';
import { createLogger } from '../../common/services/logger.service';

/**
 * Wires the @Public ingress HTTP surface: instance/event persistence services and the fast-ack
 * IngressService, whose deps are built by a factory so the pure pipeline stays DI-free and testable.
 * Queue-vs-inline enqueue is delegated to IngressEnqueueService (its own optional-queue injection),
 * shared with RedriveService so a DLQ replay goes through the exact same path a live delivery would.
 * PluginLoaderService is @Global (PluginsModule), so it injects without importing that module.
 * QueueModule must be imported here (not only at the app root): @nestjs/bullmq queue providers are
 * module-scoped, so IngressEnqueueService's @InjectQueue(QUEUE_NAMES.INGRESS) only resolves when this
 * module imports the module that registered the queue. IngressEnqueueService fails fast at boot if
 * QUEUE_ENABLED=true but the queue still did not resolve.
 */
// Only import QueueModule if explicitly enabled to avoid Redis connection errors
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('../queue/queue.module') as {
    QueueModule: Type;
  };
  queueModules.push(queueModule.QueueModule);
}

@Module({
  imports: [
    TypeOrmModule.forFeature([PluginInstance, IngressEvent, IntegrationDeliveryFailure, Session], 'data'),
    ...queueModules,
  ],
  controllers: [IngressController, RedriveController, IntegrationInstanceController],
  providers: [
    PluginInstanceService,
    IngressEventService,
    IngressEnqueueService,
    IngressReconcilerService,
    RedriveService,
    ScopeBindingService,
    IntegrationRetentionService,
    // Binds the core-owned plugin capability port to this module's service; resolved lazily by the
    // plugin runtime (PluginHostServices) so its provider cycle stays broken.
    // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
    { provide: PLUGIN_INSTANCE_PORT, useExisting: PluginInstanceService },
    {
      provide: IngressService,
      inject: [
        PluginInstanceService,
        IngressEventService,
        PluginLoaderService,
        IngressEnqueueService,
        getRepositoryToken(IntegrationDeliveryFailure, 'data'),
        EngineRegistry,
        ThrottlerStorage,
      ],
      useFactory: (
        instances: PluginInstanceService,
        events: IngressEventService,
        loader: PluginLoaderService,
        ingressEnqueue: IngressEnqueueService,
        failures: Repository<IntegrationDeliveryFailure>,
        registry: EngineRegistry,
        throttlerStorage: ThrottlerStorage,
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
          sessionStatus: (scope: string) => registry.get(scope)?.getStatus(),
          // Audit sink for preflight rejections (they leave no dedup/DLQ row). The Prometheus counter is
          // a separate follow-up (see plan notes); the structured log is the MVP audit surface.
          log: (event, meta) => ingressLogger.warn(event, meta),
          // The app's global throttler storage (Redis when enabled), so the bucket is shared across nodes.
          admitInstance: (pluginId, instanceId) => admitIngressInstance(throttlerStorage, pluginId, instanceId),
          // Live ingress delivery: record the dispatch outcome on the event row (so the reconciler
          // can tell a stranded 'pending' row from one that reached the dispatch tier) and, on a
          // swallowed inline-dispatch failure, persist a dead-letter row so RedriveService can replay
          // it — IngressService.handle() always 202s, so nothing else would. RedriveService calls
          // enqueue() directly (it is already replaying a DLQ row) so it never double-writes here.
          // Both writes are best-effort: a failure must not 500 the ingress request (the delivery is
          // already dedup-persisted, so the provider won't re-send; an unmarked row stays 'pending'
          // and the reconciler replays it — at-least-once, plugin handlers are idempotent by contract).
          enqueue: async (data, jobId) => {
            const result = await ingressEnqueue.enqueue(data, jobId);
            try {
              await events.markDispatchOutcome(
                { pluginId: data.pluginId, instanceId: data.instanceId, providerDeliveryId: data.deliveryId },
                result.outcome,
              );
            } catch (err) {
              dlqLogger.error(
                'Failed to mark ingress dispatch outcome',
                err instanceof Error ? err.message : String(err),
                { pluginId: data.pluginId, instanceId: data.instanceId, deliveryId: data.deliveryId },
              );
            }
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
