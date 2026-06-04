import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { SessionEvents } from '../session/session.events';
import type { SessionMessageEvent, SessionAckEvent } from '../session/session.events';
import { Webhook } from './entities/webhook.entity';
import { CreateWebhookDto, UpdateWebhookDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue/queue-names';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
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

interface WebhookHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
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

  async create(sessionId: string, dto: CreateWebhookDto): Promise<Webhook> {
    const normalizedUrl = this.normalizeWebhookUrl(dto.url);
    const webhook = this.webhookRepository.create({
      sessionId,
      url: normalizedUrl,
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

    if (dto.url !== undefined) webhook.url = this.normalizeWebhookUrl(dto.url);
    if (dto.events !== undefined) webhook.events = dto.events;
    if (dto.secret !== undefined) webhook.secret = dto.secret;
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
    const url = this.normalizeWebhookUrl(webhook.url);
    const maxAttempts = Math.max(1, Math.min(webhook.retryCount || 1, 5));
    const timeoutMs = this.configService.get<number>('webhook.timeout', 10000);
    const baseDelayMs = Math.max(250, Math.min(this.configService.get<number>('webhook.retryDelay', 5000), 5000));

    const testPayload: WebhookPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      sessionId,
      idempotencyKey: generateIdempotencyKey('test', { webhookId: webhook.id }),
      deliveryId: generateDeliveryId(),
      data: {
        message: 'This is a test webhook from OpenWA',
        webhookId: webhook.id,
        url,
      },
    };

    const body = JSON.stringify(testPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'OpenWA-Webhook/1.0.0',
      'X-OpenWA-Event': 'test',
      'X-OpenWA-Idempotency-Key': testPayload.idempotencyKey,
      'X-OpenWA-Delivery-Id': testPayload.deliveryId,
      'X-OpenWA-Retry-Count': '0',
      ...webhook.headers,
    };

    if (webhook.secret) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.sendWebhookRequest(url, body, headers, timeoutMs);
        if (result.ok) {
          return {
            success: true,
            statusCode: result.status,
          };
        }

        const errorMessage = this.formatHttpError(
          result.status,
          result.statusText,
          result.body,
          url,
          attempt,
          maxAttempts,
        );

        if (attempt < maxAttempts && this.isRetryableStatus(result.status)) {
          await this.delay(baseDelayMs * attempt);
          continue;
        }

        return {
          success: false,
          statusCode: result.status,
          error: errorMessage,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          await this.delay(baseDelayMs * attempt);
          continue;
        }
        return {
          success: false,
          error: `Request to ${url} failed: ${message}`,
        };
      }
    }

    return {
      success: false,
      error: `Request to ${url} failed after ${maxAttempts} attempts`,
    };
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    // Cap the number of webhooks fetched per dispatch. Each inbound/outbound
    // message triggers this; an unbounded find() means O(N) work per message
    // and a misconfigured session with thousands of webhooks can stall the loop.
    const maxPerDispatch = Math.max(1, this.configService.get<number>('webhook.maxPerDispatch', 100));

    const webhooks = await this.webhookRepository.find({
      where: { sessionId, active: true },
      order: { createdAt: 'ASC' },
      take: maxPerDispatch,
    });

    if (webhooks.length === maxPerDispatch) {
      this.logger.warn(`Webhook dispatch capped at ${maxPerDispatch} for session ${sessionId}`, {
        sessionId,
        event,
        cap: maxPerDispatch,
        action: 'webhook_dispatch_capped',
      });
    }

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

      // Build headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenWA-Webhook/1.0.0',
        'X-OpenWA-Event': event,
        'X-OpenWA-Idempotency-Key': idempotencyKey,
        'X-OpenWA-Delivery-Id': deliveryId,
        'X-OpenWA-Retry-Count': '0',
        ...webhook.headers,
      };

      // Use queue if available, otherwise fallback to direct delivery
      if (this.queueEnabled && this.webhookQueue) {
        const signature = webhook.secret ? this.generateSignature(JSON.stringify(finalPayload), webhook.secret) : '';

        if (webhook.secret) {
          headers['X-OpenWA-Signature'] = signature;
        }

        const jobData: WebhookJobData = {
          webhookId: webhook.id,
          url: this.normalizeWebhookUrl(webhook.url),
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

  // ========== Session event-bus listeners ==========
  // Subscribe to SessionService domain events rather than being called directly.
  // dispatch() handles per-webhook errors internally; this guard catches a
  // failure before the per-webhook loop (e.g. the repository lookup) so the
  // listener never leaks an unhandled rejection.

  @OnEvent(SessionEvents.MESSAGE_RECEIVED)
  async onSessionMessageReceived(e: SessionMessageEvent): Promise<void> {
    await this.safeDispatch(e.sessionId, 'message.received', e.message);
  }

  @OnEvent(SessionEvents.MESSAGE_SENT)
  async onSessionMessageSent(e: SessionMessageEvent): Promise<void> {
    await this.safeDispatch(e.sessionId, 'message.sent', e.message);
  }

  @OnEvent(SessionEvents.MESSAGE_ACK)
  async onSessionMessageAck(e: SessionAckEvent): Promise<void> {
    await this.safeDispatch(e.sessionId, 'message.ack', e.ack);
  }

  private async safeDispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.dispatch(sessionId, event, data);
    } catch (error) {
      this.logger.error(`Webhook dispatch for '${event}' failed`, String(error), {
        sessionId,
        action: 'webhook_dispatch_failed',
      });
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

    try {
      const response = await fetch(this.normalizeWebhookUrl(webhook.url), {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
      });

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
        const base = this.configService.get<number>('webhook.retryDelay', 5000);
        // Exponential backoff with full jitter: spread synchronized retries so a
        // shared-endpoint outage doesn't cause a thundering-herd retry storm.
        const backoff = base * attempt;
        const delay = backoff + Math.floor(Math.random() * base);
        await this.delay(delay);
        return this.deliverWebhook(webhook, payload, headers, attempt + 1);
      }
      throw error;
    }
  }

  private generateSignature(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  private normalizeWebhookUrl(url: string): string {
    return url.trim();
  }

  private async sendWebhookRequest(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<WebhookHttpResult> {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responseBody = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || '',
      body: responseBody,
    };
  }

  private isRetryableStatus(status: number): boolean {
    if (status === 404 || status === 408 || status === 425 || status === 429) return true;
    return status >= 500;
  }

  private formatHttpError(
    status: number,
    statusText: string,
    responseBody: string,
    url: string,
    attempt: number,
    maxAttempts: number,
  ): string {
    const compactBody = responseBody.replace(/\s+/g, ' ').trim();
    const bodySnippet = compactBody ? ` Response: ${compactBody.slice(0, 220)}` : '';
    const label = statusText ? `${status} ${statusText}` : `${status}`;
    const attemptSuffix = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '';
    return `HTTP ${label} from ${url}${attemptSuffix}.${bodySnippet}`.trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
