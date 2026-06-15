import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { WebhookResponseDto } from './dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksListController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all webhooks across all sessions' })
  @ApiResponse({
    status: 200,
    description: 'List of all webhooks',
    type: [WebhookResponseDto],
  })
  async findAll(): Promise<WebhookResponseDto[]> {
    return WebhookResponseDto.fromEntities(await this.webhookService.findAll());
  }
}
