import { Injectable, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { setTimeout } from 'node:timers/promises';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure } from './utils/record-delivery-failure';
import { postWebhookPayload, recordTerminalFailure } from './utils/deliver-once';
import { createLogger } from '../../common/services/logger.service';
import { DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES, shedInlineMedia } from '../../common/utils/inline-media';
import { incrementWebhookDeliveryFailures } from '../../common/metrics/webhook-delivery-metrics';
import { QUEUE_NAMES } from '../queue/queue-names';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import { evaluateFilters } from './filters/filter-evaluator';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { redactSsrfError } from '../../common/security/ssrf-guard';
import { HookManager } from '../../core/hooks';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

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
  headers: Record<string, string>;
  attempt: number;
  maxRetries: number;
}

/**
 * Upper bound on the serialized webhook body after webhook:before hooks ran. Hook results are
 * untrusted — an unbounded mutation (or a genuinely huge media event) would POST a giant body and,
 * on failure, bloat the durable failure path. Oversize payloads are recorded as undelivered instead.
 * Default 1 MiB; override with WEBHOOK_MAX_PAYLOAD_BYTES.
 */
const DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES = 1024 * 1024;

// Decoded-byte cap for inline base64 media and the shed helper live in common/utils/inline-media:
// the WebSocket gateway sheds message-event payloads with the SAME cap and marker, so the two
// outbound sinks stay one contract.

/**
 * How long shutdown waits for in-flight direct deliveries (and their dead-letter bookkeeping) to
 * finish before abandoning them. Default 5s; override with WEBHOOK_SHUTDOWN_DRAIN_MS.
 */
const DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS = 5000;

/** Per-event-occurrence context threaded through the dispatch pipeline stages (was closure state). */
/**
 * The result of one delivery attempt. Reported, not thrown: every failure below is already handled
 * in place, so nothing reaches a caller as an exception and a try/catch cannot tell a delivered
 * event from a dead-lettered one. 'cancelled' is a plugin suppressing the dispatch on purpose: it
 * is terminal like 'delivered' and must never be replayed, but nothing left the process.
 */
export type WebhookDeliveryOutcome = 'delivered' | 'enqueued' | 'cancelled' | 'failed';

interface DispatchEventContext {
  sessionId: string;
  event: string;
  baseData: Record<string, unknown>;
}

/**
 * The webhook delivery engine: given an event occurrence, fan it out to the session's matching
 * webhooks — bounded by the dispatch limiter — through the BullMQ queue when enabled (with a
 * direct-delivery fallback when enqueue fails) or through direct inline delivery when not.
 * Records terminally failed deliveries in webhook_delivery_failures. Webhook registration/CRUD
 * lives on WebhookService, which delegates dispatch here.
 */
