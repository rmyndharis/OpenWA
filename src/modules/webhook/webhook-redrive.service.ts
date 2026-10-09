import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { isDeliverableWebhook } from './utils/deliver-once';
import { resolveSessionScope } from '../../common/security/session-scope';
import { createLogger } from '../../common/services/logger.service';

/** Rows replayed per call when the caller names no limit, and the most one call will take. */
export const DEFAULT_WEBHOOK_REDRIVE_LIMIT = 100;
export const MAX_WEBHOOK_REDRIVE_LIMIT = 500;

/**
 * Replays run this many at a time. Each direct replay is one POST bounded by WEBHOOK_TIMEOUT, so a
 * full batch against a receiver that times out finishes in about limit / 4 timeouts rather than
 * limit of them, without opening a socket per row.
 */
const REDRIVE_CONCURRENCY = 4;

export interface WebhookRedriveRequest {
  sessionId?: string;
  webhookId?: string;
  ids?: string[];
  limit?: number;
}

export interface WebhookRedriveResult {
  /** Rows delivered by this call. */
  redriven: number;
  /** Delivered by a direct POST; their failure rows are gone. */
  delivered: number;
  /** Reserved for compatibility; operator redrive always uses a direct POST and returns zero. */
  enqueued: number;
  /** The replay failed again; the row stays, with its attempt count raised. */
  failed: number;
  /** Not replayed: the webhook was removed, disabled or unsubscribed, or a plugin cancelled it. */
  skipped: number;
  /** Replayable rows still in scope after this call. */
  remaining: number;
}

/**
 * Operator redrive of lost outbound webhook deliveries: the outbound twin of the integration
 * RedriveService. A terminal row of webhook_delivery_failures keeps the pre-hook event data while
 * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0; this replays those rows through
 * WebhookDeliveryService.redeliver with the STORED idempotency key, so a receiver that already
 * processed the event (the POST timed out after it was handled) dedups the replay instead of
 * acting twice. `webhook:before` hooks run again, as on a reconciler replay.
 *
 * A replay that succeeds removes its own row (the delivery path clears every failure row of the
 * key). One that fails again keeps the row: the recorder files one row per lost delivery, so the
 * replay only raises its attempt count.
 */
