import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';

@ApiTags('Statistics')
@ApiSecurity('X-API-Key')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get overall statistics' })
  async getOverview() {
    return this.statsService.getOverview();
  }

  @Get('messages')
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
