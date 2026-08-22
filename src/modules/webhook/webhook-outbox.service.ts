import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';
import { WebhookOutboxEvent, WebhookOutboxState } from './entities/webhook-outbox-event.entity';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';

const DEFAULT_OUTBOX_RETENTION_DAYS = 7;

/** What a replay needs to redispatch one delivery without deriving a new idempotency key. */
export interface ReplayableDelivery {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Row lifecycle for the outbound delivery record.
 *
 * Every write here is best-effort and swallowed: fan-out is fire-and-forget from the projector, so
 * a repository failure must not turn into an unhandled rejection or stop a delivery that would
 * otherwise succeed. Losing the record degrades to the behaviour that existed before it.
 */
@Injectable()
export class WebhookOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookOutboxService');
  private pruneTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(WebhookOutboxEvent, 'data')
    private readonly outbox: Repository<WebhookOutboxEvent>,
  ) {}

  /**
   * Prune settled rows daily, so the record of every delivery this gateway ever made does not
   * become the largest table in the database.
   *
   * Deliberately NOT tied to the delivery-failure retention switch: a settled row carries no
   * payload and no audit value (the failure table is the record that matters), so letting an
   * operator opt into unbounded growth here buys nothing. A non-positive value falls back to the
   * default with a warning, the same call the ingress dedup log makes.
   *
   * Only SETTLED rows are pruned. A 'pending' row is a delivery that can still be replayed, and
   * deleting one on age would discard the very thing this table exists to protect.
   */
  onModuleInit(): void {
    const parsed = Number.parseInt(process.env.WEBHOOK_OUTBOX_RETENTION_DAYS ?? '', 10);
    let days = Number.isInteger(parsed) ? parsed : DEFAULT_OUTBOX_RETENTION_DAYS;
    if (days <= 0) {
      this.logger.warn(
        `WEBHOOK_OUTBOX_RETENTION_DAYS=${String(process.env.WEBHOOK_OUTBOX_RETENTION_DAYS)} would let the ` +
          `outbound delivery record grow without bound; falling back to ${DEFAULT_OUTBOX_RETENTION_DAYS} days`,
      );
      days = DEFAULT_OUTBOX_RETENTION_DAYS;
    }
    const run = (): void => {
      this.pruneSettled(days)
        .then(n => {
          if (n > 0) this.logger.log(`Pruned ${n} settled outbound delivery record(s) older than ${days} day(s)`);
        })
        .catch(err => this.logger.error('Outbound delivery record prune failed', String(err)));
    };
    run();
    this.pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
    this.pruneTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  /** Delete settled rows older than the window. Returns the number removed. */
  async pruneSettled(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.outbox.delete({ state: Not('pending'), createdAt: LessThan(cutoff) });
    return result.affected || 0;
  }

  /**
   * Record the delivery as pending, before anything durable owns it.
   *
   * A conflict on (webhookId, idempotencyKey) means this exact delivery is being replayed, so the
   * existing row is kept rather than duplicated: the stored key is what makes the retry
   * deduplicable at the receiver.
   */
  async open(row: Omit<ReplayableDelivery, 'id' | 'attempts'> & { deliveryId: string }): Promise<void> {
    try {
      await this.outbox.save(
        this.outbox.create({
          webhookId: row.webhookId,
          sessionId: row.sessionId,
          event: row.event,
          idempotencyKey: row.idempotencyKey,
          deliveryId: row.deliveryId,
          payload: row.payload,
          state: 'pending',
          attempts: 0,
        }),
      );
    } catch (error) {
      // A conflict means this exact delivery is already recorded, which is what a replay looks
      // like: keep the existing row rather than duplicating it.
      if (isUniqueViolation(error)) return;
      this.logger.warn(`Could not record outbound delivery ${row.deliveryId}: ${String(error)}`);
    }
  }

  /**
   * Record the outcome and retire the payload.
   *
   * `dispatched` covers both modes: handed to the queue, or completed inline. A failure INSIDE
   * either owner dead-letters through webhook_delivery_failures, so a dispatched row is never the
   * reconciler's concern, and retiring on ENQUEUE is what stops the reconciler duplicating work
   * BullMQ already holds.
   */
  async close(webhookId: string, idempotencyKey: string, state: Exclude<WebhookOutboxState, 'pending'>): Promise<void> {
    try {
      await this.outbox.update({ webhookId, idempotencyKey }, { state, payload: null, lastAttemptAt: new Date() });
    } catch (error) {
      this.logger.warn(`Could not close outbound delivery record: ${String(error)}`);
    }
  }

  /** Pending rows older than the staleness window, oldest first. Only these are replayable. */
  async findStale(olderThan: Date, limit: number): Promise<ReplayableDelivery[]> {
    const rows = await this.outbox.find({
      where: { state: 'pending', createdAt: LessThan(olderThan) },
      order: { createdAt: 'ASC' },
      take: limit,
    });
    // A pending row always carries its payload; the guard is for a row whose payload was retired by
    // a concurrent close between the query and this read.
    return rows
      .filter((r): r is WebhookOutboxEvent & { payload: Record<string, unknown> } => r.payload !== null)
      .map(r => ({
        id: r.id,
        webhookId: r.webhookId,
        sessionId: r.sessionId,
        event: r.event,
        idempotencyKey: r.idempotencyKey,
        payload: r.payload,
        attempts: r.attempts,
      }));
  }

  /** Count one replay attempt against the row's budget. */
  /**
   * Count a replay attempt — and CLAIM the row doing it. The WHERE carries the attempts value the
   * sweep OBSERVED, so when two nodes sweep the same backlog against one database, exactly one
   * increment matches and the loser sees `false` and skips the row. This is what turned the sweep's
   * documented "two nodes can both replay the same delivery" from deliberate simplicity into a
   * claimed pass: same at-least-once guarantee, without the N× duplicate replays under N api pods.
   */
  async countAttempt(id: string, attempts: number): Promise<boolean> {
    try {
      const result = await this.outbox.update(
        { id, attempts },
        { attempts: attempts + 1, lastAttemptAt: new Date() },
      );
      return (result.affected ?? 0) > 0;
    } catch (error) {
      this.logger.warn(`Could not count a replay attempt: ${String(error)}`);
      // An errored count must not spend the budget silently NOR double-deliver eagerly: without
      // knowing whether the increment landed, refusing the claim is the at-most-once-per-sweep side.
      return false;
    }
  }
}
