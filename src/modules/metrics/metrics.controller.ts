import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { MetricsService } from './metrics.service';
import { METRICS_BEARER_SCHEME } from '../../config/swagger.config';

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
  @ApiOperation({ summary: 'Prometheus metrics (requires METRICS_TOKEN bearer)' })
  @ApiSecurity(METRICS_BEARER_SCHEME)
  @ApiResponse({
    status: 200,
    description: 'Prometheus exposition text',
    content: { 'text/plain': { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 401, description: 'METRICS_TOKEN is configured but the bearer is missing or wrong' })
  @ApiResponse({ status: 404, description: 'Metrics endpoint is disabled (METRICS_TOKEN unset)' })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  // @Req (not @Headers('authorization')) so the OpenAPI op doesn't sprout a spurious required
  // `authorization` header parameter — the bearer is expressed via the security scheme above.
  async scrape(@Req() req: Request): Promise<string> {
    this.metricsService.assertScrapeAuthorized(req.headers.authorization);
    return this.metricsService.render();
  }
}
