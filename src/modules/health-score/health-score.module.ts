import { Module } from '@nestjs/common';
import { HealthScoreService } from './health-score.service';
import { PredictiveHealthService } from './predictive-health.service';
import { HealthScoreController } from './health-score.controller';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  controllers: [HealthScoreController],
  providers: [HealthScoreService, PredictiveHealthService],
  exports: [HealthScoreService, PredictiveHealthService],
})
export class HealthScoreModule {}
