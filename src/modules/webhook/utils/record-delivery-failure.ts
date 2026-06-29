import { Repository } from 'typeorm';
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
 * Append a durable record of a webhook delivery that exhausted all retries. Called from BOTH terminal
 * paths — the BullMQ processor's final attempt and the direct-fallback's last attempt. Wrapped in its
 * own try/catch: persisting the failure is best-effort bookkeeping and must never throw back into (and
 * re-poison) the delivery result or the fire-and-forget dispatch loop.
 */
export async function recordWebhookDeliveryFailure(
  repo: Repository<WebhookDeliveryFailure>,
  logger: ErrorLogger,
  input: WebhookDeliveryFailureInput,
): Promise<void> {
  try {
    await repo.insert({ ...input, lastStatusCode: input.lastStatusCode ?? null });
  } catch (err) {
    logger.error(
      'Failed to persist webhook delivery-failure record',
      err instanceof Error ? err.message : String(err),
      { webhookId: input.webhookId, deliveryId: input.deliveryId, action: 'webhook_failure_record_error' },
    );
  }
}
