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

/**
 * Upper bound on the serialized webhook body after webhook:before hooks ran. Hook results are
 * untrusted — an unbounded mutation (or a genuinely huge media event) would POST a giant body and,
 * on failure, bloat the durable failure path. Oversize payloads are recorded as undelivered instead.
 * Default 1 MiB; override with WEBHOOK_MAX_PAYLOAD_BYTES.
 */
const DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Upper bound on how many webhooks one session can register. One inbound event fans out to EVERY
 * registered webhook of the session, so an unbounded count multiplies per-event payload copies
 * (clones, outbound sockets, queued jobs). Default 16; override with WEBHOOK_MAX_PER_SESSION
 * (0 disables). Only NEW registrations above the cap are refused — existing ones are grandfathered.
 */
const DEFAULT_WEBHOOK_MAX_PER_SESSION = 16;

/**
 * Decoded-byte cap for inline base64 media in webhook payloads. A larger blob is replaced with the
 * engine's omitted-marker shape ({ mimetype, filename?, omitted: true, sizeBytes }) before the
 * payload is cloned per webhook or queued, so fan-out and Redis retention never copy it. Default
 * 1 MiB; override with WEBHOOK_MEDIA_INLINE_MAX_BYTES (0 = never inline media).
 */
const DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES = 1024 * 1024;

/**
 * How long shutdown waits for in-flight direct deliveries (and their dead-letter bookkeeping) to
 * finish before abandoning them. Default 5s; override with WEBHOOK_SHUTDOWN_DRAIN_MS.
 */
const DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS = 5000;

/** Per-event-occurrence context threaded through the dispatch pipeline stages (was closure state). */
interface DispatchEventContext {
  sessionId: string;
  event: string;
  baseData: Record<string, unknown>;
}

@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookService');
  private readonly queueEnabled: boolean;
  private readonly dispatchLimiter: ConcurrencyLimiter;
  private cleanupTimer?: ReturnType<typeof setInterval>;
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
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
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
      await this.delay(Math.min(50, remaining));
    }
    for (const lost of this.inFlightDeliveries.values()) {
      this.logger.error('Webhook delivery abandoned during shutdown', undefined, {
        ...lost,
        action: 'webhook_delivery_abandoned_shutdown',
      });
    }
    this.inFlightDeliveries.clear();
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
    // Per-session fan-out cap. Soft by design: a concurrent create can race the count check — the
    // cap bounds amplification, it is not a hard invariant. Webhooks already above the cap are left
    // alone; only NEW registrations are refused.
    const maxPerSession = this.configService.get<number>('webhook.maxPerSession', DEFAULT_WEBHOOK_MAX_PER_SESSION);
    if (maxPerSession > 0) {
      const existing = await this.webhookRepository.count({ where: { sessionId } });
      if (existing >= maxPerSession) {
        throw new BadRequestException(
          `Webhook limit reached for this session (${existing}/${maxPerSession}); delete one before registering another`,
        );
      }
    }
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
        ? this.shedInlineMedia(
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
    try {
      return await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      return [];
    }
  }

  private filterMatchingWebhooks(webhooks: Webhook[], event: string, data: Record<string, unknown>): Webhook[] {
    // Resolve a lid actor to its phone through the persistent table so a phone filter matches a
    // lid-addressed sender (e.g. an unresolved @lid group participant). Absent store -> no resolution.
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.getCached(userPart(jid)) ?? null;
    return webhooks.filter(
      w => (w.events.includes(event) || w.events.includes('*')) && evaluateFilters(w.filters, event, data, resolveLid),
    );
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
  ): Promise<{ finalPayload: WebhookPayload; body: string; headers: Record<string, string> } | null> {
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
        return null;
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
        const shedData = this.shedInlineMedia(finalPayload.data, 0);
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

  private async deliverOne(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
    const preflight = await this.preflightDelivery(webhook, deliveryId, idempotencyKey, ctx);
    if (!preflight) {
      return;
    }
    const { finalPayload, body, headers } = preflight;
    // Use queue if available, otherwise fallback to direct delivery
    if (this.queueEnabled && this.webhookQueue) {
      await this.enqueueWithFallback(webhook, finalPayload, body, headers, deliveryId, idempotencyKey, ctx);
    } else {
      await this.deliverDirect(webhook, finalPayload, body, headers, deliveryId, ctx);
    }
  }

  private async enqueueWithFallback(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    headers: Record<string, string>,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
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
      }
    }
  }

  /** Direct delivery when the queue is disabled. */
  private async deliverDirect(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    headers: Record<string, string>,
    deliveryId: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
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
    }
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
        await this.delay(delay * attempt);
        return this.deliverWebhook(webhook, payload, headers, body, attempt + 1);
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
   * Replace an over-size inline base64 blob on `data.media` with the engine's omitted-marker shape
   * ({ mimetype, filename?, omitted: true, sizeBytes }) — the same contract the inbound media cap
   * and the status store already emit — so the multi-MB blob is never cloned per webhook, queued
   * into Redis, or POSTed. Returns the ORIGINAL object when nothing was shed (zero-copy fast path);
   * otherwise a shallow copy with only `media` replaced, so the caller's event data is never
   * mutated. `maxBytes` compares against the DECODED size; 0 sheds any inline blob.
   */
  private shedInlineMedia(data: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
    if (!data || typeof data !== 'object') return data;
    const media = data.media as
      { mimetype?: unknown; filename?: unknown; data?: unknown; omitted?: unknown } | undefined;
    if (!media || typeof media !== 'object' || typeof media.data !== 'string' || media.data.length === 0) {
      return data;
    }
    const sizeBytes = Buffer.byteLength(media.data, 'base64');
    if (sizeBytes <= maxBytes) return data;
    return {
      ...data,
      media: {
        mimetype: media.mimetype,
        ...(typeof media.filename === 'string' ? { filename: media.filename } : {}),
        omitted: true,
        sizeBytes,
      },
    };
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
