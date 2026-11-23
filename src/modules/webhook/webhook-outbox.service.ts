import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { And, EntityManager, In, IsNull, LessThan, Not, QueryDeepPartialEntity, Raw, Repository } from 'typeorm';
import { WebhookOutboxEvent, WebhookOutboxState } from './entities/webhook-outbox-event.entity';
import { createLogger } from '../../common/services/logger.service';
import { pruneInBatches } from '../../common/utils/batched-prune';
import { isTransientDbError, isUniqueViolation } from '../../common/utils/db-errors';

const DEFAULT_OUTBOX_RETENTION_DAYS = 7;
/** Upper bound on waiting for an active outbox prune pass during shutdown. */
const OUTBOX_PRUNE_SHUTDOWN_WAIT_MS = 1_000;
/**
 * Maximum outbox rows inserted per statement: 9 bound parameters per row yields at most 900
 * variables per query, safely below SQLite's 999 bind limit and PostgreSQL's 65535 limit.
 */
export const OUTBOX_OPEN_BATCH_CHUNK_SIZE = 100;

/**
 * How long a stranded delivery whose stored payload cannot be read is left out of the page reads, as the ingress sweep
 * does with its own. Held in memory: the row is not touched, and it is read again after the wait or a restart.
 */
export const OUTBOX_UNREADABLE_RETRY_MS = 60 * 60 * 1000;
const UNREADABLE_MAX = 1000;

/** What a replay needs to redispatch one delivery without deriving a new idempotency key. */
export interface ReplayableDelivery {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  deliveryId?: string;
  state?: WebhookOutboxState | null;
}

