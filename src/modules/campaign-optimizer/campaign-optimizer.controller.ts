import { Controller, Get, Post, Put, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { CampaignOptimizerService } from './campaign-optimizer.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { Campaign } from './entities/campaign.entity';

@ApiTags('Campaign Optimizer')
@Controller('sessions/:sessionId')
export class CampaignOptimizerController {
  constructor(private readonly svc: CampaignOptimizerService) {}

  @Get('campaigns')
  @ApiOperation({ summary: 'List campaigns for a session' })
  @ApiParam({ name: 'sessionId' })
  async listCampaigns(@Param('sessionId') sessionId: string) {
    const campaigns = await this.svc.listCampaigns(sessionId);
    return campaigns.map(c => ({ ...c, performanceScore: this.svc.performanceScore(c) }));
  }

  @Post('campaigns')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a new campaign' })
  createCampaign(@Param('sessionId') sessionId: string, @Body() body: { name: string }) {
    return this.svc.createCampaign(sessionId, body.name);
  }

  @Put('campaigns/:cId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update campaign stats' })
  updateStats(
    @Param('sessionId') sessionId: string,
    @Param('cId') cId: string,
    @Body() stats: Partial<Campaign>,
  ) {
    return this.svc.updateCampaignStats(cId, sessionId, stats);
  }

  @Get('campaigns/:cId/optimizations')
  @ApiOperation({ summary: 'Get latest AI optimization for a campaign' })
  async getOptimization(@Param('cId') cId: string) {
    const opt = await this.svc.getLatestOptimization(cId);
    if (!opt) return null;
    return {
      ...opt,
      insights: JSON.parse(opt.insights),
      recommendations: JSON.parse(opt.recommendations),
      abtestSuggestion: opt.abtestSuggestion ? JSON.parse(opt.abtestSuggestion) : null,
    };
  }

  @Post('campaigns/:cId/optimize')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Trigger AI analysis for a campaign' })
  async optimize(@Param('cId') cId: string) {
    const opt = await this.svc.analyzeAndOptimize(cId);
    return {
      ...opt,
      insights: JSON.parse(opt.insights),
      recommendations: JSON.parse(opt.recommendations),
      abtestSuggestion: opt.abtestSuggestion ? JSON.parse(opt.abtestSuggestion) : null,
    };
  }

  @Post('campaigns/:cId/apply-suggestion/:index')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Retrieve recommendation #i (pre-filled for editor)' })
  applySuggestion(@Param('cId') cId: string, @Param('index') index: string) {
    return this.svc.applyRecommendation(cId, parseInt(index, 10));
  }
}
