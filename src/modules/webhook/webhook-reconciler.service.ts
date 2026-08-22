import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
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
 * The sweep CLAIMS each row before replaying it — an optimistic CAS on the observed attempts count
 * inside countAttempt(), not a lock — so N nodes sweeping one database replay each stranded row
 * once per pass instead of N times. There is no held lock to die with: a claimer that crashes
 * mid-flight has merely spent one attempt, and the row (still 'pending') is claimed again next
 * pass. Delivery stays at-least-once end to end, and the replay still carries the stored
 * idempotency key — the header receivers dedup on — for every duplicate that remains possible.
 */
@Injectable()
export class WebhookReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookReconcilerService');
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @InjectRepository(Webhook, 'data') private readonly webhooks: Repository<Webhook>,
    private readonly outbox: WebhookOutboxService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  onModuleInit(): void {
    const opts = resolveWebhookReconcilerOptions();
    if (opts.intervalMs <= 0) {
      this.logger.log('Webhook delivery reconciler disabled (WEBHOOK_RECONCILE_INTERVAL_MS <= 0)');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep(opts).catch(err =>
        this.logger.error('Webhook reconcile sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, opts.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One bounded pass over the stranded backlog. Overlap-guarded. */
  async sweep(opts: WebhookReconcilerOptions, now: Date = new Date()): Promise<WebhookReconcileStats> {
    const stats: WebhookReconcileStats = { scanned: 0, replayed: 0, failed: 0, skipped: 0 };
    if (this.sweeping) return stats;
    this.sweeping = true;
    try {
      const rows = await this.outbox.findStale(new Date(now.getTime() - opts.graceMs), opts.batchSize);
      stats.scanned = rows.length;
      for (const row of rows) {
        if (row.attempts >= opts.maxAttempts) {
          // Budget spent: stop replaying and leave the failure row as the recovery path.
          await this.outbox.close(row.webhookId, row.idempotencyKey, 'failed');
          stats.failed++;
          continue;
        }
        const webhook = await this.webhooks.findOne({ where: { id: row.webhookId } });
        if (!webhook || !webhook.active) {
          // The subscription is gone or switched off; replaying it would deliver an event the
          // operator has already unsubscribed from.
          await this.outbox.close(row.webhookId, row.idempotencyKey, 'failed');
          stats.skipped++;
          continue;
        }
        // The attempt count doubles as the row claim (a CAS on the observed attempts): when several
        // nodes sweep one database, exactly one wins each row and the rest skip it.
        if (!(await this.outbox.countAttempt(row.id, row.attempts))) {
          stats.skipped++;
          continue;
        }
        try {
          await this.delivery.redeliver(webhook, row.sessionId, row.event, row.idempotencyKey, row.payload);
          await this.outbox.close(row.webhookId, row.idempotencyKey, 'dispatched');
          stats.replayed++;
        } catch (error) {
          // Left 'pending' on purpose: the next sweep retries it until the budget is spent.
          this.logger.warn(`Replay of ${row.event} to webhook ${row.webhookId} failed: ${String(error)}`);
          stats.failed++;
        }
      }
    } finally {
      this.sweeping = false;
    }
    return stats;
  }
}