/** Input shape for opening a pending outbox row before delivery starts. */
export type OutboxOpenRow = Omit<ReplayableDelivery, 'id' | 'attempts'> & { deliveryId: string };

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
  private readonly inFlightPrunes = new Set<Promise<unknown>>();
  private stopped = false;
  // Row id to the time it may be read again, for rows whose stored payload could not be read.
  private readonly unreadableUntil = new Map<string, number>();

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

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.inFlightPrunes.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...this.inFlightPrunes]),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, OUTBOX_PRUNE_SHUTDOWN_WAIT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Delete settled and legacy null-state rows older than the window, a batch at a time. Returns the number removed. */
  async pruneSettled(olderThanDays: number): Promise<number> {
    if (this.stopped) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const task = pruneInBatches({
      repository: this.outbox,
      where: [
        { state: Not(In(['pending', 'queued'])), createdAt: LessThan(cutoff) },
        { state: IsNull(), createdAt: LessThan(cutoff) },
      ],
      stopped: () => this.stopped,
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.inFlightPrunes.add(settled);
    void settled.finally(() => this.inFlightPrunes.delete(settled));
    return task;
  }

  /**
   * Record the delivery as pending, before anything durable owns it.
   *
   * A conflict on (webhookId, idempotencyKey) means this exact delivery is being replayed, so the
   * existing row is kept rather than duplicated: the stored key is what makes the retry
   * deduplicable at the receiver.
   */
  async open(row: OutboxOpenRow): Promise<void> {
    try {
      // A bare INSERT, not save(): save() wraps it in a transaction, and on SQLite's single shared
      // connection the rollback of the unique violation expected here would also discard any other
      // write made while it was open.
      await this.outbox.insert({
        webhookId: row.webhookId,
        sessionId: row.sessionId,
        event: row.event,
        idempotencyKey: row.idempotencyKey,
        deliveryId: row.deliveryId,
        payload: row.payload,
        state: 'pending',
        attempts: 0,
      } as QueryDeepPartialEntity<WebhookOutboxEvent>);
    } catch (error) {
      // A conflict means this exact delivery is already recorded, which is what a replay looks
      // like: keep the existing row rather than duplicating it.
      if (isUniqueViolation(error)) return;
      this.logger.warn(`Could not record outbound delivery ${row.deliveryId}: ${String(error)}`);
    }
  }

  /**
   * Record a batch of outbound deliveries as pending using conflict-ignoring inserts
   * (`ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`) chunked to {@link OUTBOX_OPEN_BATCH_CHUNK_SIZE}
   * rows so duplicate `(webhookId, idempotencyKey)` entries never abort an enclosing PostgreSQL
   * transaction or trigger a SQLite shared-connection rollback, and large fan-out batches never
   * exceed SQL bind-parameter limits.
   *
   * When `manager` is provided, writes participate in the caller's transaction and non-conflict
   * errors propagate so the transaction rolls back atomically. Without `manager`, non-conflict
   * errors are logged and swallowed like `open()`, returning `null` so callers can distinguish
   * "standalone DB write failed (fail open)" from "all rows already existed (`[]`)".
   *
   * Returns the subset of input rows that were newly inserted, or `null` on a swallowed standalone
   * DB error.
   */
  async openBatch(rows: readonly OutboxOpenRow[], manager?: EntityManager): Promise<OutboxOpenRow[] | null> {
    if (rows.length === 0) return [];
    const execute = async (): Promise<OutboxOpenRow[]> => {
      const targetRepo = manager ? manager.getRepository(WebhookOutboxEvent) : this.outbox;
      if (!manager && typeof targetRepo.createQueryBuilder !== 'function') {
        await Promise.all(rows.map(row => this.open(row)));
        return [...rows];
      }
      const connection = manager?.connection ?? this.outbox.manager?.connection;
      const supportsReturning = connection?.driver?.isReturningSqlSupported?.('insert') === true;
      const inserted: OutboxOpenRow[] = [];

      for (let offset = 0; offset < rows.length; offset += OUTBOX_OPEN_BATCH_CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + OUTBOX_OPEN_BATCH_CHUNK_SIZE);
        const qb = manager ? manager.createQueryBuilder() : targetRepo.createQueryBuilder();
        if (supportsReturning) {
          const result = await qb
            .insert()
            .into(WebhookOutboxEvent)
            .values(
              chunk.map(row => ({
                webhookId: row.webhookId,
                sessionId: row.sessionId,
                event: row.event,
                idempotencyKey: row.idempotencyKey,
                deliveryId: row.deliveryId,
                payload: row.payload,
                state: 'pending' as const,
                attempts: 0,
              })) as QueryDeepPartialEntity<WebhookOutboxEvent>[],
            )
            .orIgnore()
            .returning(['webhookId', 'idempotencyKey'])
            .updateEntity(false)
            .execute();
          const insertedKeys = new Set(
            (Array.isArray(result.raw)
              ? (result.raw as Array<{ webhookId?: string; idempotencyKey?: string }>)
              : []
            ).map(r => `${r.webhookId ?? ''}\u0000${r.idempotencyKey ?? ''}`),
          );
          for (const row of chunk) {
            const key = `${row.webhookId}\u0000${row.idempotencyKey}`;
            if (!insertedKeys.has(key)) continue;
            insertedKeys.delete(key);
            inserted.push(row);
          }
          continue;
        }
        const tagged = chunk.map(row => ({ id: randomUUID(), row }));
        await qb
          .insert()
          .into(WebhookOutboxEvent)
          .values(
            tagged.map(({ id, row }) => ({
              id,
              webhookId: row.webhookId,
              sessionId: row.sessionId,
              event: row.event,
              idempotencyKey: row.idempotencyKey,
              deliveryId: row.deliveryId,
              payload: row.payload,
              state: 'pending' as const,
              attempts: 0,
            })) as QueryDeepPartialEntity<WebhookOutboxEvent>[],
          )
          .orIgnore()
          .updateEntity(false)
          .execute();
        if (typeof targetRepo.find !== 'function') {
          inserted.push(...chunk);
          continue;
        }
        const present = await targetRepo.find({
          select: { id: true },
          where: { id: In(tagged.map(t => t.id)) },
        });
        const insertedIds = new Set(present.map(r => r.id));
        for (const entry of tagged) {
          if (insertedIds.has(entry.id)) inserted.push(entry.row);
        }
      }
      return inserted;
    };

    if (manager) {
      return execute();
    }
    try {
      return await execute();
    } catch (error) {
      this.logger.warn(`Could not record ${rows.length} outbound delivery record(s): ${String(error)}`);
      return null;
    }
  }

  /**
   * Update the stored payload of an already-committed pending outbox row (for example, when an
   * edit or REST revoke changes a message between DB commit and live dispatch). Best-effort.
   */
  async updatePendingPayload(
    webhookId: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await this.outbox.update({ webhookId, idempotencyKey, state: 'pending', payload: Not(IsNull()) }, {
        payload,
      } as QueryDeepPartialEntity<WebhookOutboxEvent>);
      return (result.affected ?? 0) > 0;
    } catch (error) {
      this.logger.warn(`Could not update pending outbound delivery payload: ${String(error)}`);
      return false;
    }
  }

  /**
   * Close all still-pending outbox rows for one message (`message.received` / `message.sent`) when
   * an engine revoke arrives, even if the engine retired or crashed before live dispatch, so the
   * reconciler can never replay unredacted revoked content. Matches exact `msg_<session>_<id>_<wh>`
   * keys so LIKE wildcards or prefix-sharing message ids cannot match unrelated rows. When
   * `shouldApply` is supplied, only rows whose stored payload satisfies the predicate are closed.
   */
  async closePendingForMessage(
    sessionId: string,
    waMessageId: string,
    shouldApply?: (payload: Record<string, unknown>) => boolean | Promise<boolean>,
  ): Promise<void> {
    if (!waMessageId) return;
    try {
      const rows = await this.findPendingForMessage(sessionId, waMessageId);
      if (rows.length === 0) return;
      const matchingIds: string[] = [];
      for (const row of rows) {
        if (shouldApply) {
          if (!row.payload || !(await shouldApply(row.payload))) continue;
        }
        matchingIds.push(row.id);
      }
      if (matchingIds.length === 0) return;
      await this.outbox.update(
        { id: In(matchingIds), state: 'pending' },
        { state: 'dispatched', payload: null, lastAttemptAt: new Date() },
      );
    } catch (error) {
      this.logger.warn(`Could not close pending outbound deliveries for message ${waMessageId}: ${String(error)}`);
    }
  }

  /**
   * Redact stored payloads on any still-pending outbox rows for one message when a REST delete
   * clears the message without suppressing announcement (`announced=false`), so a crash or engine
   * retire before live dispatch can never replay the deleted content. When `shouldApply` is
   * supplied, only rows whose stored payload satisfies the predicate are redacted.
   */
  async redactPendingForMessage(
    sessionId: string,
    waMessageId: string,
    shouldApply?: (payload: Record<string, unknown>) => boolean | Promise<boolean>,
  ): Promise<void> {
    if (!waMessageId) return;
    try {
      const rows = await this.findPendingForMessage(sessionId, waMessageId);
      for (const row of rows) {
        if (!row.payload) continue;
        if (shouldApply && !(await shouldApply(row.payload))) continue;
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const {
          media,
          quotedMessage,
          call,
          buttons,
          button,
          location,
          order,
          product,
          poll,
          mentionedIds,
          isForwarded,
          forwardingScore,
          edited,
          ...kept
        } = row.payload;
        /* eslint-enable @typescript-eslint/no-unused-vars */
        const redacted = { ...kept, body: '', type: 'revoked' };
        await this.outbox.update({ id: row.id, state: 'pending', payload: Not(IsNull()) }, { payload: redacted });
      }
    } catch (error) {
      this.logger.warn(`Could not redact pending outbound deliveries for message ${waMessageId}: ${String(error)}`);
    }
  }

  /** Find still-pending message outbox rows whose idempotencyKey matches `msg_<session>_<waId>_<webhookId>`. */
  private async findPendingForMessage(sessionId: string, waMessageId: string): Promise<WebhookOutboxEvent[]> {
    const prefix = `msg_${sessionId}_${waMessageId}_`;
    const escapedPrefix = prefix.replace(/[\\%_]/g, ch => `\\${ch}`);
    const candidates =
      typeof this.outbox.createQueryBuilder === 'function'
        ? await this.outbox
            .createQueryBuilder('o')
            .where('o.sessionId = :sessionId', { sessionId })
            .andWhere('o.event IN (:...events)', { events: ['message.received', 'message.sent'] })
            .andWhere('o.state = :state', { state: 'pending' })
            .andWhere('o.payload IS NOT NULL')
            .andWhere("o.idempotencyKey LIKE :pattern ESCAPE '\\'", { pattern: `${escapedPrefix}%` })
            .getMany()
        : await this.outbox.find({
            where: {
              sessionId,
              event: In(['message.received', 'message.sent']),
              state: 'pending',
              payload: Not(IsNull()),
            },
          });
    return candidates.filter(row => row.idempotencyKey === `${prefix}${row.webhookId}`);
  }

  /** Retire replay data after successful delivery, cancellation or durable failure handoff. */
  async close(
    webhookId: string,
    idempotencyKey: string,
    state: Exclude<WebhookOutboxState, 'pending' | 'queued'>,
  ): Promise<void> {
    try {
      await this.outbox.update({ webhookId, idempotencyKey }, { state, payload: null, lastAttemptAt: new Date() });
    } catch (error) {
      this.logger.warn(`Could not close outbound delivery record: ${String(error)}`);
    }
  }

  /** Keep the queue's replay copy until the worker has settled the delivery. */
  async markQueued(webhookId: string, idempotencyKey: string, deliveryId: string): Promise<void> {
    try {
      await this.outbox.update(
        { webhookId, idempotencyKey, state: In(['pending', 'queued']), payload: Not(IsNull()) },
        { state: 'queued', deliveryId, lastAttemptAt: new Date() },
      );
    } catch (error) {
      this.logger.warn(`Could not record queued outbound delivery: ${String(error)}`);
    }
  }

  /** Revert a pre-enqueue 'queued' mark back to 'pending' when queue.add rejects, keeping deliveryId intact. */
  async markPending(webhookId: string, idempotencyKey: string, deliveryId: string): Promise<void> {
    try {
      await this.outbox.update(
        { webhookId, idempotencyKey, state: 'queued', deliveryId, payload: Not(IsNull()) },
        { state: 'pending' },
      );
    } catch (error) {
      this.logger.warn(`Could not revert queued outbound delivery: ${String(error)}`);
    }
  }

  /**
   * Unsettled rows older than the staleness window; queued jobs are checked before replay.
   *
   * A stored payload that does not parse (an imported or hand-edited row on SQLite, where it is text)
   * fails the read of every page it sits in, so no row behind it would ever be replayed. When the page
   * read fails it is read again row by row, an unreadable row is logged and skipped, and `onScanned`
   * receives the last id the page covered and how many ids it covered, so a caller's cursor passes the unreadable
   * rows too, and can tell a page that filled its batch from one that reached the end. A row whose payload cannot be
   * read stays out of the pages for {@link OUTBOX_UNREADABLE_RETRY_MS}, so it costs one read and one log line per wait
   * and not one per pass.
   */
  async findStale(
    olderThan: Date,
    limit: number,
    afterId?: string,
    onScanned?: (lastId: string, covered: number) => void,
  ): Promise<ReplayableDelivery[]> {
    const pending = { state: In(['pending', 'queued']), payload: Not(IsNull()), createdAt: LessThan(olderThan) };
    const stale = afterId
      ? {
          ...pending,
          // Compare in SQL so PostgreSQL's sub-millisecond timestamps are never rounded through Date.
          createdAt: And(
            LessThan(olderThan),
            Raw(
              alias =>
                `(${alias}, "id") > (SELECT "createdAt", "id" FROM "webhook_outbox_events" WHERE "id" = :afterId)`,
              { afterId },
            ),
          ),
        }
      : pending;
    const unreadable = this.unreadableIds(Date.now());
    const where = unreadable.length ? { ...stale, id: Not(In(unreadable)) } : stale;
    const order = { createdAt: 'ASC', id: 'ASC' } as const;
    let rows: WebhookOutboxEvent[];
    try {
      rows = await this.outbox.find({ where, order, take: limit });
    } catch (error) {
      this.logger.warn('Reading a page of stranded deliveries failed; reading it row by row', {
        error: error instanceof Error ? error.message : String(error),
        action: 'webhook_outbox_page_unreadable',
      });
      const ids = await this.outbox.find({ select: { id: true }, where, order, take: limit });
      rows = [];
      for (const { id } of ids) {
        try {
          const row = await this.outbox.findOneBy({ id });
          if (row) rows.push(row);
        } catch (rowError) {
          this.logger.error(
            'A stranded delivery could not be read and is skipped',
            rowError instanceof Error ? rowError.message : String(rowError),
            { id, action: 'webhook_outbox_row_unreadable' },
          );
          // Only a payload that does not parse is left out. A read that failed because the database said "not now" is
          // read again by the next pass. A SyntaxError is told by its class: its text quotes the start of the payload.
          if ((rowError instanceof Error && rowError.name === 'SyntaxError') || !isTransientDbError(rowError)) {
            this.leaveOut(id, Date.now());
          }
        }
      }
      const last = ids.at(-1);
      if (last) onScanned?.(last.id, ids.length);
    }
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
        deliveryId: r.deliveryId,
        state: r.state,
      }));
  }

  /** Ids of the rows to leave out of a page; forgets those whose time to be read again came. */
  private unreadableIds(now: number): string[] {
    for (const [id, until] of this.unreadableUntil) {
      if (until <= now) this.unreadableUntil.delete(id);
    }
    return [...this.unreadableUntil.keys()];
  }

  private leaveOut(id: string, now: number): void {
    this.unreadableUntil.delete(id);
    this.unreadableUntil.set(id, now + OUTBOX_UNREADABLE_RETRY_MS);
    // Oldest first, as the map keeps insertion order; a store with more of them than this is not one to leave alone,
    // and the oldest are read again.
    while (this.unreadableUntil.size > UNREADABLE_MAX) {
      this.unreadableUntil.delete(this.unreadableUntil.keys().next().value as string);
    }
  }

  /**
   * Count one replay attempt against the row's budget.
   *
   * Returns false when the row is no longer pending: the sweep reads its batch once, so a delivery
   * that settled after that read must not be replayed from the stale copy. A failed write returns
   * true, keeping the replay best-effort like every other write here.
   */
  async countAttempt(id: string, attempts: number): Promise<boolean> {
    try {
      const result = await this.outbox.update(
        { id, state: In(['pending', 'queued']) },
        { attempts: attempts + 1, lastAttemptAt: new Date() },
      );
      return (result.affected ?? 0) > 0;
    } catch (error) {
      this.logger.warn(`Could not count a replay attempt: ${String(error)}`);
      return true;
    }
  }
}
