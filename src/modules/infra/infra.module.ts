import { Module, DynamicModule, Type } from '@nestjs/common';
import { InfraStatusController } from './infra-status.controller';
import { InfraConfigController } from './infra-config.controller';
import { InfraDataController } from './infra-data.controller';
import { InfraDataService } from './infra-data.service';
import { InfraStorageController } from './infra-storage.controller';
import { EngineModule } from '../../engine/engine.module';
import { DockerModule } from '../docker';
import { SessionModule } from '../session/session.module';

// Only import QueueModule if explicitly enabled to avoid Redis connection errors. It registers and
// exports the webhook queue, which InfraStatusController injects (@Optional) to report live job counts.
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('../queue/queue.module') as { QueueModule: Type };
  queueModules.push(queueModule.QueueModule);
}

@Module({
  // SessionModule gives InfraDataService the live-engine registry for the import pre-flight
  // orphan check. Its own imports (WebhookModule, StatusStoreModule) never point back here — no cycle.
  imports: [EngineModule, DockerModule, SessionModule, ...queueModules],
  // InfraNodeController is deliberately NOT here — it lives in InfraNodeModule so the drain verb
  // survives on ROLE=worker, where this module (the control-plane operator surface) is absent.
  controllers: [InfraStatusController, InfraConfigController, InfraDataController, InfraStorageController],
  providers: [InfraDataService],
})
export class InfraModule {}
