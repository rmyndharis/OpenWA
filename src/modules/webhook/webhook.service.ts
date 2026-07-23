import {
  Injectable,
  NotFoundException,
  Optional,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, In, LessThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './utils/record-delivery-failure';
import { CreateWebhookDto, UpdateWebhookDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { resolveSessionScope } from '../../common/security/session-scope';
import { incrementWebhookDeliveryFailures } from '../../common/metrics/webhook-delivery-metrics';
import { ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { QUEUE_NAMES } from '../queue/queue-names';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import { evaluateFilters } from './filters/filter-evaluator';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import {
  assertSafeFetchUrl,
  withSafeFetch,
  isSsrfProtectionEnabled,
  SsrfBlockedError,
  SSRF_BLOCKED_CLIENT_MESSAGE,
  redactSsrfError,
} from '../../common/security/ssrf-guard';
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

@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookService');
  private readonly queueEnabled: boolean;
  private readonly dispatchLimiter: ConcurrencyLimiter;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
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

  /**
   * Periodically prune webhook_delivery_failures older than WEBHOOK_FAILURE_RETENTION_DAYS
   * (default 90; set <= 0 to disable). Runs once at startup, then daily. The table is an append-only
   * log written on every terminally-failed delivery, so without this it grows without bound under a
   * receiver outage. (Mirrors AuditService's audit-log retention.)
   */
  onModuleInit(): void {
    const parsed = Number.parseInt(process.env.WEBHOOK_FAILURE_RETENTION_DAYS ?? '', 10);
    const retentionDays = Number.isInteger(parsed) ? Math.max(0, parsed) : 90;
    if (retentionDays <= 0) {
      this.logger.log('Webhook delivery-failure retention disabled (WEBHOOK_FAILURE_RETENTION_DAYS <= 0)');
      return;
    }
    const runPrune = (): void => {
      this.pruneDeliveryFailures(retentionDays)
        .then(n => {
          if (n > 0) this.logger.log(`Pruned ${n} webhook delivery-failure(s) older than ${retentionDays} day(s)`);
        })
        .catch(err =>
          this.logger.error('Webhook delivery-failure cleanup failed', err instanceof Error ? err.stack : String(err)),
        );
    };
    runPrune(); // prune once at startup
    this.cleanupTimer = setInterval(runPrune, 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  /**
   * Delete delivery-failure rows older than the retention window. Returns the number removed.
   */
  async pruneDeliveryFailures(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.failureRepository.delete({ createdAt: LessThan(cutoff) });
    return result.affected || 0;
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
        // The raw message names the resolved internal IP (a recon oracle): log it server-side, return generic.
        this.logger.warn(`Webhook URL rejected by SSRF guard: ${error.message}`);
        throw new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
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
      filters: dto.filters ?? null,
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

  async findAll(allowedSessions?: string[] | null, opts: ListOptions = {}): Promise<Webhook[]> {
    // A session-restricted key only sees its own sessions' webhooks; an unrestricted key
    // (null/empty allowlist, e.g. ADMIN) sees all — mirroring the ApiKeyGuard allowedSessions model.
    const { limit, offset } = resolveListWindow(opts.limit, opts.offset);
    const options: FindManyOptions<Webhook> = { order: { createdAt: 'DESC' }, take: limit, skip: offset };
    if (allowedSessions && allowedSessions.length > 0) {
      options.where = { sessionId: In(allowedSessions) };
    }
    return this.webhookRepository.find(options);
  }

  /**
   * Recently-failed webhook deliveries (most recent first), so an operator can see what was lost during
   * a receiver outage. ADMIN-only operational data; an optional sessionId narrows it. Bounded by the
   * shared pagination window. The calling key's allowedSessions is authoritative — the sessionId query
   * param may only narrow within it — because this endpoint takes sessionId as a query param, which the
   * ApiKeyGuard fence (route params only) does not scope; otherwise a session-restricted key could read
   * every session's failed-delivery URLs and errors.
   */
  async listDeliveryFailures(
    opts: ListOptions & { sessionId?: string } = {},
    allowedSessions?: string[] | null,
  ): Promise<WebhookDeliveryFailure[]> {
    const { limit, offset } = resolveListWindow(opts.limit, opts.offset);
    const sessionScope = resolveSessionScope(allowedSessions, opts.sessionId);
    if (sessionScope !== null && sessionScope.length === 0) return []; // requested session outside the key's scope
    return this.failureRepository.find({
      where: sessionScope ? { sessionId: In(sessionScope) } : {},
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async findOne(sessionId: string, id: string): Promise<Webhook> {
    // Scope by the URL's sessionId so one session cannot read/act on another's webhook by id.
    // A wrong-session id resolves to not-found (no cross-session existence oracle).
    const webhook = await this.webhookRepository.findOne({ where: { id, sessionId } });
    if (!webhook) {
      throw new NotFoundException(`Webhook with id '${id}' not found`);
    }
    return webhook;
  }

  async update(sessionId: string, id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    const webhook = await this.findOne(sessionId, id);

    if (dto.url !== undefined) {
      await this.validateWebhookUrl(dto.url);
      webhook.url = dto.url;
    }
    if (dto.events !== undefined) webhook.events = dto.events;
    // Normalize empty string to null (parity with create) — an empty secret means "no HMAC",
    // not a stored blank that silently disables signing while looking configured.
    if (dto.secret !== undefined) webhook.secret = dto.secret || null;
    if (dto.headers !== undefined) webhook.headers = dto.headers;
    if (dto.filters !== undefined) webhook.filters = dto.filters;
    if (dto.active !== undefined) webhook.active = dto.active;
    if (dto.retryCount !== undefined) webhook.retryCount = dto.retryCount;

    return this.webhookRepository.save(webhook);
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const webhook = await this.findOne(sessionId, id);
    await this.webhookRepository.remove(webhook);
  }

  async test(sessionId: string, webhookId: string): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const webhook = await this.findOne(sessionId, webhookId);

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

    try {
      return await withSafeFetch(
        webhook.url,
        {
          method: 'POST',
          headers,
          body,
          // Use the configured WEBHOOK_TIMEOUT (single source of truth across queued/test/direct paths).
          signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
        },
        response => ({ success: response.ok, statusCode: response.status }),
        { guard: isSsrfProtectionEnabled() },
      );
    } catch (error) {
      return {
        success: false,
        error: redactSsrfError(error, this.logger, 'webhook test'),
      };
    }
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    // Callers fire-and-forget this (`void dispatch(...)`), so a failure looking up webhooks must be
    // logged and swallowed here — otherwise it surfaces as an unhandled promise rejection.
    let webhooks: Webhook[];
    try {
      webhooks = await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      return;
    }

    // Resolve a lid actor to its phone through the persistent table so a phone filter matches a
    // lid-addressed sender (e.g. an unresolved @lid group participant). Absent store -> no resolution.
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.getCached(userPart(jid)) ?? null;
    const matchingWebhooks = webhooks.filter(
      w => (w.events.includes(event) || w.events.includes('*')) && evaluateFilters(w.filters, event, data, resolveLid),
    );

    // Base idempotency key for this event occurrence. occurredAt is captured once here and reused for
    // every retry of this dispatch, so recurring lifecycle events get a distinct-per-occurrence key
    // while retries of the same event stay stable. It is salted PER WEBHOOK below.
    const occurredAt = new Date().toISOString();
    const baseIdempotencyKey = generateIdempotencyKey(event, { ...data, sessionId }, occurredAt);

    const recordUndelivered = async (
      webhook: Webhook,
      deliveryId: string,
      idempotencyKey: string,
      error: unknown,
      action: string,
    ): Promise<void> => {
      const lastError = redactSsrfError(error, this.logger, 'webhook dispatch');
      await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
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
      incrementWebhookDeliveryFailures();
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
    };

    // Dispatch to all matching webhooks concurrently — one slow/hanging receiver must not head-of-line-
    // block delivery to the sibling webhooks of the same event (the direct/fallback paths await a
    // recursive retry with backoff sleeps).
    const deliverOne = async (webhook: Webhook, deliveryId: string, idempotencyKey: string): Promise<void> => {
      let finalPayload: WebhookPayload;
      let headers: Record<string, string>;
      try {
        const payload: WebhookPayload = {
          event,
          timestamp: new Date().toISOString(),
          sessionId,
          idempotencyKey,
          deliveryId,
          // Give each webhook its own copy of the event data: a webhook:before hook that mutates
          // payload.data in place would otherwise bleed that change into sibling webhooks.
          data: structuredClone(data),
        };

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
          return;
        }

        // Null/undefined hook results mean "no override", matching an object without payload.
        finalPayload = (hookResult as { payload?: WebhookPayload } | null | undefined)?.payload ?? payload;
        finalPayload.idempotencyKey = idempotencyKey;
        finalPayload.deliveryId = deliveryId;

        headers = {
          ...this.sanitizeCustomHeaders(webhook.headers),
          'Content-Type': 'application/json',
          'User-Agent': 'OpenWA-Webhook/1.0.0',
          'X-OpenWA-Event': event,
          'X-OpenWA-Idempotency-Key': idempotencyKey,
          'X-OpenWA-Delivery-Id': deliveryId,
          'X-OpenWA-Retry-Count': '0',
        };
      } catch (error) {
        await recordUndelivered(webhook, deliveryId, idempotencyKey, error, 'webhook_dispatch_preflight_failed');
        return;
      }

      // Use queue if available, otherwise fallback to direct delivery
      if (this.queueEnabled && this.webhookQueue) {
        try {
          // finalPayload comes from the (untrusted) webhook:before hook result, so JSON.stringify can
          // throw (BigInt / circular). Keep serialization + signing INSIDE the try so a poisoned payload
          // is caught here (one webhook dropped + logged) instead of aborting the whole dispatch loop
          // and rejecting the fire-and-forget dispatch() promise.
          const signature = webhook.secret ? this.generateSignature(JSON.stringify(finalPayload), webhook.secret) : '';

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

          // Fallback: deliver directly when the queue add failed (e.g. Redis unreachable with the
          // producer's enableOfflineQueue:false). This is at-least-once — if add() actually reached
          // Redis before rejecting, the queued job AND this fallback may both POST. Both paths carry the
          // same X-OpenWA-Idempotency-Key / X-OpenWA-Delivery-Id, so a conformant receiver dedupes.
          try {
            await this.deliverWebhook(webhook, finalPayload, headers);

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
          }
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
            { sessionId, event, webhookId: webhook.id, error: redactSsrfError(error, this.logger, 'webhook delivery') },
            { sessionId, source: 'WebhookService' },
          );

          this.logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
            webhookId: webhook.id,
            action: 'webhook_delivery_failed',
          });
        }
      }
    };
    // Bound fan-out: deliver to all matching webhooks concurrently, but cap in-flight deliveries at
    // WEBHOOK_DISPATCH_CONCURRENCY so an event matching many webhooks (or slow receivers) can't open an
    // unbounded number of outbound sockets at once. allSettled preserves the per-webhook isolation.
    const tasks = matchingWebhooks.map(webhook => {
      const deliveryId = generateDeliveryId();
      // Salt per webhook so sibling subscriptions cannot collide at the receiver's dedup boundary.
      const idempotencyKey = `${baseIdempotencyKey}_${webhook.id}`;
      return this.dispatchLimiter
        .run(() => deliverOne(webhook, deliveryId, idempotencyKey))
        .catch(async error => {
          if (error instanceof Error && error.message === 'ConcurrencyLimiter queue full') {
            await recordUndelivered(webhook, deliveryId, idempotencyKey, error, 'webhook_dispatch_capacity_exceeded');
            return;
          }
          throw error;
        });
    });
    await Promise.allSettled(tasks);
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
      const { ok, status, statusText } = await withSafeFetch(
        webhook.url,
        {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.configService.get<number>('webhook.timeout', 10000)),
        },
        response => ({ ok: response.ok, status: response.status, statusText: response.statusText }),
        { guard: isSsrfProtectionEnabled() },
      );

      if (!ok) {
        throw new Error(`HTTP ${status}: ${statusText}`);
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
      // All direct-path retries exhausted — persist a durable failure record before giving up, mirroring
      // the queued processor's final-attempt path so the queue-disabled path isn't a blind spot.
      const errMessage = redactSsrfError(error);
      await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
        webhookId: webhook.id,
        sessionId: payload.sessionId,
        event: payload.event,
        url: webhook.url,
        idempotencyKey: payload.idempotencyKey,
        deliveryId: payload.deliveryId,
        attempts: attempt,
        lastStatusCode: statusCodeFromError(errMessage),
        lastError: errMessage,
      });
      incrementWebhookDeliveryFailures();
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
