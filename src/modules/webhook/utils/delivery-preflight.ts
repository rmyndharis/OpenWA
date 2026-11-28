import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Webhook } from '../entities/webhook.entity';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import type { WebhookPayload } from '../webhook-delivery.service';
import { recordWebhookDeliveryFailure } from './record-delivery-failure';
import { type LoggerService } from '../../../common/services/logger.service';
import { shedInlineMedia } from '../../../common/utils/inline-media';
import { incrementWebhookDeliveryFailures } from '../../../common/metrics/webhook-delivery-metrics';
import { redactSsrfError } from '../../../common/security/ssrf-guard';
import { HookManager } from '../../../core/hooks';
import { isPlainObject, isWebhookBeforeResult } from '../../../core/hooks/hook-results';

/**
 * Upper bound on the serialized webhook body after webhook:before hooks ran. Hook results are
 * untrusted: an unbounded mutation (or a genuinely huge media event) would POST a giant body and,
 * on failure, bloat the durable failure path. Oversize payloads are recorded as undelivered instead.
 * Default 1 MiB; override with WEBHOOK_MAX_PAYLOAD_BYTES.
 */
const DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES = 1024 * 1024;

/** The event occurrence one delivery is built from. */
export interface PreflightContext {
  sessionId: string;
  event: string;
  baseData: Record<string, unknown>;
}

/**
 * Builds the body of one webhook delivery and records a delivery that must not be sent. Shared by the dispatch path
 * and the queue worker, which cannot inject WebhookDeliveryService (WebhookModule imports QueueModule), so both build
 * a body the same way: hooks, fail-closed mode, identity re-assertion and the size gate.
 */
export class DeliveryPreflight {
  constructor(
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly logger: LoggerService,
  ) {}

