import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { And, EntityManager, In, IsNull, LessThan, Not, QueryDeepPartialEntity, Raw, Repository } from 'typeorm';
import { WebhookOutboxEvent, WebhookOutboxState } from './entities/webhook-outbox-event.entity';
import type { MessageEngineRef } from '../message/entities/message.entity';
import { createLogger } from '../../common/services/logger.service';
import { SHUTDOWN_MAINTENANCE_WAIT_MS } from '../../common/services/shutdown-budget';
import { pruneInBatches } from '../../common/utils/batched-prune';
import { startGuardedInterval } from '../../common/utils/guarded-interval';
import { isTransientDbError, isUniqueViolation } from '../../common/utils/db-errors';

const DEFAULT_OUTBOX_RETENTION_DAYS = 7;
const DEFAULT_OUTBOX_PRUNE_MAX_ROWS = 100_000;
/**
 * Delay before the next prune pass when one stopped at its cap. Without it an installation that settles more
 * than one pass's worth of rows a day never catches up, and the table grows without bound.
 */
const CAPPED_PRUNE_FOLLOW_UP_MS = 60_000;
/** Upper bound on waiting for an active outbox prune pass during shutdown. */
const OUTBOX_PRUNE_SHUTDOWN_WAIT_MS = SHUTDOWN_MAINTENANCE_WAIT_MS;
/**
 * Maximum outbox rows inserted per statement: 10 bound parameters per row yields at most 900
 * variables per query, safely below SQLite's 999 bind limit and PostgreSQL's 65535 limit.
 */
export const OUTBOX_OPEN_BATCH_CHUNK_SIZE = 90;

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
export type OutboxOpenRow = Omit<ReplayableDelivery, 'id' | 'attempts'> & {
  deliveryId: string;
  /** What the engine reported of the message a delivery carries, when a handler filed it elsewhere (see the entity). */
  engineRef?: MessageEngineRef | null;
};

/** Whether the webhook of a delivery still takes a copy of the message once a change rewrote it (its filters). */
export type MessageCopyFilter = (
  delivery: { webhookId: string; event: string },
  payload: Record<string, unknown>,
) => boolean | Promise<boolean>;

/**
 * Whether a copy of a message (an outbox payload, a kept failure payload) takes a change: judged by its payload, or by
 * `engineRef`, what the engine reported of the message, when a handler filed it elsewhere.
 */
export type MessageCopyPredicate = (
  payload: Record<string, unknown>,
  engineRef?: MessageEngineRef | null,
) => boolean | Promise<boolean>;

/** States in which a row still holds a copy that can be delivered: before dispatch, or owned by a queued job. */
const OPEN_STATES: WebhookOutboxState[] = ['pending', 'queued'];

/** The events whose deliveries carry a message, keyed `msg_<session>_<message id>_<webhook>`. */
export const MESSAGE_DELIVERY_EVENTS = ['message.received', 'message.sent'];

/**
 * The delivery keys of one message: a LIKE pattern (escaped, used with `ESCAPE '\'`) and the exact key of each
 * webhook's delivery, which the pattern alone cannot give, as another message id may start with this one.
 */
export function messageDeliveryKeys(
  sessionId: string,
  waMessageId: string,
): { pattern: string; keyFor: (webhookId: string) => string } {
  const prefix = `msg_${sessionId}_${waMessageId}_`;
  return { pattern: `${prefix.replace(/[\\%_]/g, ch => `\\${ch}`)}%`, keyFor: webhookId => `${prefix}${webhookId}` };
}

/**
 * The keys of a message's message.edited deliveries, one per edit occurrence (`edit_<session>_<id><occurrence>` per
 * webhook): a LIKE pattern (escaped, used with `ESCAPE '\'`). Another message's id can start with this one, so a copy
 * is the message's only where its payload names it in `messageId`.
 */
