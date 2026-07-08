import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { QUEUE_NAMES } from '../queue/queue-names';
import { createLogger } from '../../common/services/logger.service';

/**
 * Outcome of an enqueue attempt. 'queued' = handed to BullMQ; 'dispatched' = delivered inline; 'failed'
 * = inline dispatch threw and was swallowed (`error` carries the message). enqueue() never throws, so
 * callers use the outcome (not exceptions) to decide durability follow-up: a LIVE ingress delivery must
 * persist a dead-letter row on 'failed' (see buildIngressDeadLetterRow, wired at the IngressService
 * factory) so RedriveService can replay it; RedriveService itself calls enqueue() directly, because a
 * failed replay must keep its EXISTING dead-letter row redrivable rather than write a second one.
 */
export type EnqueueOutcome = { outcome: 'queued' | 'dispatched' | 'failed'; error?: string };

/**
 * Retry policy for inbound ingress jobs. Previously the enqueue passed only a jobId, so BullMQ ran a
 * SINGLE attempt — a transient plugin-sandbox 5xx went straight to the DLQ with no retry (asymmetric
 * with the webhook queue). A few exponential-backoff attempts absorb transient failures; the
 * final-attempt DLQ write in ingress.processor is gated on `job.opts.attempts`, so it still fires
 * exactly once, only after these are exhausted. Env-overridable (INGRESS_MAX_ATTEMPTS /
 * INGRESS_RETRY_DELAY_MS); an invalid value falls back to the default.
 */
export function resolveIngressJobOptions(): { attempts: number; backoff: { type: 'exponential'; delay: number } } {
  const attempts = Number(process.env.INGRESS_MAX_ATTEMPTS);
  const delay = Number(process.env.INGRESS_RETRY_DELAY_MS);
  return {
    attempts: Number.isInteger(attempts) && attempts >= 1 ? attempts : 3,
    backoff: { type: 'exponential', delay: Number.isInteger(delay) && delay >= 0 ? delay : 5000 },
  };
}

/**
 * Build the dead-letter row for an ingress delivery whose inline-dispatch fallback failed. The shape
 * mirrors the row IngressProcessor writes on a final-attempt failure (direction / pluginId / instanceId
 * / sessionId / deliveryId / attempts / lastError / payload / redriven), so RedriveService reads either
 * back identically. `attempts` is 1 — the inline path makes a single dispatch attempt (no BullMQ retries).
 */
export function buildIngressDeadLetterRow(data: IngressJobData, error?: string): Partial<IntegrationDeliveryFailure> {
  return {
    direction: 'inbound',
    pluginId: data.pluginId,
    instanceId: data.instanceId,
    sessionId: data.sessionId ?? null,
    deliveryId: data.deliveryId,
    attempts: 1,
    lastError: error ?? 'inline ingress dispatch failed',
    payload: { route: data.route, providerConversationId: data.providerConversationId, ingress: data.payload },
    redriven: false,
  };
}

/**
 * Shared queue-or-inline enqueue for inbound ingress jobs. Extracted out of IngressService's DI
 * factory (integration.module.ts) so RedriveService can reuse the exact same behavior when replaying
 * DLQ rows: same queue.add args, same inline dispatch-after-persist fallback, same error swallow.
 * The ingress queue is OPTIONAL — it only exists as a provider under QUEUE_ENABLED (QueueModule) —
 * so a missing injection falls back to inline dispatch, mirroring WebhookService's direct fallback.
 */
@Injectable()
export class IngressEnqueueService {
  private readonly logger = createLogger('IngressEnqueueService');

  constructor(
    private readonly loader: PluginLoaderService,
    private readonly config: ConfigService,
    @Optional() @InjectQueue(QUEUE_NAMES.INGRESS) private readonly ingressQueue?: Queue<IngressJobData>,
  ) {}

  async enqueue(data: IngressJobData, jobId: string): Promise<EnqueueOutcome> {
    const queueEnabled = this.config.get<boolean>('queue.enabled', false);
    const useQueue = queueEnabled && !!this.ingressQueue;

    if (useQueue && this.ingressQueue) {
      try {
        // jobId = deliveryId gives BullMQ exactly-once enqueue semantics; the retry policy adds bounded
        // exponential-backoff attempts so a transient failure retries before landing in the DLQ.
        await this.ingressQueue.add('ingress', data, { jobId, ...resolveIngressJobOptions() });
        return { outcome: 'queued' };
      } catch (err) {
        // Redis unreachable (enableOfflineQueue:false makes add() reject) — fall through to inline
        // dispatch. Without this, the already-persisted event would be lost forever: the throw would
        // 500 the ingress request, the provider retries, dedup returns "duplicate", and no job was
        // ever enqueued (no DLQ row either). Mirrors WebhookService's queue-add fallback.
        this.logger.error(
          'Ingress queue add failed; dispatching inline',
          err instanceof Error ? err.message : String(err),
          {
            pluginId: data.pluginId,
            instanceId: data.instanceId,
            route: data.route,
            deliveryId: data.deliveryId,
            action: 'ingress_queue_add_failed',
          },
        );
      }
    }
    // Queue disabled OR queue.add() failed: dispatch inline AFTER the ingress_events row was persisted
    // (persist-before-dispatch still holds), mirroring the webhook direct-delivery fallback.
    try {
      await this.loader.dispatchWebhookForInstance(data);
      return { outcome: 'dispatched' };
    } catch (err) {
      // A duplicate delivery already 200s before this point, so a failure here is a real dispatch error.
      // Log and swallow so the provider still gets its 202 (at-least-once, like the webhook fallback).
      // enqueue() intentionally does NOT write a dead-letter row here — it is shared with RedriveService
      // (a failed replay must not spawn a second DLQ row). The 'failed' outcome + error is returned so the
      // caller decides durability: the live-ingress wiring persists a DLQ row (buildIngressDeadLetterRow).
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error('Inline ingress dispatch failed', error, {
        pluginId: data.pluginId,
        instanceId: data.instanceId,
        route: data.route,
        deliveryId: data.deliveryId,
        action: 'ingress_inline_dispatch_failed',
      });
      return { outcome: 'failed', error };
    }
  }
}
