import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, webhookWorkerConcurrency } from '../redis-connection';
import { WebhookJobData, WebhookPayload } from '../../webhook/webhook.service';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from '../../webhook/utils/record-delivery-failure';
import { HookManager } from '../../../core/hooks';
import { withSafeFetch, isSsrfProtectionEnabled, redactSsrfError } from '../../../common/security/ssrf-guard';
import { incrementWebhookDeliveryFailures } from '../../../common/metrics/webhook-delivery-metrics';

export interface WebhookJobResult {
  statusCode: number;
  success: boolean;
  error?: string;
  responseTime: number;
}

/**
 * The exact `failedReason` BullMQ 5.80.x sets when a job stalls more than `maxStalledCount` (worker
 * default 1, so the SECOND genuine stall): the stalled checker (moveStalledJobsToWait Lua script)
 * stores it as the job's deferred failure, and the worker then fails the job itself — emitting
 * 'failed' WITHOUT ever calling process(). Lock renewal means a slow-but-alive processor never
 * stalls, so reaching this sentinel implies the job genuinely died twice mid-processing.
 */
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';

/** Per-attempt delivery context threaded through the process() pipeline stages (was closure state). */
interface WebhookDeliveryContext {
  job: Job<WebhookJobData>;
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  maxRetries: number;
  sessionId: string;
  startTime: number;
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

    const ctx: WebhookDeliveryContext = { job, webhookId, url, event, payload, maxRetries, sessionId, startTime };

    try {
      const { status, responseTime } = await this.postToReceiver(ctx, requestHeaders);
      await this.recordSuccessfulDelivery(ctx, status, responseTime);
      return {
        statusCode: status,
        success: true,
        responseTime,
      };
    } catch (error) {
      await this.recordDeliveryFailure(ctx, error);
      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  /**
   * POST the payload to the receiver through the SSRF-guarded fetch and classify the response:
   * a non-ok status throws into the failure path. Returns the status and measured response time.
   */
  private async postToReceiver(
    ctx: WebhookDeliveryContext,
    requestHeaders: Record<string, string>,
  ): Promise<{ status: number; responseTime: number }> {
    const { url, payload, startTime } = ctx;
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

    return { status, responseTime };
  }

  /**
   * Post-delivery bookkeeping for a 2xx answer: guarded lastTriggeredAt update, the
   * webhook:delivered hook, and the success log.
   */
  private async recordSuccessfulDelivery(
    ctx: WebhookDeliveryContext,
    status: number,
    responseTime: number,
  ): Promise<void> {
    const { job, webhookId, event, payload, sessionId } = ctx;
    // The receiver already answered 2xx — the delivery SUCCEEDED. Everything up to the return is
    // bookkeeping and must never throw back into the failure path: a rethrow would make BullMQ
    // retry (a duplicate POST for an already-delivered event) and, on the final attempt, file a
    // false dead-letter row. Log a bookkeeping failure and keep the success outcome.
    try {
      await this.webhookRepository.update(webhookId, {
        lastTriggeredAt: new Date(),
      });
    } catch (bookkeepingError) {
      this.logger.error(
        'Webhook delivered but lastTriggeredAt update failed',
        bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
        { webhookId, deliveryId: payload.deliveryId, action: 'webhook_bookkeeping_failed' },
      );
    }

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
  }

  /**
   * Failure-path bookkeeping: log the delivery failure and, on the final attempt, fire the
   * webhook:error hook, persist the durable dead-letter row, and bump the failures metric.
   */
  private async recordDeliveryFailure(ctx: WebhookDeliveryContext, error: unknown): Promise<void> {
    const { job, webhookId, url, event, payload, maxRetries, sessionId, startTime } = ctx;
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
      // The hook payload and the durable row are surfaced to operators/plugins — redact SSRF detail
      // (resolved internal IP) from the client-facing message. The full `errorMessage` is already
      // logged server-side above; statusCodeFromError never matches an SSRF block (matches ^HTTP \d{3}).
      const clientError = redactSsrfError(error);
      await this.hookManager.execute(
        'webhook:error',
        {
          sessionId,
          event,
          webhookId,
          deliveryId: payload.deliveryId,
          error: clientError,
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
        lastError: clientError,
      });
      incrementWebhookDeliveryFailures();
    }
  }

  /**
   * A job failed by stall exhaustion never enters process(): the worker fails it internally after
   * the second stall and only emits 'failed'. Without this handler such a job bypasses every product
   * failure channel — no dead-letter row, no metric, no webhook:error hook. Normal delivery failures
   * are already recorded by process() on the final attempt (and non-final ones are retried), so this
   * handler MUST ignore anything but the stall-exhaustion sentinel, or every failure is recorded
   * twice. `job` can be undefined when the queue's bounded `removeOnFail` window (see QueueModule's
   * WEBHOOK_QUEUE_JOB_OPTIONS) pruned it before this event fired — that window keeps failed-job
   * retention bounded, and each retained payload was size-gated before enqueue.
   */
  @OnWorkerEvent('failed')
  async onWorkerFailed(job: Job<WebhookJobData> | undefined, error: Error): Promise<void> {
    if (!job || error.message !== STALL_EXHAUSTION_MESSAGE) {
      return;
    }

    const { webhookId, url, event, payload } = job.data;
    const sessionId = payload.sessionId;

    this.logger.error('Webhook job failed after stalling beyond the recovery limit', error.message, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attemptsMade: job.attemptsMade,
      action: 'webhook_stall_exhausted',
    });

    await this.hookManager.execute(
      'webhook:error',
      {
        sessionId,
        event,
        webhookId,
        deliveryId: payload.deliveryId,
        error: error.message,
        attempt: job.attemptsMade,
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
      attempts: job.attemptsMade,
      lastStatusCode: null, // no HTTP exchange completed on the stalled attempts
      lastError: error.message,
    });
    incrementWebhookDeliveryFailures();
  }
}
