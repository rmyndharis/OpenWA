import { Injectable, NotFoundException, Optional, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { Webhook } from './entities/webhook.entity';
import { CreateWebhookDto, UpdateWebhookDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue/queue-names';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import {
  assertSafeFetchUrl,
  assertNoRedirect,
  isSsrfProtectionEnabled,
  SsrfBlockedError,
} from '../../common/security/ssrf-guard';
import { HookManager } from '../../core/hooks';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export interface WebhookJobData {
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  signature: string;
  headers: Record<string, string>;
  attempt: number;
  maxRetries: number;
}

@Injectable()
export class WebhookService {
  private readonly logger = createLogger('WebhookService');
  private readonly queueEnabled: boolean;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue<WebhookJobData>,
  ) {
    this.queueEnabled = configService.get<boolean>('queue.enabled', false);
  }

  /**
   * Reject an internal/unsafe webhook URL at registration, so a bad URL fails
   * synchronously with a 400 instead of silently failing at delivery time. Honors the same
   * SSRF flag + SSRF_ALLOWED_HOSTS escape-hatch as delivery. Maps the guard error to 400.
   */
  private async validateWebhookUrl(url: string): Promise<void> {
    if (!isSsrfProtectionEnabled()) return;
    try {
      await assertSafeFetchUrl(url);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async create(sessionId: string, dto: CreateWebhookDto): Promise<Webhook> {
    await this.validateWebhookUrl(dto.url);
    const webhook = this.webhookRepository.create({
      sessionId,
      url: dto.url,
      events: dto.events || ['message.received'],
      secret: dto.secret || null,
      headers: dto.headers || {},
      retryCount: dto.retryCount ?? 3,
    });

    return this.webhookRepository.save(webhook);
  }

  async findBySession(sessionId: string): Promise<Webhook[]> {
    return this.webhookRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(): Promise<Webhook[]> {
    return this.webhookRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Webhook> {
    const webhook = await this.webhookRepository.findOne({ where: { id } });
    if (!webhook) {
      throw new NotFoundException(`Webhook with id '${id}' not found`);
    }
    return webhook;
  }

  async update(id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    const webhook = await this.findOne(id);

    if (dto.url !== undefined) {
      await this.validateWebhookUrl(dto.url);
      webhook.url = dto.url;
    }
    if (dto.events !== undefined) webhook.events = dto.events;
    // Normalize empty string to null (parity with create) — an empty secret means "no HMAC",
    // not a stored blank that silently disables signing while looking configured.
    if (dto.secret !== undefined) webhook.secret = dto.secret || null;
    if (dto.headers !== undefined) webhook.headers = dto.headers;
    if (dto.active !== undefined) webhook.active = dto.active;
    if (dto.retryCount !== undefined) webhook.retryCount = dto.retryCount;

    return this.webhookRepository.save(webhook);
  }

  async delete(id: string): Promise<void> {
    const webhook = await this.findOne(id);
    await this.webhookRepository.remove(webhook);
  }

  async test(sessionId: string, webhookId: string): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const webhook = await this.findOne(webhookId);

    const testPayload: WebhookPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      sessionId,
      idempotencyKey: generateIdempotencyKey('test', { webhookId: webhook.id }),
      deliveryId: generateDeliveryId(),
      data: {
        message: 'This is a test webhook from OpenWA',
        webhookId: webhook.id,
        url: webhook.url,
      },
    };

    const body = JSON.stringify(testPayload);
    const headers: Record<string, string> = {
      // Custom headers FIRST so the system headers below always win.
      ...this.sanitizeCustomHeaders(webhook.headers),
      'Content-Type': 'application/json',
      'User-Agent': 'OpenWA-Webhook/1.0.0',
      'X-OpenWA-Event': 'test',
      'X-OpenWA-Idempotency-Key': testPayload.idempotencyKey,
      'X-OpenWA-Delivery-Id': testPayload.deliveryId,
      'X-OpenWA-Retry-Count': '0',
    };

    if (webhook.secret) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
    }

    const ssrfProtected = isSsrfProtectionEnabled();
    try {
      if (ssrfProtected) {
        await assertSafeFetchUrl(webhook.url);
      }
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
        redirect: ssrfProtected ? 'manual' : 'follow',
      });
      if (ssrfProtected) {
        assertNoRedirect(response, webhook.url);
      }

      return {
        success: response.ok,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    const webhooks = await this.webhookRepository.find({
      where: { sessionId, active: true },
    });

    const matchingWebhooks = webhooks.filter(w => w.events.includes(event) || w.events.includes('*'));

    // Generate idempotency key (same for all webhooks receiving this event)
    const idempotencyKey = generateIdempotencyKey(event, { ...data, sessionId });

    // Dispatch to all matching webhooks
    for (const webhook of matchingWebhooks) {
      // Generate unique delivery ID for each webhook
      const deliveryId = generateDeliveryId();

      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        sessionId,
        idempotencyKey,
        deliveryId,
        data,
      };

      // Execute hook before webhook dispatch - plugins can modify payload
      const { continue: shouldContinue, data: hookResult } = await this.hookManager.execute(
        'webhook:before',
        { sessionId, event, payload },
        { sessionId, source: 'WebhookService' },
      );

      if (!shouldContinue) {
        this.logger.debug(`Webhook dispatch cancelled by plugin for ${event}`, {
          webhookId: webhook.id,
          action: 'webhook_cancelled_by_plugin',
        });
        continue;
      }

      // Use potentially modified payload
      const finalPayload = (hookResult as { payload: WebhookPayload }).payload;

      // Build headers — custom headers FIRST so the system headers below always win.
      const headers: Record<string, string> = {
        ...this.sanitizeCustomHeaders(webhook.headers),
        'Content-Type': 'application/json',
        'User-Agent': 'OpenWA-Webhook/1.0.0',
        'X-OpenWA-Event': event,
        'X-OpenWA-Idempotency-Key': idempotencyKey,
        'X-OpenWA-Delivery-Id': deliveryId,
        'X-OpenWA-Retry-Count': '0',
      };

      // Use queue if available, otherwise fallback to direct delivery
      if (this.queueEnabled && this.webhookQueue) {
        const signature = webhook.secret ? this.generateSignature(JSON.stringify(finalPayload), webhook.secret) : '';

        if (webhook.secret) {
          headers['X-OpenWA-Signature'] = signature;
        }

        const jobData: WebhookJobData = {
          webhookId: webhook.id,
          url: webhook.url,
          event,
          payload: finalPayload,
          signature,
          headers,
          attempt: 1,
          maxRetries: webhook.retryCount,
        };

        try {
          await this.webhookQueue.add(`webhook-${webhook.id}`, jobData, {
            attempts: webhook.retryCount,
            backoff: {
              type: 'exponential',
              delay: this.configService.get<number>('webhook.retryDelay', 5000),
            },
          });

          // Execute hook after successful queue (NOT delivery - that happens in processor)
          await this.hookManager.execute(
            'webhook:queued',
            { sessionId, event, webhookId: webhook.id, deliveryId },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.debug(`Webhook job queued for ${webhook.id}`, {
            webhookId: webhook.id,
            event,
            idempotencyKey,
            deliveryId,
            action: 'webhook_queued',
          });
        } catch (error) {
          // Execute hook on queue error (not delivery error - that happens in processor)
          await this.hookManager.execute(
            'webhook:error',
            { sessionId, event, webhookId: webhook.id, error: `Queue failed: ${String(error)}` },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.error(`Failed to queue webhook ${webhook.id}`, String(error), {
            webhookId: webhook.id,
            action: 'webhook_queue_failed',
          });
        }
      } else {
        // Direct delivery when queue is disabled
        try {
          await this.deliverWebhook(webhook, finalPayload, headers);

          // Execute hook after successful delivery
          await this.hookManager.execute(
            'webhook:delivered',
            { sessionId, event, webhookId: webhook.id, deliveryId },
            { sessionId, source: 'WebhookService' },
          );

          // Legacy hook for backward compatibility
          await this.hookManager.execute(
            'webhook:after',
            { sessionId, event, webhookId: webhook.id, success: true },
            { sessionId, source: 'WebhookService' },
          );
        } catch (error) {
          // Execute hook on error
          await this.hookManager.execute(
            'webhook:error',
            { sessionId, event, webhookId: webhook.id, error: String(error) },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
            webhookId: webhook.id,
            action: 'webhook_delivery_failed',
          });
        }
      }
    }
  }

  /**
   * @deprecated Use job queue dispatch instead. This is kept for fallback.
   */
  private async deliverWebhook(
    webhook: Webhook,
    payload: WebhookPayload,
    headers: Record<string, string>,
    attempt = 1,
  ): Promise<void> {
    const body = JSON.stringify(payload);

    // Update retry count header
    headers['X-OpenWA-Retry-Count'] = String(attempt - 1);

    // Add signature if secret is configured and not already present
    if (webhook.secret && !headers['X-OpenWA-Signature']) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
    }

    const ssrfProtected = isSsrfProtectionEnabled();
    try {
      if (ssrfProtected) {
        await assertSafeFetchUrl(webhook.url);
      }
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
        redirect: ssrfProtected ? 'manual' : 'follow',
      });
      if (ssrfProtected) {
        assertNoRedirect(response, webhook.url);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Update last triggered timestamp
      await this.webhookRepository.update(webhook.id, {
        lastTriggeredAt: new Date(),
      });

      this.logger.debug(`Webhook delivered to ${webhook.id}`, {
        webhookId: webhook.id,
        deliveryId: payload.deliveryId,
        action: 'webhook_delivered',
      });
    } catch (error) {
      this.logger.error(`Webhook delivery failed for ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        attempt,
        deliveryId: payload.deliveryId,
        action: 'webhook_delivery_failed',
      });

      if (attempt < webhook.retryCount) {
        const delay = this.configService.get<number>('webhook.retryDelay', 5000);
        await this.delay(delay * attempt);
        return this.deliverWebhook(webhook, payload, headers, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Drop operator-supplied custom headers that target reserved names (Content-Type or any
   * X-OpenWA-* header) so a webhook config cannot forge the signature/event/idempotency
   * headers. Spread the result BEFORE the system headers so system always wins.
   */
  private sanitizeCustomHeaders(custom: Record<string, string> | null | undefined): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(custom ?? {})) {
      if (!/^(content-type|x-openwa-)/i.test(key)) {
        safe[key] = value;
      }
    }
    return safe;
  }

  private generateSignature(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