  async recordUndelivered(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    error: unknown,
    action: string,
    ctx: PreflightContext,
  ): Promise<boolean> {
    const { sessionId, event } = ctx;
    const lastError = redactSsrfError(error, this.logger, 'webhook dispatch');
    const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
      webhookId: webhook.id,
      sessionId,
      event,
      url: webhook.url,
      idempotencyKey,
      deliveryId,
      attempts: 0,
      lastStatusCode: null,
      lastError,
    });
    if (recorded !== false) incrementWebhookDeliveryFailures();
    try {
      await this.hookManager.execute(
        'webhook:error',
        { sessionId, event, webhookId: webhook.id, deliveryId, error: lastError },
        { sessionId, source: 'WebhookService' },
      );
    } catch (hookError) {
      this.logger.error('webhook:error hook failed while reporting an undelivered webhook', String(hookError), {
        webhookId: webhook.id,
        deliveryId,
        action: 'webhook_error_hook_failed',
      });
    }
    this.logger.error(`Webhook ${webhook.id} was not dispatched`, lastError, {
      webhookId: webhook.id,
      deliveryId,
      action,
    });
    return recorded !== null;
  }

  private isPreEgressFailClosed(): boolean {
    if (typeof this.hookManager.isPreEgressFailClosed === 'function') {
      return this.hookManager.isPreEgressFailClosed();
    }
    const configured = this.configService.get<boolean | string>('hooks.preEgressFailClosed');
    if (typeof configured === 'boolean') return configured;
    if (typeof configured === 'string') return configured.trim().toLowerCase() === 'true';
    return process.env.HOOK_PRE_EGRESS_FAIL_CLOSED?.trim().toLowerCase() === 'true';
  }

  /**
   * Build one webhook delivery: payload + webhook:before hooks + identity re-assertion + size gate.
   * Returns null when the delivery must not proceed: either cancelled by a plugin (a debug
   * log, not a failure) or after a failure already recorded via recordUndelivered.
   */
  async preflightDelivery(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: PreflightContext,
  ): Promise<{ finalPayload: WebhookPayload; body: string } | 'cancelled' | 'unrecorded' | null> {
    const { sessionId, event, baseData } = ctx;
    try {
      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        sessionId,
        idempotencyKey,
        deliveryId,
        // Give each webhook its own copy of the event data: a webhook:before hook that mutates
        // payload.data in place would otherwise bleed that change into sibling webhooks.
        data: structuredClone(baseData),
      };
      // Captured BEFORE the hook chain: a hook may return the same payload object mutated in
      // place, so reading the canonical timestamp off the hook result afterwards is not safe.
      const payloadTimestamp = payload.timestamp;

      // A handler result without a plain-object payload is skipped, so the chain keeps the last usable
      // payload (an earlier hook's redaction included) rather than the one it started from.
      const { continue: shouldContinue, data: hookResult } = await this.hookManager.execute(
        'webhook:before',
        { sessionId, event, payload },
        {
          sessionId,
          source: 'WebhookService',
          accept: isWebhookBeforeResult,
        },
      );

      if (!shouldContinue) {
        this.logger.debug(`Webhook dispatch cancelled by plugin for ${event}`, {
          webhookId: webhook.id,
          action: 'webhook_cancelled_by_plugin',
        });
        return 'cancelled';
      }

      // In fail-closed mode, require a plain-object hookResult carrying an own plain-object `payload`
      // without falling back to the unmoderated original payload via `?? payload`.
      // In fail-open mode, null/undefined or non-object payloads fall back to the original and warn.
      let finalPayload: WebhookPayload;
      if (this.isPreEgressFailClosed()) {
        const hasOwnPayload = isPlainObject(hookResult) && Object.prototype.hasOwnProperty.call(hookResult, 'payload');
        const candidatePayload = hasOwnPayload ? (hookResult as { payload?: unknown }).payload : undefined;
        if (!hasOwnPayload || !isPlainObject(candidatePayload)) {
          const received = !isPlainObject(hookResult)
            ? Array.isArray(hookResult)
              ? 'array'
              : hookResult === null
                ? 'null'
                : typeof hookResult
            : !hasOwnPayload
              ? 'missing payload'
              : Array.isArray(candidatePayload)
                ? 'array payload'
                : candidatePayload === null
                  ? 'null payload'
                  : `${typeof candidatePayload} payload`;
          throw new Error(
            `A webhook:before hook returned an unusable payload (${received}) while fail-closed mode is enabled`,
          );
        }
        finalPayload = candidatePayload as unknown as WebhookPayload;
      } else {
        const hookPayload = (hookResult as { payload?: unknown } | null | undefined)?.payload ?? payload;
        const usable = isPlainObject(hookPayload);
        if (!usable) {
          this.logger.warn('A webhook:before hook returned a payload that is not an object; sending the original', {
            webhookId: webhook.id,
            event,
            received: Array.isArray(hookPayload) ? 'array' : typeof hookPayload,
            action: 'hook_payload_discarded',
          });
        }
        finalPayload = usable ? (hookPayload as unknown as WebhookPayload) : payload;
      }
      // Re-assert EVERY identity field after the (untrusted) hook chain. A hook may rewrite data,
      // but event/sessionId/timestamp and the dedupe ids must remain the server's values: the
      // receiver verifies the signature over this body and compares it against the X-OpenWA-*
      // headers, and failure records are filed by these fields: a rewritten sessionId/event
      // misfiles them across sessions.
      finalPayload.event = event;
      finalPayload.sessionId = sessionId;
      finalPayload.timestamp = payloadTimestamp;
      finalPayload.idempotencyKey = idempotencyKey;
      finalPayload.deliveryId = deliveryId;

      // Bound what a hook mutation can make us send. Serializing here also catches a poisoned
      // (BigInt/circular) hook result as a preflight failure, on BOTH the queued and direct paths.
      // The bytes are serialized ONCE and reused for the size gate, the HMAC signature, and the
      // direct-delivery body (BullMQ re-serializes jobData itself, unavoidably).
      const maxPayloadBytes = this.configService.get<number>(
        'webhook.maxPayloadBytes',
        DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
      );
      let body = JSON.stringify(finalPayload);
      let payloadBytes = Buffer.byteLength(body, 'utf8');
      if (payloadBytes > maxPayloadBytes) {
        // Size-gated body shedding: over budget, strip ANY remaining inline media blob (threshold
        // 0; the marker form keeps the event deliverable) and re-check, instead of dropping the
        // event or queueing a giant payload.
        const shedData = shedInlineMedia(finalPayload.data, 0);
        if (shedData !== finalPayload.data) {
          finalPayload.data = shedData;
          body = JSON.stringify(finalPayload);
          payloadBytes = Buffer.byteLength(body, 'utf8');
        }
      }
      if (payloadBytes > maxPayloadBytes) {
        const recorded = await this.recordUndelivered(
          webhook,
          deliveryId,
          idempotencyKey,
          new Error(
            `Webhook payload is ${payloadBytes} bytes after webhook:before hooks, exceeding the ${maxPayloadBytes}-byte cap`,
          ),
          'webhook_payload_oversize',
          ctx,
        );
        return recorded ? null : 'unrecorded';
      }

      return { finalPayload, body };
    } catch (error) {
      const recorded = await this.recordUndelivered(
        webhook,
        deliveryId,
        idempotencyKey,
        error,
        'webhook_dispatch_preflight_failed',
        ctx,
      );
      return recorded ? null : 'unrecorded';
    }
  }
}