@Injectable()
export class WebhookRedriveService implements OnModuleDestroy {
  private readonly logger = createLogger('WebhookRedrive');
  /**
   * One redrive at a time on this node, so two overlapping calls (a double click, a retrying script)
   * do not replay the same rows side by side. Across nodes a duplicate replay carries the same
   * idempotency key, which the receiver dedups on.
   */
  private running: Promise<unknown> = Promise.resolve();
  // Aborted on destroy: a batch in progress takes no further row.
  private readonly stop = new AbortController();

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly delivery: WebhookDeliveryService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * A redrive runs inside an admitted HTTP request, which shutdown lets finish, and its replays hold
   * no dispatch slot, so the delivery drain neither waits for nor stops them. Left alone it would go
   * on POSTing after PluginLoaderService has unregistered the `webhook:before` hooks, sending the
   * stored pre-hook data. Stop at the next row and wait for the replays in hand: this module is
   * destroyed before the global plugin module, so those still run with their hooks. Rows not reached
   * stay for a later call and are counted in `remaining`.
   */
  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    await this.running;
  }

  redrive(request: WebhookRedriveRequest, allowedSessions?: string[] | null): Promise<WebhookRedriveResult> {
    const run = this.running.then(() => this.redriveBatch(request, allowedSessions));
    // The chain must survive a failed batch, or every later call would inherit its rejection.
    this.running = run.catch(() => undefined);
    return run;
  }

  private async redriveBatch(
    request: WebhookRedriveRequest,
    allowedSessions?: string[] | null,
  ): Promise<WebhookRedriveResult> {
    const result: WebhookRedriveResult = {
      redriven: 0,
      delivered: 0,
      enqueued: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    };
    // The calling key's allowedSessions is authoritative; the body's sessionId may only narrow it.
    const sessionScope = resolveSessionScope(allowedSessions, request.sessionId);
    if (sessionScope !== null && sessionScope.length === 0) return result;
    const retentionHours = this.configService.get<number>('webhook.failurePayloadRetentionHours', 0);
    if (retentionHours <= 0 || request.ids?.length === 0) return result;

    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
    // Join eligible subscriptions before taking a batch. A single membership predicate also avoids
    // an OR expression and repeated ids parameters for every active webhook across all sessions.
    const subscriptions =
      this.failureRepository.manager.connection.options.type === 'postgres'
        ? "json_array_elements_text(CASE WHEN json_typeof(webhook.events::json) = 'array' THEN webhook.events::json ELSE '[]'::json END) AS subscribed(event)"
        : "json_each(CASE WHEN json_type(webhook.events) = 'array' THEN webhook.events ELSE '[]' END) AS subscribed";
    const subscribedEvent =
      this.failureRepository.manager.connection.options.type === 'postgres' ? 'subscribed.event' : 'subscribed.value';
    const query = this.failureRepository
      .createQueryBuilder('failure')
      .innerJoin(
        Webhook,
        'webhook',
        'CAST(webhook.id AS text) = failure.webhookId AND CAST(webhook.sessionId AS text) = failure.sessionId',
      )
      .where({
        attempts: MoreThan(0),
        payload: Not(IsNull()),
        idempotencyKey: Not(IsNull()),
        createdAt: MoreThan(cutoff),
        ...(request.ids ? { id: In(request.ids) } : {}),
        ...(sessionScope ? { sessionId: In(sessionScope) } : {}),
        ...(request.webhookId ? { webhookId: request.webhookId } : {}),
      })
      .andWhere('webhook.active = :active', { active: true })
      .andWhere(`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscribedEvent} IN ('*', failure.event))`);
    const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_WEBHOOK_REDRIVE_LIMIT), MAX_WEBHOOK_REDRIVE_LIMIT);
    // A call still queued when shutdown starts reads no rows (or their payloads); it only counts them.
    const rows = this.stop.signal.aborted
      ? []
      : await query
          .clone()
          // `payload` is select: false on the entity; replay explicitly reads it.
          .addSelect('failure.payload')
          // Failed replays move behind rows with fewer attempts, so a bad receiver cannot pin a batch.
          .orderBy('failure.attempts', 'ASC')
          .addOrderBy('failure.createdAt', 'ASC')
          .addOrderBy('failure.id', 'ASC')
          .take(limit)
          .getMany();

    if (rows.length > 0) {
      const webhookIds = [...new Set(rows.map(r => r.webhookId))];
      const webhooks = new Map(
        (await this.webhookRepository.find({ where: { id: In(webhookIds) } })).map(w => [w.id, w] as const),
      );
      const queue = [...rows];
      const worker = async (): Promise<void> => {
        for (let row = queue.shift(); row && !this.stop.signal.aborted; row = queue.shift()) {
          await this.redriveRow(row, webhooks.get(row.webhookId) ?? null, result);
        }
      };
      await Promise.all(Array.from({ length: Math.min(REDRIVE_CONCURRENCY, rows.length) }, worker));
    }

    result.redriven = result.delivered + result.enqueued;
    result.remaining = await query.clone().getCount();
    return result;
  }

  private async redriveRow(
    row: WebhookDeliveryFailure,
    webhook: Webhook | null,
    result: WebhookRedriveResult,
  ): Promise<void> {
    // The row's own session must still own the webhook: a row is never replayed into another session.
    if (!webhook || webhook.sessionId !== row.sessionId || !isDeliverableWebhook(webhook, row.event)) {
      result.skipped++;
      return;
    }
    try {
      const outcome = await this.delivery.redeliver(
        webhook,
        row.sessionId,
        row.event,
        row.idempotencyKey,
        row.payload ?? {},
        { singleAttempt: true },
      );
      if (outcome === 'delivered') result.delivered++;
      else if (outcome === 'enqueued') result.enqueued++;
      else if (outcome === 'cancelled') result.skipped++;
      else {
        result.failed++;
        // Terminal failures update their own attempt count in the shared recorder.
        if (outcome !== 'failed') await this.bumpAttempts(row);
      }
    } catch (error) {
      result.failed++;
      this.logger.error('Webhook redrive failed', error instanceof Error ? error.message : String(error), {
        webhookId: row.webhookId,
        failureId: row.id,
        action: 'webhook_redrive_error',
      });
      await this.bumpAttempts(row);
    }
  }

  /** Count the failed replay on the row. Best-effort: the row is already on record either way. */
  private async bumpAttempts(row: WebhookDeliveryFailure): Promise<void> {
    try {
      await this.failureRepository.increment({ id: row.id }, 'attempts', 1);
    } catch (error) {
      this.logger.warn('Could not record a failed webhook redrive on its row', {
        failureId: row.id,
        error: error instanceof Error ? error.message : String(error),
        action: 'webhook_redrive_bookkeeping_failed',
      });
    }
  }
}
