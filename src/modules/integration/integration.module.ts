import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { IngressEventService } from './ingress-event.service';
import { IngressService, IngressRouteDescriptor } from './ingress.service';
import { IngressController } from './ingress.controller';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { RedriveService } from './redrive.service';
import { RedriveController } from './redrive.controller';
import { IntegrationInstanceController } from './integration-instance.controller';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';

/**
 * Wires the @Public ingress HTTP surface: instance/event persistence services and the fast-ack
 * IngressService, whose deps are built by a factory so the pure pipeline stays DI-free and testable.
 * Queue-vs-inline enqueue is delegated to IngressEnqueueService (its own optional-queue injection),
 * shared with RedriveService so a DLQ replay goes through the exact same path a live delivery would.
 * PluginLoaderService is @Global (PluginsModule), so it injects without importing that module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PluginInstance, IngressEvent, IntegrationDeliveryFailure], 'data')],
  controllers: [IngressController, RedriveController, IntegrationInstanceController],
  providers: [
    PluginInstanceService,
    IngressEventService,
    IngressEnqueueService,
    RedriveService,
    {
      provide: IngressService,
      inject: [PluginInstanceService, IngressEventService, PluginLoaderService, IngressEnqueueService],
      useFactory: (
        instances: PluginInstanceService,
        events: IngressEventService,
        loader: PluginLoaderService,
        ingressEnqueue: IngressEnqueueService,
      ) => {
        return new IngressService({
          instances: { resolve: (pluginId, instanceId) => instances.resolve(pluginId, instanceId) },
          manifestRoute: (pluginId, route): IngressRouteDescriptor | undefined =>
            loader.getPlugin(pluginId)?.manifest.ingress?.find(r => r.route === route),
          events: { recordOrSkip: input => events.recordOrSkip(input) },
          enqueue: (data, jobId) => ingressEnqueue.enqueue(data, jobId),
          now: () => Date.now(),
        });
      },
    },
  ],
  exports: [PluginInstanceService, IngressEventService],
})
export class IntegrationModule {}
