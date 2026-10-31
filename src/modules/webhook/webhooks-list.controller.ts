import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { WebhookRedriveResult, WebhookRedriveService } from './webhook-redrive.service';
import {
  WebhookResponseDto,
  WebhookDeliveryFailureDto,
  RedriveWebhookDeliveriesDto,
  WebhookRedriveResultDto,
} from './dto';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksListController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly redriveService: WebhookRedriveService,
    private readonly audit: AuditService,
  ) {}

  @Get('delivery-failures')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List failed or unsent webhook deliveries, most recent first' })
  @ApiResponse({
    status: 200,
    description:
      'Deliveries that exhausted their retries (attempts > 0) and deliveries not sent (attempts 0: shed, ' +
      'refused at shutdown, oversize or a preflight failure). A direct delivery that shutdown stops in a retry ' +
      'backoff also records attempts 0, although its earlier attempts were sent. The outbox replays shed ' +
      'deliveries and those stopped by shutdown; oversize and preflight-failed ones on a first dispatch are ' +
      'final. A later successful delivery removes the row. Most recent first.',
    type: [WebhookDeliveryFailureDto],
  })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Filter to a single session' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: 'Max records to return (1-1000, default 1000)',
  })
  @ApiQuery({ name: 'offset', required: false, type: 'integer', description: 'Number of records to skip (for paging)' })
  async deliveryFailures(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<Array<WebhookDeliveryFailure & { replayable: boolean }>> {
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

  // Replaying lost deliveries sends real events to receivers, so it is ADMIN-gated like the listing
  // and the integration redrive. The body's sessionId bypasses the guard's route-param fence, so the
  // service scopes every row to the calling key's allowedSessions itself.
  @Post('delivery-failures/redrive')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replay recorded webhook deliveries that still hold their event data' })
  @ApiResponse({
    status: 200,
    description:
      'One bounded batch of replayable failure rows (terminal rows recorded while ' +
      'WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0), least-retried first, then oldest. Each replay reuses the stored ' +
      'idempotency key, so a receiver that already handled the event can dedup it, and runs the ' +
      'webhook:before hooks again. Each row gets one direct POST attempt even when ordinary delivery ' +
      'uses the queue; enqueued stays zero. Rows outside the key allowedSessions are ' +
      'never touched.',
    type: WebhookRedriveResultDto,
  })
  async redriveDeliveryFailures(
    @Body() dto: RedriveWebhookDeliveriesDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<WebhookRedriveResult> {
    const result = await this.redriveService.redrive(dto, apiKey?.allowedSessions);
    // A redrive sends real events, so every batch is audited with its counts (no payload content).
    void this.audit.logInfo(AuditAction.WEBHOOK_DELIVERIES_REDRIVEN, {
      apiKey,
      sessionId: dto.sessionId,
      metadata: {
        webhookId: dto.webhookId,
        ids: dto.ids?.length,
        redriven: result.redriven,
        failed: result.failed,
        skipped: result.skipped,
        remaining: result.remaining,
      },
    });
    return result;
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List webhooks visible to the calling key (scoped to its allowed sessions)' })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks',
    type: [WebhookResponseDto],
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: 'Max webhooks to return (1-1000, default 1000)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: 'integer',
    description: 'Number of webhooks to skip (for paging)',
  })
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
