import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { WebhookResponseDto } from './dto';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksListController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get('delivery-failures')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List recently-failed webhook deliveries (all retries exhausted)' })
  @ApiResponse({ status: 200, description: 'Permanently-failed webhook deliveries, most recent first' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Filter to a single session' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max records to return (1-1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of records to skip (for paging)' })
  async deliveryFailures(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<WebhookDeliveryFailure[]> {
    // Scope to the calling key's allowedSessions so a session-restricted ADMIN key cannot read another
    // session's failed-delivery URLs/errors via the `sessionId` query param (which bypasses the guard).
    return this.webhookService.listDeliveryFailures(
      {
        sessionId,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      },
      apiKey?.allowedSessions,
    );
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List webhooks visible to the calling key (scoped to its allowed sessions)' })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks',
    type: [WebhookResponseDto],
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max webhooks to return (1-1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of webhooks to skip (for paging)' })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<WebhookResponseDto[]> {
    // Scope to the key's allowedSessions so a session-restricted key cannot enumerate every
    // session's webhook URLs. A null/empty allowlist (e.g. ADMIN) still sees all.
    return WebhookResponseDto.fromEntities(
      await this.webhookService.findAll(apiKey?.allowedSessions, {
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      }),
    );
  }
}
