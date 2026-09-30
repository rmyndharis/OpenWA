import { MoreThan, Repository } from 'typeorm';
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
 * Append a durable record of a webhook delivery that exhausted all retries. Called from BOTH terminal
 * paths — the BullMQ processor's final attempt and the direct-fallback's last attempt. Wrapped in its
 * own try/catch: persisting the failure is best-effort bookkeeping and must never throw back into (and
 * re-poison) the delivery result or the fire-and-forget dispatch loop.
 */
export async function recordWebhookDeliveryFailure(
  repo: Repository<WebhookDeliveryFailure>,
  logger: ErrorLogger,
  input: WebhookDeliveryFailureInput,
): Promise<boolean> {
  try {
    // One row per lost delivery, not one per attempt. The reconciler replays a pending outbox row
    // up to its budget and every failed replay arrives here, so without this guard a single lost
    // event is reported to the operator as several and counted that many times in the failure
    // metric. An absent idempotencyKey carries no identity to dedupe on, so it is always appended.
    // A terminal row (attempts > 0) is deduplicated only against other terminal rows: an attempts-0
    // row (a shed or shutdown-refused dispatch) is replaced by it below instead of suppressing it.
    const terminal = input.attempts > 0;
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
          await clearDeliveryFailureRows(repo, logger, input.webhookId, input.idempotencyKey, true);
        }
        return false;
      }
    }
    await repo.insert({ ...input, lastStatusCode: input.lastStatusCode ?? null });
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
    // The delivery really did fail; only the bookkeeping did. Report it as recorded so the metric
    // still counts the loss rather than hiding it behind a database problem.
    return true;
  }
}
