import { Controller, Get, Post, Put, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto, UpdateWebhookDto, WebhookResponseDto } from './dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('webhooks')
@Controller('sessions/:sessionId/webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a webhook for the session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Webhook created',
    type: WebhookResponseDto,
  })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateWebhookDto): Promise<WebhookResponseDto> {
    return WebhookResponseDto.fromEntity(await this.webhookService.create(sessionId, dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all webhooks for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks',
    type: [WebhookResponseDto],
  })
  async findBySession(@Param('sessionId') sessionId: string): Promise<WebhookResponseDto[]> {
    return WebhookResponseDto.fromEntities(await this.webhookService.findBySession(sessionId));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get a webhook by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({
    status: 200,
    description: 'Webhook details',
    type: WebhookResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async findOne(@Param('id') id: string): Promise<WebhookResponseDto> {
    return WebhookResponseDto.fromEntity(await this.webhookService.findOne(id));
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a webhook' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({
    status: 200,
    description: 'Webhook updated',
    type: WebhookResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateWebhookDto): Promise<WebhookResponseDto> {
    return WebhookResponseDto.fromEntity(await this.webhookService.update(id, dto));
  }

  @Post(':id/test')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Test a webhook by sending a test payload' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'Test result' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async test(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    return this.webhookService.test(sessionId, id);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a webhook' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.webhookService.delete(id);
  }
}
