import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SessionModule } from '../session/session.module';

@Module({
  // SessionModule provides SessionOwnershipService for the /health/sessions capacity route
  // (EngineRegistry arrives via the global EngineModule). SessionModule never imports back — no cycle.
  imports: [SessionModule],
  controllers: [HealthController],
})
export class HealthModule {}
