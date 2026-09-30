import { DynamicModule, MiddlewareConsumer, Module, NestModule, Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { StatsModule } from '../stats/stats.module';
import { RequestMetricsInterceptor } from '../../common/interceptors/request-metrics.interceptor';
import { requestMetricsBoundaryMiddleware } from '../../common/middleware/request-metrics.middleware';

// QueueModule registers the webhook and ingress queues MetricsService reports (@Optional). Imported
// only when enabled, like infra.module.ts, so a disabled queue never dials Redis.
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('../queue/queue.module') as { QueueModule: Type };
  queueModules.push(queueModule.QueueModule);
}

@Module({
  imports: [ConfigModule, StatsModule, ...queueModules],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    // Global: one HTTP RED observation per inbound request, skipped for /api/health and /api/metrics.
    { provide: APP_INTERCEPTOR, useClass: RequestMetricsInterceptor },
  ],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Middleware runs BEFORE the global guards, so this boundary sees the requests the guards
    // reject (throttler 429, API-key 401/403) that never reach the interceptor. The pair
    // coordinates through a per-request claim so each response is counted exactly once.
    // '*' resolves against the global prefix, i.e. every /api route.
    consumer.apply(requestMetricsBoundaryMiddleware).forRoutes('*');
  }
}
