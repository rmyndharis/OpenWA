import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { WebhookResponseDto } from './dto';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksListController {
  constructor(private readonly webhookService: WebhookService) {}

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
