import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('Statistics')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  // Global, cross-session aggregates with no scope param — ADMIN-only so a VIEWER / session-
  // restricted key can't read cross-tenant activity. (Per-session stats below stays scope-gated.)
  @Get('overview')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get overall statistics' })
  async getOverview() {
    return this.statsService.getOverview();
  }

  @Get('messages')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get message statistics with time series' })
  async getMessageStats(@Query() query: StatsQueryDto) {
    return this.statsService.getMessageStats(query.period || '24h');
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get statistics for a specific session' })
  async getSessionStats(@Param('sessionId') sessionId: string) {
    return this.statsService.getSessionStats(sessionId);
  }
}
