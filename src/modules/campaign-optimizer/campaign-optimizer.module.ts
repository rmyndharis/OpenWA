import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from './entities/campaign.entity';
import { CampaignOptimization } from './entities/campaign-optimization.entity';
import { CampaignOptimizerService } from './campaign-optimizer.service';
import { CampaignOptimizerController } from './campaign-optimizer.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Campaign, CampaignOptimization], 'data')],
  controllers: [CampaignOptimizerController],
  providers: [CampaignOptimizerService],
  exports: [CampaignOptimizerService],
})
export class CampaignOptimizerModule {}
