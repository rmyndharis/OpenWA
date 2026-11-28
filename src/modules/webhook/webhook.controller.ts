import { isDeepStrictEqual } from 'node:util';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto, UpdateWebhookDto, WebhookResponseDto, WebhookTestResponseDto, WEBHOOK_EVENTS } from './dto';
import { Capability, CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyCapability, eventCapabilities, isCapabilityDenied } from '../auth/api-key-permissions';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { Webhook } from './entities/webhook.entity';

/** The fields an update can change, in the order an audit row names them. */
const UPDATABLE_FIELDS = ['url', 'events', 'secret', 'headers', 'filters', 'active', 'retryCount'] as const;

/** Host of a webhook URL, without a user name, path or query: a receiver token can sit in any of them. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * What an audit row says about a webhook: its id, the URL host, the events and whether it is active. Never the secret,
 * headers or filters.
 */
function describeWebhook(webhook: Webhook): Record<string, unknown> {
  return { webhookId: webhook.id, urlHost: urlHost(webhook.url), events: webhook.events, active: webhook.active };
}

@ApiTags('webhooks')
@Controller('sessions/:sessionId/webhooks')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly audit: AuditService,
  ) {}

  /** A webhook is a standing event subscription, so its events inherit the same capability fence as /events. */
  private assertEventsAllowed(apiKey: ApiKey | undefined, events: readonly string[]): void {
    if (!apiKey) return;
    const expanded = events.includes('*') ? WEBHOOK_EVENTS : events;
    for (const event of expanded) {
      const blocked = eventCapabilities(event).find(capability => isCapabilityDenied(apiKey, capability));
      if (blocked) {
        throw new ForbiddenException(`API key is blocked from webhook event ${event} (${blocked})`);
      }
    }
  }

  /**
   * One audit row per successful webhook change: a webhook streams every event of its session to a URL the operator
   * chose, so which key added, re-pointed or removed one is where an investigation of a leak starts. A failed write
   * never fails the change.
   */
  private record(
    action: AuditAction,
    sessionId: string,
    apiKey: ApiKey | undefined,
    metadata: Record<string, unknown>,
  ): void {
    void this.audit.logInfo(action, { apiKey, sessionId, metadata });
  }

  @Capability(ApiKeyCapability.WEBHOOKS_WRITE, ApiKeyCapability.MESSAGES_READ)
  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a webhook for the session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Webhook created',
    type: WebhookResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid body, the URL embeds credentials or is blocked by the SSRF policy, or the per-session webhook limit is reached',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateWebhookDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<WebhookResponseDto> {
    this.assertEventsAllowed(apiKey, dto.events ?? ['message.received']);
    const webhook = await this.webhookService.create(sessionId, dto);
    this.record(AuditAction.WEBHOOK_CREATED, sessionId, apiKey, describeWebhook(webhook));
    return WebhookResponseDto.fromEntity(webhook);
  }

  @Capability(ApiKeyCapability.WEBHOOKS_READ)
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

  @Capability(ApiKeyCapability.WEBHOOKS_READ)
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
  async findOne(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<WebhookResponseDto> {
    return WebhookResponseDto.fromEntity(await this.webhookService.findOne(sessionId, id));
  }

  @Capability(ApiKeyCapability.WEBHOOKS_WRITE, ApiKeyCapability.MESSAGES_READ)
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
  @ApiResponse({
    status: 400,
    description: 'Invalid body, or a changed URL embeds credentials or is blocked by the SSRF policy',
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<WebhookResponseDto> {
    // Read first: a client re-sends every field on each edit and the service skips an unchanged URL, so only a field
    // that differs afterwards is a change.
    const before = await this.webhookService.findOne(sessionId, id);
    this.assertEventsAllowed(apiKey, dto.events ?? before.events);
    const after = await this.webhookService.update(sessionId, id, dto);
    const changed = UPDATABLE_FIELDS.filter(field => !isDeepStrictEqual(before[field], after[field]));
    if (changed.length > 0) {
      this.record(AuditAction.WEBHOOK_UPDATED, sessionId, apiKey, {
        ...describeWebhook(after),
        changed,
        ...(changed.includes('url') ? { previousUrlHost: urlHost(before.url) } : {}),
      });
    }
    return WebhookResponseDto.fromEntity(after);
  }

  @Capability(ApiKeyCapability.WEBHOOKS_WRITE)
  @Post(':id/test')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test a webhook by sending a test payload' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'Test result', type: WebhookTestResponseDto })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async test(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    return this.webhookService.test(sessionId, id);
  }

  @Capability(ApiKeyCapability.WEBHOOKS_WRITE)
  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a webhook' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async delete(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<void> {
    // Read first: the row is gone afterwards, and its host and events are what the audit row keeps.
    const webhook = await this.webhookService.findOne(sessionId, id);
    await this.webhookService.delete(sessionId, id);
    this.record(AuditAction.WEBHOOK_DELETED, sessionId, apiKey, describeWebhook(webhook));
  }
}