@Injectable()
export class WebhookDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookDelivery');
  private readonly queueEnabled: boolean;
  private readonly dispatchLimiter: ConcurrencyLimiter;
  /**
   * Context of every delivery currently holding a dispatch-limiter slot (queued-path enqueue or a
   * direct delivery with its retry loop). Used at shutdown to log, per delivery, what the bounded
   * drain had to abandon — those deliveries were neither completed nor safely recorded.
   */
  private readonly inFlightDeliveries = new Map<
    string,
    { webhookId: string; sessionId: string; event: string; idempotencyKey: string; url: string }
  >();
  /** Late bookkeeping (dead-letter rows) written by tasks the limiter already released — awaited on shutdown. */
  private readonly pendingBookkeeping = new Set<Promise<void>>();
  /** In-memory cache of active webhooks per session to avoid per-event DB queries on the hot dispatch path. */
  private readonly webhookCache = new Map<string, { webhooks: Webhook[]; expiresAt: number }>();
  private readonly webhookCacheTtlMs = 60_000;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly outbox: WebhookOutboxService,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue<WebhookJobData>,
  ) {
    this.queueEnabled = configService.get<boolean>('queue.enabled', false);
    // Bound fan-out: cap how many matching webhooks are delivered CONCURRENTLY for one event. Without
    // it, an event matching N webhooks opens N outbound sockets at once. Default 16
    // (WEBHOOK_DISPATCH_CONCURRENCY).
    this.dispatchLimiter = new ConcurrencyLimiter(
      this.configService.get<number>('webhook.dispatchConcurrency', 16),
      this.configService.get<number>('webhook.dispatchMaxQueued', 1000),
    );
  }

  onModuleInit(): void {
    // Warn on the default-derived misconfiguration that silently truncates in-flight deliveries at
    // shutdown: WEBHOOK_SHUTDOWN_DRAIN_MS (default 5s) bounds how long onModuleDestroy waits for a
    // delivery in flight, while WEBHOOK_TIMEOUT (default 10s) bounds the delivery itself. When the
    // drain is shorter than the timeout, a delivery that takes nearly the full timeout is abandoned
    // (logged, not dead-lettered — the receiver may already have it). The defaults already cross, so
    // surface the cross so an operator who raised the timeout without raising the drain notices.
    const drainMs = this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
    const deliveryTimeoutMs = this.configService.get<number>('webhook.timeout', 10_000);
    if (Number.isFinite(drainMs) && Number.isFinite(deliveryTimeoutMs) && drainMs < deliveryTimeoutMs) {
      this.logger.warn(
        `WEBHOOK_SHUTDOWN_DRAIN_MS (${drainMs}ms) is shorter than WEBHOOK_TIMEOUT (${deliveryTimeoutMs}ms) — ` +
          `an in-flight delivery that takes nearly the full timeout will be abandoned at shutdown. ` +
          `Raise WEBHOOK_SHUTDOWN_DRAIN_MS to at least WEBHOOK_TIMEOUT if you want shutdown to wait for deliveries to complete.`,
      );
    }
  }

  /**
   * Bounded drain of the direct-delivery path (queued BullMQ jobs are durable in Redis and need no
   * drain). In direct mode, closing the limiter rejects every PARKED delivery; the dispatch catch
   * records each one in webhook_delivery_failures like any other undispatched delivery. Queued mode
   * skips the close: a parked dispatch's whole job is webhookQueue.add() — durable in Redis the
   * moment it resolves — so rejecting it would dead-letter work Redis could have kept. A parked
   * waiter holds an activeCount slot via handoff, so the drain loop below covers it either way.
   * In-flight deliveries (a direct delivery can outlive WEBHOOK_TIMEOUT via its backoff sleeps) get
   * up to WEBHOOK_SHUTDOWN_DRAIN_MS to finish; anything still running after that is about to be
   * dropped by process exit, so it is logged per delivery — a dead-letter row would be wrong there,
   * since the receiver may already have gotten the event. Nest awaits this hook during app.close(),
   * so the bound also keeps app.close() itself bounded.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.queueEnabled) {
      this.dispatchLimiter.close();
    }
    const drainMs = Math.max(
      0,
      this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS),
    );
    const deadline = Date.now() + drainMs;
    while (this.dispatchLimiter.activeCount > 0 || this.pendingBookkeeping.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await setTimeout(Math.min(50, remaining));
    }
    for (const lost of this.inFlightDeliveries.values()) {
      this.logger.error('Webhook delivery abandoned during shutdown', undefined, {
        ...lost,
        action: 'webhook_delivery_abandoned_shutdown',
      });
    }
    this.webhookCache.clear();
    this.inFlightDeliveries.clear();
  }

  /** Invalidate cached active webhooks for a specific session or for all sessions. */
  invalidateWebhooks(sessionId?: string): void {
    if (sessionId) {
      this.webhookCache.delete(sessionId);
    } else {
      this.webhookCache.clear();
    }
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    const webhooks = await this.loadActiveWebhooks(sessionId, event);
    const matchingWebhooks = this.filterMatchingWebhooks(webhooks, event, data);

    // Base idempotency key for this event occurrence. occurredAt is captured once here and reused for
    // every retry of this dispatch, so recurring lifecycle events get a distinct-per-occurrence key
    // while retries of the same event stay stable. It is salted PER WEBHOOK below.
    const occurredAt = new Date().toISOString();
    const baseIdempotencyKey = generateIdempotencyKey(event, { ...data, sessionId }, occurredAt);

    // Fan-out amplification bound: shed an over-cap inline media blob ONCE here, before the
    // per-webhook structuredClone below, so N matching webhooks (and the queued jobs retained in
    // Redis) never copy the blob. The per-webhook clone stays — a webhook:before hook may mutate
    // payload.data in place and must not bleed into siblings — but after shedding it is small.
    const baseData =
      matchingWebhooks.length > 0
        ? shedInlineMedia(
            data,
            this.configService.get<number>('webhook.mediaInlineMaxBytes', DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES),
          )
        : data;

    const ctx: DispatchEventContext = { sessionId, event, baseData };
    // allSettled preserves the per-webhook isolation: one failing delivery never rejects the others.
    await Promise.allSettled(matchingWebhooks.map(webhook => this.dispatchWithLimit(webhook, baseIdempotencyKey, ctx)));
  }

  /**
   * Callers fire-and-forget this (`void dispatch(...)`), so a failure looking up webhooks must be
   * logged and swallowed here — otherwise it surfaces as an unhandled promise rejection.
   */
  private async loadActiveWebhooks(sessionId: string, event: string): Promise<Webhook[]> {
    const now = Date.now();
    const cached = this.webhookCache.get(sessionId);
    if (cached && cached.expiresAt > now) {
      return cached.webhooks;
    }

    try {
      const webhooks = await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
      this.webhookCache.set(sessionId, {
        webhooks,
        expiresAt: now + this.webhookCacheTtlMs,
      });
      return webhooks;
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      return cached ? cached.webhooks : [];
    }
  }

  private filterMatchingWebhooks(webhooks: Webhook[], event: string, data: Record<string, unknown>): Webhook[] {
    // Resolve a lid actor to its phone through the persistent table so a phone filter matches a
    // lid-addressed sender (e.g. an unresolved @lid group participant). Absent store -> no resolution.
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.resolveLid(jid) ?? null;
    const subscribed = webhooks.filter(w => w.events.includes(event) || w.events.includes('*'));
    const matching = subscribed.filter(w => evaluateFilters(w.filters, event, data, resolveLid));
    // A subscribed webhook that a filter drops leaves no trace otherwise: dispatch() awaits an empty
    // array and returns, and the delivery-failure table only records deliveries that were ATTEMPTED.
    // That is fine when the filter is doing its job, and indistinguishable from it when it is not —
    // a condition on a field the event's payload does not carry resolves to undefined and fails,
    // which is how a `sender` filter silently swallows every message.ack. Debug rather than warn:
    // suppression is the normal outcome of a working filter, so this is a trace to switch on while
    // investigating, not an alarm.
    if (matching.length < subscribed.length) {
      this.logger.debug('Webhook filters suppressed a delivery', {
        action: 'webhook_filter_suppressed',
        event,
        subscribed: subscribed.length,
        suppressed: subscribed.length - matching.length,
        payloadFields: Object.keys(data).sort().join(','),
      });
    }
    return matching;
  }

  private async recordUndelivered(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    error: unknown,
    action: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
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
    if (recorded) {
      incrementWebhookDeliveryFailures();
    }
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
  }

  /**
   * Build one webhook delivery: payload + webhook:before hooks + identity re-assertion + size gate +
   * headers. Returns null when the delivery must not proceed — either cancelled by a plugin (a debug
   * log, not a failure) or after a failure already recorded via recordUndelivered.
   */
  private async preflightDelivery(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<{ finalPayload: WebhookPayload; body: string; headers: Record<string, string> } | 'cancelled' | null> {
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
        return 'cancelled';
      }

      // Null/undefined hook results mean "no override", matching an object without payload.
      const finalPayload = (hookResult as { payload?: WebhookPayload } | null | undefined)?.payload ?? payload;
      // Re-assert EVERY identity field after the (untrusted) hook chain. A hook may rewrite data,
      // but event/sessionId/timestamp and the dedupe ids must remain the server's values: the
      // receiver verifies the signature over this body and compares it against the X-OpenWA-*
      // headers, and failure records are filed by these fields — a rewritten sessionId/event
      // misfiles them across sessions.
      finalPayload.event = event;
      finalPayload.sessionId = sessionId;
      finalPayload.timestamp = payloadTimestamp;
      finalPayload.idempotencyKey = idempotencyKey;
      finalPayload.deliveryId = deliveryId;

      // Bound what a hook mutation can make us send. Serializing here also catches a poisoned
      // (BigInt/circular) hook result as a preflight failure, on BOTH the queued and direct paths.
      // The bytes are serialized ONCE and reused for the size gate, the HMAC signature, and the
      // direct-delivery body (BullMQ re-serializes jobData itself — unavoidable).
      const maxPayloadBytes = this.configService.get<number>(
        'webhook.maxPayloadBytes',
        DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
      );
      let body = JSON.stringify(finalPayload);
      let payloadBytes = Buffer.byteLength(body, 'utf8');
      if (payloadBytes > maxPayloadBytes) {
        // Size-gated body shedding: over budget, strip ANY remaining inline media blob (threshold
        // 0 — the marker form keeps the event deliverable) and re-check, instead of dropping the
        // event or queueing a giant payload.
        const shedData = shedInlineMedia(finalPayload.data, 0);
        if (shedData !== finalPayload.data) {
          finalPayload.data = shedData;
          body = JSON.stringify(finalPayload);
          payloadBytes = Buffer.byteLength(body, 'utf8');
        }
      }
      if (payloadBytes > maxPayloadBytes) {
        await this.recordUndelivered(
          webhook,
          deliveryId,
          idempotencyKey,
          new Error(
            `Webhook payload is ${payloadBytes} bytes after webhook:before hooks, exceeding the ${maxPayloadBytes}-byte cap`,
          ),
          'webhook_payload_oversize',
          ctx,
        );
        return null;
      }

      const headers = {
        ...this.sanitizeCustomHeaders(webhook.headers),
        'Content-Type': 'application/json',
        'User-Agent': 'OpenWA-Webhook/1.0.0',
        'X-OpenWA-Event': event,
        'X-OpenWA-Idempotency-Key': idempotencyKey,
        'X-OpenWA-Delivery-Id': deliveryId,
        'X-OpenWA-Retry-Count': '0',
      };
      return { finalPayload, body, headers };
    } catch (error) {
      await this.recordUndelivered(
        webhook,
        deliveryId,
        idempotencyKey,
        error,
        'webhook_dispatch_preflight_failed',
        ctx,
      );
      return null;
    }
  }

  /**
   * What became of one delivery attempt, reported rather than thrown.
   *
   * Every failure path here is already handled in place (a dead-letter row, a hook, a log), so none
   * of them reach the caller as an exception. The reconciler has to tell a delivered event from a
   * dead-lettered one to know whether the outbox row may be retired, and a caught throw cannot tell
   * it: there is none. This mirrors the inbound twin, where `ingressEnqueue.enqueue` returns an
   * outcome and the caller retires the payload only when it is not 'failed'.
   */
  private async deliverOne(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const preflight = await this.preflightDelivery(webhook, deliveryId, idempotencyKey, ctx);
    if (preflight === 'cancelled') {
      // A plugin suppressed this dispatch deliberately. There is no failure to record and nothing
      // to retry: reporting it as failed made the reconciler replay a deliberately dropped event
      // until the budget ran out, then mark it lost against a failure row that never existed.
      return 'cancelled';
    }
    if (!preflight) {
      // The remaining bail-outs record their own undelivered row before returning null.
      return 'failed';
    }
    const { finalPayload, body, headers } = preflight;
    // Use queue if available, otherwise fallback to direct delivery
    if (this.queueEnabled && this.webhookQueue) {
      return this.enqueueWithFallback(webhook, finalPayload, body, headers, deliveryId, idempotencyKey, ctx);
    }
    return this.deliverDirect(webhook, finalPayload, body, headers, deliveryId, ctx);
  }

  private async enqueueWithFallback(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    headers: Record<string, string>,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const { sessionId, event } = ctx;
    try {
      // Sign the exact pre-serialized body from preflight. The processor re-serializes the same
      // payload object at delivery time (JSON key order survives the Redis round-trip), so the
      // signature stays valid over the bytes the receiver sees.
      const signature = webhook.secret ? this.generateSignature(body, webhook.secret) : '';

      if (webhook.secret) {
        headers['X-OpenWA-Signature'] = signature;
      }

      const jobData: WebhookJobData = {
        webhookId: webhook.id,
        url: webhook.url,
        event,
        payload: finalPayload,
        headers,
        attempt: 1,
        maxRetries: webhook.retryCount,
      };

      await this.webhookQueue!.add(`webhook-${webhook.id}`, jobData, {
        // jobId = deliveryId gives BullMQ exactly-once enqueue semantics (same precedent as the
        // ingress producer), so a crash between add() and the bookkeeping below cannot re-enqueue
        // the same delivery. Safe for fan-out: deliveryId is minted per webhook per dispatch in
        // dispatchWithLimit, so sibling subscriptions to one event never share a job id.
        jobId: deliveryId,
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

      // Fallback: deliver directly when the queue add failed (e.g. Redis unreachable with the
      // producer's enableOfflineQueue:false). This is at-least-once — if add() actually reached
      // Redis before rejecting, the queued job AND this fallback may both POST. Both paths carry the
      // same X-OpenWA-Idempotency-Key / X-OpenWA-Delivery-Id, so a conformant receiver dedupes.
      try {
        await this.deliverWebhook(webhook, finalPayload, headers, body);

        await this.hookManager.execute(
          'webhook:delivered',
          { sessionId, event, webhookId: webhook.id, deliveryId, fallback: 'queue_failed' },
          { sessionId, source: 'WebhookService' },
        );

        await this.hookManager.execute(
          'webhook:after',
          { sessionId, event, webhookId: webhook.id, success: true, fallback: 'queue_failed' },
          { sessionId, source: 'WebhookService' },
        );
      } catch (fallbackError) {
        await this.hookManager.execute(
          'webhook:error',
          {
            sessionId,
            event,
            webhookId: webhook.id,
            error: `Queue fallback delivery failed: ${redactSsrfError(fallbackError, this.logger, 'webhook fallback delivery')}`,
          },
          { sessionId, source: 'WebhookService' },
        );

        this.logger.error(`Queue fallback delivery failed for webhook ${webhook.id}`, String(fallbackError), {
          webhookId: webhook.id,
          action: 'webhook_queue_fallback_failed',
        });
        return 'failed';
      }
      // The queue never took it, but the fallback POST did.
      return 'delivered';
    }
    // Handed to BullMQ, which owns the retries and the dead-letter row from here.
    return 'enqueued';
  }

  /** Direct delivery when the queue is disabled. */
  private async deliverDirect(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    headers: Record<string, string>,
    deliveryId: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const { sessionId, event } = ctx;
    try {
      await this.deliverWebhook(webhook, finalPayload, headers, body);

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
        { sessionId, event, webhookId: webhook.id, error: redactSsrfError(error, this.logger, 'webhook delivery') },
        { sessionId, source: 'WebhookService' },
      );

      this.logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        action: 'webhook_delivery_failed',
      });
      return 'failed';
    }
    return 'delivered';
  }

  /**
   * Bound fan-out: deliver to all matching webhooks concurrently, but cap in-flight deliveries at
   * WEBHOOK_DISPATCH_CONCURRENCY so an event matching many webhooks (or slow receivers) can't open an
   * unbounded number of outbound sockets at once.
   */
  private async dispatchWithLimit(
    webhook: Webhook,
    baseIdempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
    const { sessionId, event } = ctx;
    const deliveryId = generateDeliveryId();
    // Salt per webhook so sibling subscriptions cannot collide at the receiver's dedup boundary.
    const idempotencyKey = `${baseIdempotencyKey}_${webhook.id}`;
    // Durable record BEFORE anything is attempted. A hard crash from here until the delivery
    // reaches a durable owner leaves this row 'pending', which is what the reconciler replays.
    await this.outbox.open({
      webhookId: webhook.id,
      sessionId,
      event,
      idempotencyKey,
      deliveryId,
      payload: ctx.baseData,
    });
    await this.dispatchLimiter
      .run(async () => {
        this.inFlightDeliveries.set(deliveryId, {
          webhookId: webhook.id,
          sessionId,
          event,
          idempotencyKey,
          url: webhook.url,
        });
        try {
          await this.deliverOne(webhook, deliveryId, idempotencyKey, ctx);
          // Reached a durable owner: handed to the queue, or completed inline. A failure inside
          // either owner dead-letters through the failure row, so this is never replayed.
          await this.outbox.close(webhook.id, idempotencyKey, 'dispatched');
        } finally {
          this.inFlightDeliveries.delete(deliveryId);
        }
      })
      .catch(async error => {
        if (error instanceof Error && error.message === 'ConcurrencyLimiter queue full') {
          await this.recordUndelivered(
            webhook,
            deliveryId,
            idempotencyKey,
            error,
            'webhook_dispatch_capacity_exceeded',
            ctx,
          );
          return;
        }
        if (error instanceof Error && error.message === 'ConcurrencyLimiter closed') {
          // Rejected by the shutdown drain before dispatching — record it like any other
          // undelivered delivery, and track the write so onModuleDestroy can await it (the
          // limiter slot bookkeeping no longer covers this task).
          const record = this.recordUndelivered(
            webhook,
            deliveryId,
            idempotencyKey,
            error,
            'webhook_dispatch_shutdown',
            ctx,
          );
          this.pendingBookkeeping.add(record);
          try {
            await record;
          } finally {
            this.pendingBookkeeping.delete(record);
          }
          return;
        }
        throw error;
      });
  }

  /**
   * Replay one recorded delivery, reusing its STORED idempotency key.
   *
   * Deriving a fresh key would defeat the point: the receiver dedups on that value, so a replay
   * carrying a new one reads as a second event rather than a retry of the first. A new deliveryId
   * IS issued, because that identifies the attempt rather than the event.
   */
  async redeliver(
    webhook: Webhook,
    sessionId: string,
    event: string,
    idempotencyKey: string,
    data: Record<string, unknown>,
  ): Promise<WebhookDeliveryOutcome> {
    const deliveryId = generateDeliveryId();
    return this.deliverOne(webhook, deliveryId, idempotencyKey, { sessionId, event, baseData: data });
  }

  /**
   * @deprecated Use job queue dispatch instead. This is kept for fallback.
   * `body` is the pre-serialized payload from preflight — the exact bytes the size gate checked and
   * (when a secret is set) the signature covers — so it is never re-serialized here.
   */
  private async deliverWebhook(
    webhook: Webhook,
    payload: WebhookPayload,
    headers: Record<string, string>,
    body: string,
    attempt = 1,
  ): Promise<void> {
    // Update retry count header
    headers['X-OpenWA-Retry-Count'] = String(attempt - 1);

    // Add signature if secret is configured and not already present
    if (webhook.secret && !headers['X-OpenWA-Signature']) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
    }

    try {
      await postWebhookPayload(webhook.url, body, headers, this.configService.get<number>('webhook.timeout', 10000));

      // The receiver already answered 2xx — the delivery SUCCEEDED. A bookkeeping failure here (e.g.
      // the lastTriggeredAt update on a flaky DB) must not reach the catch below: it would retry an
      // already-delivered webhook (duplicate POST) and, on the last attempt, file a false dead-letter
      // row. Log it and keep the success outcome.
      try {
        await this.webhookRepository.update(webhook.id, {
          lastTriggeredAt: new Date(),
        });
      } catch (bookkeepingError) {
        this.logger.error(
          `Webhook delivered to ${webhook.id} but lastTriggeredAt update failed`,
          bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
          { webhookId: webhook.id, deliveryId: payload.deliveryId, action: 'webhook_bookkeeping_failed' },
        );
      }

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
        await setTimeout(delay * attempt);
        return this.deliverWebhook(webhook, payload, headers, body, attempt + 1);
      }
      // All direct-path retries exhausted — persist a durable failure record before giving up, mirroring
      // the queued processor's final-attempt path so the queue-disabled path isn't a blind spot.
      const recorded = await recordTerminalFailure(this.failureRepository, this.logger, {
        webhookId: webhook.id,
        sessionId: payload.sessionId,
        event: payload.event,
        url: webhook.url,
        idempotencyKey: payload.idempotencyKey,
        deliveryId: payload.deliveryId,
        attempts: attempt,
        error,
      });
      if (recorded) {
        incrementWebhookDeliveryFailures();
      }
      throw error;
    }
  }

  /**
   * Drop operator-supplied custom headers that target reserved names (Content-Type or any
   * X-OpenWA-* header) so a webhook config cannot forge the signature/event/idempotency
   * headers. Spread the result BEFORE the system headers so system always wins. Shared with
   * WebhookService.test(), which must probe with headers identical to a real delivery's.
   */
  sanitizeCustomHeaders(custom: Record<string, string> | null | undefined): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(custom ?? {})) {
      if (!/^(content-type|x-openwa-)/i.test(key)) {
        safe[key] = value;
      }
    }
    return safe;
  }

  /** HMAC-SHA256 over the exact pre-serialized body, prefixed for receiver-side verification. */
  generateSignature(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }
}
