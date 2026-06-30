import { Module, DynamicModule, Type } from '@nestjs/common';
import { InfraController } from './infra.controller';
import { EngineModule } from '../../engine/engine.module';
import { DockerModule } from '../docker';

// Only import QueueModule if explicitly enabled to avoid Redis connection errors. It registers and
// exports the webhook queue, which the controller injects (@Optional) to report live job counts.
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('../queue/queue.module') as { QueueModule: Type };
  queueModules.push(queueModule.QueueModule);
}

@Module({
  imports: [EngineModule, DockerModule, ...queueModules],
  controllers: [InfraController],
})
export class InfraModule {}
