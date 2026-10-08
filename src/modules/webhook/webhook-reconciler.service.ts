import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { isAbortedBackoff, WebhookDeliveryService } from './webhook-delivery.service';
import { isDeliverableWebhook } from './utils/deliver-once';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

export interface WebhookReconcilerOptions {
  /** 0 disables the sweep entirely. */
  intervalMs: number;
  /** How long a row may sit 'pending' before it counts as stranded rather than in flight. */
  graceMs: number;
  batchSize: number;
  /**
   * Replay budget per row. Past it the row is marked 'failed' and left alone: a stuck delivery must
   * not become an infinite replay loop, and the failure row is where recovery continues.
   */
  maxAttempts: number;
}

export function resolveWebhookReconcilerOptions(env: NodeJS.ProcessEnv = process.env): WebhookReconcilerOptions {
  const batch = Number(env.WEBHOOK_RECONCILE_BATCH_SIZE);
  const maxAttempts = Number(env.WEBHOOK_RECONCILE_MAX_ATTEMPTS);
  return {
    intervalMs: resolveNonNegativeIntEnv(env.WEBHOOK_RECONCILE_INTERVAL_MS, 60_000),
    graceMs: resolveNonNegativeIntEnv(env.WEBHOOK_RECONCILE_GRACE_MS, 60_000),
    batchSize: Number.isInteger(batch) && batch >= 1 ? batch : 50,
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : 5,
  };
}

export interface WebhookReconcileStats {
  scanned: number;
  replayed: number;
  failed: number;
  skipped: number;
}

/**
 * Closes the crash window on outbound webhook delivery.
 *
 * Fan-out is fire-and-forget from the projector, so before the outbox row existed a hard crash
 * between persisting a message and completing its POST lost the delivery with nothing left behind
 * in either mode, while the documented contract promises at-least-once. The row makes the intent
 * durable; this sweep is what turns durability into delivery.
 *
 * Mirrors IngressReconcilerService on the inbound side: an unref'd interval started on module init,
 * an overlap guard so a slow pass never stacks, a bounded batch, and a per-row replay budget.
 *
 * The sweep does NOT claim a row, so two nodes running against one database can both replay the
 * same delivery. That is deliberate and matches the inbound reconciler: the replay carries the
 * stored idempotency key, which is exactly the header a receiver dedups on, so the cost of the
 * race is a duplicate the contract already tells consumers to expect. Claiming would trade that
 * for a lock whose holder can die mid-flight.
 */
