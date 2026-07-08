import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('statistics')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  // Global, cross-session aggregates with no scope param — ADMIN-only so a VIEWER / session-
  // restricted key can't read cross-tenant activity. (Per-session stats below stays scope-gated.)
  @Get('overview')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get overall statistics' })
  @ApiResponse({ status: 200, description: 'Cross-session aggregate statistics (sessions, messages, etc.).' })
  async getOverview() {
    return this.statsService.getOverview();
  }

  @Get('messages')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get message statistics with time series' })
  @ApiResponse({ status: 200, description: 'Message statistics with a time series for the requested period.' })
  async getMessageStats(@Query() query: StatsQueryDto) {
    return this.statsService.getMessageStats(query.period || '24h');
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get statistics for a specific session' })
  @ApiResponse({ status: 200, description: 'Per-session statistics for the requested session.' })
  async getSessionStats(@Param('sessionId') sessionId: string) {
    return this.statsService.getSessionStats(sessionId);
  }
}
