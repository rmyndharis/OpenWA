import { Controller, Get, Header, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/auth.decorators';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint. `@Public()` bypasses the API-key guard and
 * `@SkipThrottle()` keeps a scrape interval from eating the rate-limit budget; access is
 * instead gated by METRICS_TOKEN inside the service (disabled-by-default).
 */
@ApiTags('metrics')
@Controller('metrics')
@Public()
@SkipThrottle()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Prometheus metrics (requires METRICS_TOKEN bearer)' })
  @ApiResponse({ status: 200, description: 'Prometheus exposition text' })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    this.metricsService.assertScrapeAuthorized(authorization);
    return this.metricsService.render();
  }
}
