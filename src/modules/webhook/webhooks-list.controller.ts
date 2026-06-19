import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
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
  async findAll(@CurrentApiKey() apiKey?: ApiKey): Promise<WebhookResponseDto[]> {
    // Scope to the key's allowedSessions so a session-restricted key cannot enumerate every
    // session's webhook URLs. A null/empty allowlist (e.g. ADMIN) still sees all.
    return WebhookResponseDto.fromEntities(await this.webhookService.findAll(apiKey?.allowedSessions));
  }
}
