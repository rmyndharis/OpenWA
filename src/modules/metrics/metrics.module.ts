import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { StatsModule } from '../stats/stats.module';
import { RequestMetricsInterceptor } from '../../common/interceptors/request-metrics.interceptor';

@Module({
  imports: [ConfigModule, StatsModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    // Global: one HTTP RED observation per inbound request, skipped for /api/health and /api/metrics.
    { provide: APP_INTERCEPTOR, useClass: RequestMetricsInterceptor },
  ],
})
export class MetricsModule {}
