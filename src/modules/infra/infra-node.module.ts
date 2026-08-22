import { Module } from '@nestjs/common';
import { InfraNodeController } from './infra-node.controller';
import { SessionModule } from '../session/session.module';

/**
 * Node-level lifecycle verbs (POST /infra/drain), split out of InfraModule so EVERY role carries
 * them: InfraModule is the control-plane operator surface and is absent on ROLE=worker, but a
 * worker is exactly the process a drain targets before scale-down.
 */
@Module({
  imports: [SessionModule],
  controllers: [InfraNodeController],
})
export class InfraNodeModule {}
