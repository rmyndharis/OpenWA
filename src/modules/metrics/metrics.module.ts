import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { StatsModule } from '../stats/stats.module';

@Module({
  imports: [ConfigModule, StatsModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