export function messageEditKeys(sessionId: string, waMessageId: string): string {
  return `${`edit_${sessionId}_${waMessageId}`.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
}

/** Events that carry a change of a message (an edit), which name it in `messageId` and are withdrawn with it. */
export const MESSAGE_CHANGE_EVENTS = ['message.edited'];

/** A message's delivery data once it was deleted through the API: the placeholder, without its content. */
export function redactedMessagePayload(payload: Record<string, unknown>): Record<string, unknown> {
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
  } = payload;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return { ...kept, body: '', type: 'revoked' };
}

/** A message's delivery data once its sender edited it; a deleted message's placeholder takes no edit. */
export function editedMessagePayload(payload: Record<string, unknown>, body: string): Record<string, unknown> {
  return payload.type === 'revoked' ? payload : { ...payload, body, edited: true };
}

/** What a change of a message does to a copy of it: an engine revoke drops it, a delete redacts it, an edit rewrites it. */
export type MessageCopyChange = { kind: 'close' } | { kind: 'redact' } | { kind: 'rewrite'; body: string };

/** A copy of a message's delivery data as `change` leaves it; null once it is dropped. */
export function changedMessagePayload(
  payload: Record<string, unknown>,
  change: MessageCopyChange,
): Record<string, unknown> | null {
  if (change.kind === 'close') return null;
  return change.kind === 'redact' ? redactedMessagePayload(payload) : editedMessagePayload(payload, change.body);
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
  private stopPruneInterval?: () => void;
  private pruneFollowUp?: ReturnType<typeof setTimeout>;
  private readonly pruneMaxRows = DEFAULT_OUTBOX_PRUNE_MAX_ROWS;
  private readonly inFlightPrunes = new Set<Promise<unknown>>();
  private stopped = false;
  // Row id to the time it may be read again, for rows whose stored payload could not be read.
  private readonly unreadableUntil = new Map<string, number>();

  // The delivery key, less its webhook, of each message with a change kept on this node that touches its copies.
  private readonly heldMessages = new Set<string>();

  constructor(
    @InjectRepository(WebhookOutboxEvent, 'data')
    private readonly outbox: Repository<WebhookOutboxEvent>,
  ) {}

  /**
   * A change that withdraws or rewrites the message's copies is kept on this node until the database answers (`held`),
   * or no longer is. Until it is written, none of the message's deliveries goes out from this node with the copy its
   * outbox row holds: the sweep replays none, a direct retry waits, and so does a queued job, spending no attempt.
   */
  holdMessage(sessionId: string, waMessageId: string, held: boolean): void {
    const key = messageDeliveryKeys(sessionId, waMessageId).keyFor('');
    if (held) this.heldMessages.add(key);
    else this.heldMessages.delete(key);
  }

  /** True while a change of the message a delivery key of this webhook names is held on this node (holdMessage). */
  isMessageHeld(idempotencyKey: string, webhookId: string): boolean {
    return (
      this.heldMessages.size > 0 &&
      idempotencyKey.endsWith(`_${webhookId}`) &&
      this.heldMessages.has(idempotencyKey.slice(0, -webhookId.length))
    );
  }

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
    const onError = (err: unknown): void => this.logger.error('Outbound delivery record prune failed', String(err));
    const run = async (): Promise<void> => {
      const n = await this.pruneSettled(days);
      if (n > 0) this.logger.log(`Pruned ${n} settled outbound delivery record(s) older than ${days} day(s)`);
      if (n >= this.pruneMaxRows && !this.stopped) {
        this.logger.warn('Outbound delivery record prune hit its cap; expired rows remain, running again shortly', {
          action: 'webhook_outbox_prune_capped',
        });
        clearTimeout(this.pruneFollowUp);
        this.pruneFollowUp = setTimeout(() => void run().catch(onError), CAPPED_PRUNE_FOLLOW_UP_MS);
        this.pruneFollowUp.unref?.();
      }
    };
    this.stopPruneInterval = startGuardedInterval(run, 24 * 60 * 60 * 1000, onError);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.stopPruneInterval?.();
    this.stopPruneInterval = undefined;
    clearTimeout(this.pruneFollowUp);
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

  /**
   * Delete settled rows (indexed) and bounded legacy null-state rows older than the window. Returns the number removed.
   * A call while a pass is running returns 0: the follow-up of a capped pass and the daily one never run at once.
   */
  async pruneSettled(olderThanDays: number, maxRows = this.pruneMaxRows): Promise<number> {
    if (this.stopped || maxRows <= 0 || this.inFlightPrunes.size > 0) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const task = (async (): Promise<number> => {
      const settled = { state: In(['dispatched', 'delivered', 'failed']), createdAt: LessThan(cutoff) };
      const settledDeleted = await pruneInBatches({
        repository: this.outbox,
        where: { ...settled, engineRef: IsNull() },
        maxRows,
        stopped: () => this.stopped,
      });
      let remaining = Math.max(0, maxRows - settledDeleted);
      if (remaining <= 0 || this.stopped) return settledDeleted;
      // The row of a message a handler filed elsewhere stays while a failed delivery keeps a copy of it: a change of the
      // message reaches that copy by what the row says the engine reported. Few rows have one, so only looked for then.
      const moved = { ...settled, engineRef: Not(IsNull()) };
      const hasMoved = typeof this.outbox.exists === 'function' && (await this.outbox.exists({ where: moved }));
      const movedDeleted = hasMoved
        ? await pruneInBatches({
            repository: this.outbox,
            where: {
              ...moved,
              idempotencyKey: Raw(
                key =>
                  `NOT EXISTS (SELECT 1 FROM "webhook_delivery_failures" "kept" WHERE "kept"."idempotencyKey" = ${key} AND "kept"."payload" IS NOT NULL)`,
              ),
            },
            maxRows: remaining,
            stopped: () => this.stopped,
          })
        : 0;
      remaining -= movedDeleted;
      if (remaining <= 0 || this.stopped) return settledDeleted + movedDeleted;
      // Avoid a full empty-result find() pass on Postgres/SQLite when no legacy NULL-state rows exist.
      const hasLegacyNulls =
        typeof this.outbox.exists === 'function'
          ? await this.outbox.exists({ where: { state: IsNull(), createdAt: LessThan(cutoff) } })
          : true;
      if (!hasLegacyNulls || this.stopped) return settledDeleted + movedDeleted;
      const legacyDeleted = await pruneInBatches({
        repository: this.outbox,
        where: { state: IsNull(), createdAt: LessThan(cutoff) },
        maxRows: remaining,
        stopped: () => this.stopped,
      });
      return settledDeleted + movedDeleted + legacyDeleted;
    })();
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
        engineRef: row.engineRef ?? null,
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
                engineRef: row.engineRef ?? null,
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
              engineRef: row.engineRef ?? null,
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
   * Update the stored payload of an already-committed outbox row, pending or queued (for example, when an
   * edit or REST revoke changes a message between DB commit and live dispatch). Best-effort.
   */
  async updatePendingPayload(
    webhookId: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await this.outbox.update(
        { webhookId, idempotencyKey, state: In(OPEN_STATES), payload: Not(IsNull()) },
        { payload } as QueryDeepPartialEntity<WebhookOutboxEvent>,
      );
      return (result.affected ?? 0) > 0;
    } catch (error) {
      this.logger.warn(`Could not update pending outbound delivery payload: ${String(error)}`);
      return false;
    }
  }

  /**
   * Close all still-open outbox rows for one message (`message.received` / `message.sent`) when
   * an engine revoke arrives, even if the engine retired or crashed before live dispatch, so the
   * reconciler can never replay unredacted revoked content. A queued row is closed too: its job reads
   * the row before posting and finds nothing to send. Matches exact `msg_<session>_<id>_<wh>`
   * keys so LIKE wildcards or prefix-sharing message ids cannot match unrelated rows. When
   * `shouldApply` is supplied, only rows whose stored payload satisfies the predicate are closed.
   */
  async closePendingForMessage(
    sessionId: string,
    waMessageId: string,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    await this.changeOpenForMessage(sessionId, waMessageId, { kind: 'close' }, shouldApply).catch((error: unknown) =>
      this.logger.warn(`Could not close pending outbound deliveries for message ${waMessageId}: ${String(error)}`),
    );
  }

  /**
   * Apply a change of a message to its still-open outbox rows (see closePendingForMessage, redactPendingForMessage,
   * rewritePendingForMessage), each judged by `shouldApply` on its payload. Throws when the database fails, for a
   * caller that keeps the change to try again.
   */
  async changeOpenForMessage(
    sessionId: string,
    waMessageId: string,
    change: MessageCopyChange,
    shouldApply?: MessageCopyPredicate,
    passes?: MessageCopyFilter,
  ): Promise<void> {
    if (!waMessageId) return;
    // A message taken back (by an engine revoke or a delete through the API) takes its edit events with it: each is an
    // occurrence of its own, so an edit rewrites none of them, and a redacted one would read as an edit to empty.
    if (change.kind !== 'rewrite') await this.closeOpenEditsForMessage(sessionId, waMessageId, shouldApply);
    const rows = await this.findPendingForMessage(sessionId, waMessageId);
    const matching: WebhookOutboxEvent[] = [];
    for (const row of rows) {
      if (!row.payload || (shouldApply && !(await shouldApply(row.payload, row.engineRef)))) continue;
      matching.push(row);
    }
    if (matching.length === 0) return;
    if (change.kind === 'close') {
      await this.outbox.update(
        { id: In(matching.map(row => row.id)), state: In(OPEN_STATES) },
        { state: 'dispatched', payload: null, lastAttemptAt: new Date() },
      );
      return;
    }
    for (const row of matching) {
      const payload = changedMessagePayload(row.payload!, change);
      // A copy its webhook's filters no longer take is closed, as a delivery they refuse is never opened.
      const closed = payload && passes && !(await passes(row, payload));
      await this.outbox.update(
        { id: row.id, state: In(OPEN_STATES), payload: Not(IsNull()) },
        (closed
          ? { state: 'dispatched', payload: null, lastAttemptAt: new Date() }
          : { payload }) as QueryDeepPartialEntity<WebhookOutboxEvent>,
      );
    }
  }

  /** Close the still-open message.edited rows of a message (see {@link messageEditKeys}) its copies would take. */
  private async closeOpenEditsForMessage(
    sessionId: string,
    waMessageId: string,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    if (typeof this.outbox.createQueryBuilder !== 'function') return;
    const rows = await this.outbox
      .createQueryBuilder('o')
      .where('o.sessionId = :sessionId', { sessionId })
      .andWhere('o.event IN (:...events)', { events: MESSAGE_CHANGE_EVENTS })
      .andWhere('o.state IN (:...states)', { states: OPEN_STATES })
      .andWhere('o.payload IS NOT NULL')
      .andWhere("o.idempotencyKey LIKE :pattern ESCAPE '\\'", { pattern: messageEditKeys(sessionId, waMessageId) })
      .addSelect('o.engineRef')
      .getMany();
    const matching: string[] = [];
    for (const row of rows) {
      if (row.payload?.messageId !== waMessageId) continue;
      if (shouldApply && !(await shouldApply(row.payload, row.engineRef))) continue;
      matching.push(row.id);
    }
    if (matching.length === 0) return;
    await this.outbox.update(
      { id: In(matching), state: In(OPEN_STATES) },
      { state: 'dispatched', payload: null, lastAttemptAt: new Date() },
    );
  }

  /**
   * Redact stored payloads on any still-open outbox rows for one message when a REST delete
   * clears the message without suppressing announcement (`announced=false`), so a crash or engine
   * retire before live dispatch can never replay the deleted content. A queued row keeps its state: its
   * job reads the row before posting and sends what the redaction left. When `shouldApply` is
   * supplied, only rows whose stored payload satisfies the predicate are redacted.
   */
  redactPendingForMessage(sessionId: string, waMessageId: string, shouldApply?: MessageCopyPredicate): Promise<void> {
    return this.changeOpenForMessage(sessionId, waMessageId, { kind: 'redact' }, shouldApply).catch((error: unknown) =>
      this.logger.warn(`Could not redact pending outbound deliveries for message ${waMessageId}: ${String(error)}`),
    );
  }

  /**
   * Write an edit of a stored message into the payloads of its still-open outbox rows, so the sweep, or the queued job
   * that reads its row before posting, delivers the edited text. Judged per payload like the redaction above.
   */
  rewritePendingForMessage(
    sessionId: string,
    waMessageId: string,
    body: string,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    return this.changeOpenForMessage(sessionId, waMessageId, { kind: 'rewrite', body }, shouldApply).catch(
      (error: unknown) =>
        this.logger.warn(`Could not rewrite pending outbound deliveries for message ${waMessageId}: ${String(error)}`),
    );
  }

  /** Find still-open message outbox rows whose idempotencyKey matches `msg_<session>_<waId>_<webhookId>`. */
  /**
   * What the engine reported of the message each delivery key carries, where a handler filed it elsewhere, for the
   * copies a failed delivery keeps. The outbox row stays while such a copy does (see pruneSettled).
   */
  async engineRefsFor(
    webhookKeys: ReadonlyArray<{ webhookId: string; idempotencyKey: string }>,
  ): Promise<Map<string, MessageEngineRef>> {
    const refs = new Map<string, MessageEngineRef>();
    if (webhookKeys.length === 0) return refs;
    const rows = await this.outbox.find({
      select: { webhookId: true, idempotencyKey: true, engineRef: true },
      where: { idempotencyKey: In(webhookKeys.map(k => k.idempotencyKey)), engineRef: Not(IsNull()) },
    });
    for (const row of rows) if (row.engineRef) refs.set(`${row.webhookId}\u0000${row.idempotencyKey}`, row.engineRef);
    return refs;
  }

  private async findPendingForMessage(sessionId: string, waMessageId: string): Promise<WebhookOutboxEvent[]> {
    const { pattern, keyFor } = messageDeliveryKeys(sessionId, waMessageId);
    const candidates =
      typeof this.outbox.createQueryBuilder === 'function'
        ? await this.outbox
            .createQueryBuilder('o')
            .where('o.sessionId = :sessionId', { sessionId })
            .andWhere('o.event IN (:...events)', { events: MESSAGE_DELIVERY_EVENTS })
            .andWhere('o.state IN (:...states)', { states: OPEN_STATES })
            .andWhere('o.payload IS NOT NULL')
            .andWhere("o.idempotencyKey LIKE :pattern ESCAPE '\\'", { pattern })
            .addSelect('o.engineRef')
            .getMany()
        : await this.outbox.find({
            where: {
              sessionId,
              event: In(MESSAGE_DELIVERY_EVENTS),
              state: In(OPEN_STATES),
              payload: Not(IsNull()),
            },
          });
    return candidates.filter(row => row.idempotencyKey === keyFor(row.webhookId));
  }

  /**
   * The event data the outbox row of a message delivery holds now: null once the row was closed (dispatched or failed:
   * the message was taken back, or the delivery settled elsewhere), undefined when the row says nothing either way
   * (another event's delivery, a row of another event under the same key, no row, a legacy row without a state, an
   * open row without a payload, or a payload that does not parse). Throws when the database cannot be read: a caller
   * that cannot tell whether the message was taken back must not send it on a guess.
   */
  async currentMessagePayload(
    webhookId: string,
    idempotencyKey: string,
    event: string,
  ): Promise<Record<string, unknown> | null | undefined> {
    if (!MESSAGE_DELIVERY_EVENTS.includes(event)) return undefined;
    let row: Pick<WebhookOutboxEvent, 'event' | 'state' | 'payload'> | null;
    try {
      row = await this.outbox.findOne({
        where: { webhookId, idempotencyKey },
        select: { event: true, state: true, payload: true },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'SyntaxError') return undefined;
      throw error;
    }
    if (!row || row.event !== event) return undefined;
    if (row.state === 'dispatched' || row.state === 'failed') return null;
    return row.state && OPEN_STATES.includes(row.state) && row.payload ? row.payload : undefined;
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
