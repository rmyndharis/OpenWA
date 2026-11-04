import { IsNull, MoreThan, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/utils/db-errors';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';

export interface WebhookDeliveryFailureInput {
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  idempotencyKey?: string;
  deliveryId?: string;
  attempts: number;
  lastStatusCode?: number | null;
  lastError: string;
  /**
   * The pre-hook event data to keep for a later redrive. Passed only while
   * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0, and persisted only on a terminal row: an attempts-0
   * row keeps its outbox row pending, which already holds the same data for the reconciler.
   */
  payload?: Record<string, unknown> | null;
  /**
   * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS, passed with `payload`. A terminal row recorded without event data (while
   * retention was off) takes it on a repeat while the row is inside that window; past it, the prune clears event
   * data and none is put back.
   */
  payloadRetentionHours?: number;
}

/** Minimal logger shape — both WebhookProcessor and WebhookService pass their `createLogger` instance. */
interface ErrorLogger {
  error(message: string, ...meta: unknown[]): void;
}

/** Parse the HTTP status out of an `HTTP <code>: …` error message, else null (network/timeout/SSRF). */
export function statusCodeFromError(message: string): number | null {
  const m = /^HTTP (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/**
 * Remove the dead-letter rows of one delivery. Every successful POST calls this for its key, so a
 * delivered event is never listed as lost, whichever earlier dispatch of it was shed, refused or
 * failed. With `onlyUnattempted` it removes only the attempts-0 rows (shed, refused, preflight),
 * which the recorder does right after writing a terminal row, so the event always keeps a record.
 * Best-effort: a failed delete is logged and never fails the delivery that triggered it.
 */
export async function clearDeliveryFailureRows(
  repo: Repository<WebhookDeliveryFailure>,
  logger: ErrorLogger,
  webhookId: string,
  idempotencyKey: string | undefined,
  onlyUnattempted = false,
): Promise<void> {
  // Without a key there is no delivery identity to match, and deleting on webhookId alone would
  // erase the rows of every other lost event of that webhook.
  if (!idempotencyKey) return;
  try {
    await repo.delete(onlyUnattempted ? { webhookId, idempotencyKey, attempts: 0 } : { webhookId, idempotencyKey });
  } catch (err) {
    logger.error('Failed to clear webhook delivery-failure rows', err instanceof Error ? err.message : String(err), {
      webhookId,
      idempotencyKey,
      action: 'webhook_failure_clear_error',
    });
  }
}

/**
 * Record a webhook delivery that exhausted its retries (the BullMQ processor's final attempt, the direct
 * path's last attempt) or was not sent (attempts 0, from recordUndelivered: shed, refused at shutdown,
 * oversize or a preflight failure). Wrapped in its own try/catch: persisting the failure is best-effort
 * bookkeeping and must never throw back into (and re-poison) the delivery result or the fire-and-forget
 * dispatch loop. Returns true for a new row, false for an existing row, and null
 * when persistence failed.
 */
export async function recordWebhookDeliveryFailure(
  repo: Repository<WebhookDeliveryFailure>,
  logger: ErrorLogger,
  input: WebhookDeliveryFailureInput,
): Promise<boolean | null> {
  const terminal = input.attempts > 0;
  const refreshTerminal = async (): Promise<boolean | null> => {
    const updated = await repo.update(
      { webhookId: input.webhookId, idempotencyKey: input.idempotencyKey, attempts: MoreThan(0) },
      {
        url: input.url,
        lastError: input.lastError,
        deliveryId: input.deliveryId,
        attempts: () => `"attempts" + ${input.attempts}`,
        lastStatusCode: input.lastStatusCode ?? null,
      },
    );
    if (!updated.affected) return null;
    // The caller closes its replay copy after this record, so this is the event data's last chance to be kept.
    if (input.payload && input.payloadRetentionHours) {
      await repo.update(
        {
          webhookId: input.webhookId,
          idempotencyKey: input.idempotencyKey,
          attempts: MoreThan(0),
          payload: IsNull(),
          createdAt: MoreThan(new Date(Date.now() - input.payloadRetentionHours * 60 * 60 * 1000)),
        },
        { payload: input.payload } as QueryDeepPartialEntity<WebhookDeliveryFailure>,
      );
    }
    await clearDeliveryFailureRows(repo, logger, input.webhookId, input.idempotencyKey, true);
    return false;
  };
  try {
    // One row per lost delivery, not one per attempt. The reconciler replays a pending outbox row
    // up to its budget and every failed replay arrives here, so without this guard a single lost
    // event is reported to the operator as several and counted that many times in the failure
    // metric. An absent idempotencyKey carries no identity to dedupe on, so it is always appended.
    // A terminal row (attempts > 0) is deduplicated only against other terminal rows: an attempts-0
    // row (a shed or shutdown-refused dispatch) is replaced by it below instead of suppressing it.
    if (input.idempotencyKey) {
      const existing = await repo.count({
        where: terminal
          ? { webhookId: input.webhookId, idempotencyKey: input.idempotencyKey, attempts: MoreThan(0) }
          : { webhookId: input.webhookId, idempotencyKey: input.idempotencyKey },
      });
      if (existing > 0) {
        if (!terminal) {
          // An unsent delivery recorded again: typically a replay of a shed or refused dispatch that
          // then failed before sending (a payload over the size cap, or one that cannot be
          // serialized). Its reason is the one the operator has to act on now, so the attempts-0 row
          // takes it. A terminal row of the same delivery is left as it is.
          await repo
            .update(
              { webhookId: input.webhookId, idempotencyKey: input.idempotencyKey, attempts: 0 },
              {
                lastError: input.lastError,
                url: input.url,
                ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
              },
            )
            .catch((err: unknown) =>
              logger.error(
                'Failed to refresh the reason of an unsent webhook delivery',
                err instanceof Error ? err.message : String(err),
                {
                  webhookId: input.webhookId,
                  idempotencyKey: input.idempotencyKey,
                  action: 'webhook_failure_record_error',
                },
              ),
            );
        } else {
          // A crash or a failed delete right after an earlier terminal insert can leave the
          // attempts-0 row behind; nothing else reconciles it, so every repeat finishes the job.
          return await refreshTerminal();
        }
        return false;
      }
    }
    const { payload, ...row } = input;
    // The cast covers `payload` only: TypeORM's insert typing cannot see through a free-form JSON
    // record, while simple-json serializes it like the outbox payload.
    try {
      await repo.insert({
        ...row,
        lastStatusCode: input.lastStatusCode ?? null,
        ...(terminal && payload ? { payload } : {}),
      } as QueryDeepPartialEntity<WebhookDeliveryFailure>);
    } catch (error) {
      if (terminal && input.idempotencyKey && isUniqueViolation(error)) return await refreshTerminal();
      throw error;
    }
    if (terminal) {
      // Only after the insert, so a crash in between leaves both rows, never none. A later terminal
      // record of the same delivery repeats this clear.
      await clearDeliveryFailureRows(repo, logger, input.webhookId, input.idempotencyKey, true);
    }
    return true;
  } catch (err) {
    logger.error(
      'Failed to persist webhook delivery-failure record',
      err instanceof Error ? err.message : String(err),
      { webhookId: input.webhookId, deliveryId: input.deliveryId, action: 'webhook_failure_record_error' },
    );
    // No durable failure row owns the event. Callers must retain their replay copy.
    return null;
  }
}
