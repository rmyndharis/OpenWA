import { Injectable, NotFoundException, BadRequestException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, In, LessThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { Session } from '../session/entities/session.entity';
import { CreateWebhookDto, UpdateWebhookDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { resolveSessionScope } from '../../common/security/session-scope';
import { ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import {
  assertSafeFetchUrl,
  withSafeFetch,
  isSsrfProtectionEnabled,
  SsrfBlockedError,
  SSRF_BLOCKED_CLIENT_MESSAGE,
  redactSsrfError,
} from '../../common/security/ssrf-guard';
import { WebhookDeliveryService, WebhookPayload } from './webhook-delivery.service';

// Delivery-engine types (payload and queue job shapes) live on WebhookDeliveryService; re-exported
// here so existing importers (the queue processor) keep a single stable path.
export type { WebhookPayload, WebhookJobData } from './webhook-delivery.service';

/**
 * Upper bound on how many webhooks one session can register. One inbound event fans out to EVERY
 * registered webhook of the session, so an unbounded count multiplies per-event payload copies
 * (clones, outbound sockets, queued jobs). Default 16; override with WEBHOOK_MAX_PER_SESSION
 * (0 disables). Only NEW registrations above the cap are refused — existing ones are grandfathered.
 */
const DEFAULT_WEBHOOK_MAX_PER_SESSION = 16;

/**
 * Webhook registration and operational queries: CRUD, the test probe, and the delivery-failure
 * listing/retention. Event delivery itself (fan-out, queueing, retries, dead-lettering) lives on
 * WebhookDeliveryService; dispatch() here is the stable facade every event producer calls.
 */
@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookService');
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly configService: ConfigService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

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
    // Credentials embedded in the URL (https://user:pass@host/hook) would be persisted with the row
    // and echoed into delivery logs and dead-letter rows, and are never legitimate for a webhook
    // target — reject outright rather than strip-and-accept. Runs regardless of the SSRF flag.
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      // Unparseable: @IsUrl on the DTO (and the SSRF guard when enabled) owns that rejection.
    }
    if (parsed && (parsed.username !== '' || parsed.password !== '')) {
      throw new BadRequestException('Webhook URL must not contain credentials (userinfo)');
    }
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
    // The webhooks.sessionId FK makes a missing session surface as a driver error (500) at save time;
    // check first so the caller gets a truthful 404 for a session that does not exist.
    const sessionExists = await this.sessionRepository.exists({ where: { id: sessionId } });
    if (!sessionExists) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
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

    const saved = await this.webhookRepository.save(webhook);
    this.delivery.invalidateWebhooks(sessionId);
    return saved;
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
    // `id` tiebreaks the second-resolution `createdAt` so a paged walk has a total order.
    const options: FindManyOptions<Webhook> = {
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    };
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
      // A receiver outage writes a burst of failures inside one second; `id` keeps the page order total.
      order: { createdAt: 'DESC', id: 'DESC' },
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

    const saved = await this.webhookRepository.save(webhook);
    this.delivery.invalidateWebhooks(sessionId);
    return saved;
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const webhook = await this.findOne(sessionId, id);
    await this.webhookRepository.remove(webhook);
    this.delivery.invalidateWebhooks(sessionId);
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
      ...this.delivery.sanitizeCustomHeaders(webhook.headers),
      'Content-Type': 'application/json',
      'User-Agent': 'OpenWA-Webhook/1.0.0',
      'X-OpenWA-Event': 'test',
      'X-OpenWA-Idempotency-Key': testPayload.idempotencyKey,
      'X-OpenWA-Delivery-Id': testPayload.deliveryId,
      'X-OpenWA-Retry-Count': '0',
    };

    if (webhook.secret) {
      headers['X-OpenWA-Signature'] = this.delivery.generateSignature(body, webhook.secret);
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

  /** Delivery facade: same entry point event producers have always called; the engine lives on WebhookDeliveryService. */
  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    await this.delivery.dispatch(sessionId, event, data);
  }
}