@Injectable()
export class WebhookReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookReconcilerService');
  private timer?: ReturnType<typeof setInterval>;
  // The pass in flight, settled when it ends; doubles as the overlap guard.
  private inFlight?: Promise<void>;
  // Aborted on destroy: stops the pass at the next row and the replay in hand before its next retry.
  // A row already past its last check, or a retry POST already started, still sends that one POST.
  private readonly stop = new AbortController();
  private cursor?: string;

  constructor(
    @InjectRepository(Webhook, 'data') private readonly webhooks: Repository<Webhook>,
    private readonly outbox: WebhookOutboxService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  onModuleInit(): void {
    const opts = resolveWebhookReconcilerOptions();
    if (opts.intervalMs <= 0) {
      this.logger.log('Webhook delivery reconciler disabled (WEBHOOK_RECONCILE_INTERVAL_MS=0)');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep(opts).catch(err =>
        this.logger.error('Webhook reconcile sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, opts.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Clearing the interval only stops the NEXT pass. A replay holds no dispatch slot, so the delivery
   * drain neither waits for nor stops a pass already running: it would go on POSTing after the drain,
   * and after PluginLoaderService has unregistered the `webhook:before` hooks. Stop it at the next row,
   * stop the replay in hand without a further retry, and wait for it.
   */
  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }

  /** One bounded pass over the stranded backlog. Overlap-guarded. */
  async sweep(opts: WebhookReconcilerOptions, now: Date = new Date()): Promise<WebhookReconcileStats> {
    const stats: WebhookReconcileStats = { scanned: 0, replayed: 0, failed: 0, skipped: 0 };
    if (this.inFlight || this.stop.signal.aborted) return stats;
    let settle!: () => void;
    this.inFlight = new Promise(resolve => (settle = resolve));
    try {
      const cutoff = new Date(now.getTime() - opts.graceMs);
      let rows = await this.outbox.findStale(cutoff, opts.batchSize, this.cursor);
      if (rows.length === 0 && this.cursor) {
        this.cursor = undefined;
        rows = await this.outbox.findStale(cutoff, opts.batchSize);
      }
      // Live jobs may occupy a whole page. Advance past them without spending their replay budget.
      this.cursor = rows.at(-1)?.id;
      stats.scanned = rows.length;
      for (const row of rows) {
        if (this.stop.signal.aborted) break;
        if (this.delivery.isLocallyPending(row.idempotencyKey)) {
          // Still owned by a dispatch on this node (parked in the limiter or mid retry loop), so it
          // is slow rather than stranded. Replaying it would POST alongside the original and outside
          // the dispatch concurrency bound, and would spend its budget while it is still running.
          stats.skipped++;
          continue;
        }
        const webhook = await this.webhooks.findOne({ where: { id: row.webhookId } });
        if (!isDeliverableWebhook(webhook, row.event, row.sessionId)) {
          // The subscription is gone, switched off or no longer lists this event; replaying it would
          // deliver an event the operator has already unsubscribed from. Same test as the queue
          // processor applies before every attempt.
          await this.outbox.close(row.webhookId, row.idempotencyKey, 'failed');
          stats.skipped++;
          continue;
        }
        if (row.deliveryId && (await this.delivery.isQueueJobPending(row.deliveryId))) {
          stats.skipped++;
          continue;
        }
        if (row.attempts >= opts.maxAttempts) {
          // A database fault may have prevented every terminal failure write. Keep the outbox
          // payload until this handoff succeeds, without sending beyond the replay budget.
          if (await this.delivery.recordReplayExhaustion(row, webhook.url)) {
            await this.outbox.close(row.webhookId, row.idempotencyKey, 'failed');
          }
          stats.failed++;
          continue;
        }
        // Shutdown may have begun during the lookups above; stop before spending budget or POSTing.
        if (this.stop.signal.aborted) break;
        if (!(await this.outbox.countAttempt(row.id, row.attempts))) {
          // Settled since the batch was read, typically a local dispatch that finished while an
          // earlier row in this pass was replaying. The copy in hand is stale; replaying it duplicates.
          stats.skipped++;
          continue;
        }
        try {
          // The outcome is a RETURN VALUE, not an exception. Every delivery failure is handled in
          // place (dead-letter row, hook, log), so redeliver resolves either way and a catch here
          // would see nothing: retiring on resolve alone marked dead-lettered events 'dispatched'
          // and nulled their payload, spending the whole budget on one sweep.
          const outcome = await this.delivery.redeliver(
            webhook,
            row.sessionId,
            row.event,
            row.idempotencyKey,
            row.payload,
            { signal: this.stop.signal },
          );
          if (outcome === 'failed' || outcome === 'unrecorded') {
            // Left 'pending' on purpose: the next sweep retries it until the budget is spent.
            this.logger.warn(`Replay of ${row.event} to webhook ${row.webhookId} did not deliver`);
            stats.failed++;
            continue;
          }
          // Enqueued rows retain their copy until the worker settles them. Success and deliberate
          // cancellation can retire immediately.
          if (outcome !== 'enqueued') await this.outbox.close(row.webhookId, row.idempotencyKey, 'dispatched');
          stats.replayed++;
        } catch (error) {
          // A replay cut short in its retry backoff by shutdown was interrupted, not failed. Any other
          // exception is an unexpected fault rather than a delivery failure. The row stays pending.
          if (isAbortedBackoff(error, this.stop.signal)) {
            this.logger.log(`Replay of ${row.event} to webhook ${row.webhookId} interrupted by shutdown`);
            stats.skipped++;
            continue;
          }
          this.logger.warn(`Replay of ${row.event} to webhook ${row.webhookId} failed: ${String(error)}`);
          stats.failed++;
        }
      }
    } finally {
      this.inFlight = undefined;
      settle();
    }
    return stats;
  }
}
