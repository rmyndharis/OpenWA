import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, webhookWorkerConcurrency } from '../redis-connection';
import { WebhookJobData } from '../../webhook/webhook.service';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from '../../webhook/utils/record-delivery-failure';
import { HookManager } from '../../../core/hooks';
import { withSafeFetch, isSsrfProtectionEnabled } from '../../../common/security/ssrf-guard';

export interface WebhookJobResult {
  statusCode: number;
  success: boolean;
  error?: string;
  responseTime: number;
}

// Override the Worker's connection so it does NOT inherit the producer's `enableOfflineQueue: false`
// from the shared BullModule connection — the Worker must tolerate a brief Redis reconnect. Set an
// explicit concurrency: BullMQ defaults a Worker to 1, which serializes every session's webhook
// deliveries behind one slow/timing-out receiver.
@Processor(QUEUE_NAMES.WEBHOOK, { connection: workerConnectionOptions(), concurrency: webhookWorkerConcurrency() })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = createLogger('WebhookProcessor');

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const { webhookId, url, event, payload, headers, maxRetries } = job.data;
    const startTime = Date.now();
    const sessionId = payload.sessionId;

    this.logger.log(`Processing webhook job ${job.id}`, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attempt: job.attemptsMade + 1,
      action: 'webhook_process_start',
    });

    // Update retry count in headers
    const requestHeaders = {
      ...headers,
      'X-OpenWA-Retry-Count': String(job.attemptsMade),
    };

    try {
      const { status, statusText, ok } = await withSafeFetch(
        url,
        {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(payload),
          // Honor WEBHOOK_TIMEOUT on the primary (queued) path too — not just the deprecated direct one.
          signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
        },
        response => ({ status: response.status, statusText: response.statusText, ok: response.ok }),
        { guard: isSsrfProtectionEnabled() },
      );

      const responseTime = Date.now() - startTime;

      if (!ok) {
        throw new Error(`HTTP ${status}: ${statusText}`);
      }

      // Update lastTriggeredAt on successful delivery
      await this.webhookRepository.update(webhookId, {
        lastTriggeredAt: new Date(),
      });

      // Execute hook after successful delivery
      await this.hookManager.execute(
        'webhook:delivered',
        {
          sessionId,
          event,
          webhookId,
          deliveryId: payload.deliveryId,
          statusCode: status,
          responseTime,
          attempt: job.attemptsMade + 1,
        },
        { sessionId, source: 'WebhookProcessor' },
      );

      this.logger.log(`Webhook delivered successfully`, {
        webhookId,
        event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        statusCode: status,
        responseTime,
        attempt: job.attemptsMade + 1,
        action: 'webhook_delivered',
      });

      return {
        statusCode: status,
        success: true,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isFinalAttempt = job.attemptsMade + 1 >= maxRetries;

      this.logger.error(`Webhook delivery failed`, errorMessage, {
        webhookId,
        event,
        deliveryId: payload.deliveryId,
        idempotencyKey: payload.idempotencyKey,
        responseTime,
        attempt: job.attemptsMade + 1,
        maxRetries,
        isFinalAttempt,
        action: 'webhook_failed',
      });

      // On final failure (all retries exhausted): fire the error hook AND persist a durable record so
      // the lost event is visible after the BullMQ failed-set / logs roll off.
      if (isFinalAttempt) {
        await this.hookManager.execute(
          'webhook:error',
          {
            sessionId,
            event,
            webhookId,
            deliveryId: payload.deliveryId,
            error: errorMessage,
            attempt: job.attemptsMade + 1,
          },
          { sessionId, source: 'WebhookProcessor' },
        );
        await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
          webhookId,
          sessionId,
          event,
          url,
          idempotencyKey: payload.idempotencyKey,
          deliveryId: payload.deliveryId,
          attempts: job.attemptsMade + 1,
          lastStatusCode: statusCodeFromError(errorMessage),
          lastError: errorMessage,
        });
      }

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }
}
