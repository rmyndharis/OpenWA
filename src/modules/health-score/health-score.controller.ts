import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { HealthScoreService } from './health-score.service';
import { PredictiveHealthService } from './predictive-health.service';

@ApiTags('health-score')
@Controller('sessions/health')
export class HealthScoreController {
  constructor(
    private readonly healthScore: HealthScoreService,
    private readonly predictive: PredictiveHealthService,
  ) {}

  @Get('predictions')
  @ApiOperation({ summary: 'Get health predictions for all sessions' })
  async getPredictions() {
    return this.predictive.getSessionPredictions();
  }

  @Get(':sessionId/snapshots')
  @ApiOperation({ summary: 'Get health score history for a session' })
  @ApiParam({ name: 'sessionId' })
  async getSnapshots(@Param('sessionId') sessionId: string) {
    const [snapshots, prediction] = await Promise.all([
      this.healthScore.getSnapshots(sessionId),
      this.predictive.analyzeTrend(sessionId),
    ]);
    return { snapshots, prediction };
  }
}
