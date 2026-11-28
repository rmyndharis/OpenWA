import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MessageStatsResponseDto, OverviewStatsResponseDto, SessionStatsResponseDto } from './dto/stats-response.dto';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';
import { Capability, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyCapability } from '../auth/api-key-permissions';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('statistics')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  // Global, cross-session aggregates with no scope param. The ADMIN role gate alone does not keep a
  // session-restricted key out — role and session scope are independent — so these also require an
  // unrestricted key. (Per-session stats below stays scope-gated by its :sessionId route param.)
  @Capability(ApiKeyCapability.STATS_READ)
  @Get('overview')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Get overall statistics' })
  @ApiResponse({
    status: 200,
    description: 'Cross-session aggregate statistics (sessions, messages, etc.).',
    type: OverviewStatsResponseDto,
  })
  async getOverview() {
    return this.statsService.getOverview();
  }

  @Capability(ApiKeyCapability.STATS_READ)
  @Get('messages')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Get message statistics with time series' })
  @ApiResponse({
    status: 200,
    description: 'Message statistics with a time series for the requested period.',
    type: MessageStatsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'A query value is invalid, or the query carries a field the DTO does not declare.',
  })
  async getMessageStats(@Query() query: StatsQueryDto) {
    return this.statsService.getMessageStats(query.period || '24h');
  }

  @Capability(ApiKeyCapability.STATS_READ)
  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get statistics for a specific session' })
  @ApiResponse({
    status: 200,
    description: 'Per-session statistics for the requested session.',
    type: SessionStatsResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getSessionStats(@Param('sessionId') sessionId: string) {
    return this.statsService.getSessionStats(sessionId);
  }
}
