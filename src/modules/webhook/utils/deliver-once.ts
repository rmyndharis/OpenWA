import * as crypto from 'crypto';
import { Repository } from 'typeorm';
import { withSafeFetch, redactSsrfError, isSsrfProtectionEnabled } from '../../../common/security/ssrf-guard';
import { type LoggerService } from '../../../common/services/logger.service';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

/**
 * Drop operator-supplied custom headers that target the names the system sets (Content-Type,
 * User-Agent or any X-OpenWA-* header, in any spelling) so a webhook config cannot forge the
 * signature/event/idempotency headers. Dropping, not overriding, is what makes the system value
 * win: the HTTP client joins a case variant with the system one instead of replacing it.
 * Connection-level and framing headers are dropped too: the HTTP client owns them, undici throws on
 * several (failing every delivery) and a wrong Content-Length breaks the request.
 */
export function sanitizeCustomHeaders(custom: Record<string, string> | null | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (
      !/^(content-type|x-openwa-)/i.test(key) &&
      !/^(user-agent|connection|content-length|expect|keep-alive|te|trailer|transfer-encoding|upgrade)$/i.test(key)
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Whether a webhook row as read now may still receive `event`: it exists, is active and subscribes to
 * the event or to '*'. Its filters are not re-applied here, since they need the event data. Every
 * path that delivers after the dispatch moment (a queued job, a direct retry, an outbox replay) runs
 * this against a fresh row, so a removed, disabled or unsubscribed webhook stops receiving the event.
 */
export function isDeliverableWebhook<T extends { active: boolean; events: string[] }>(
  row: T | null | undefined,
  event: string,
): row is T {
  return !!row && row.active && (row.events.includes(event) || row.events.includes('*'));
}

/** HMAC-SHA256 over the exact pre-serialized body, prefixed for receiver-side verification. */
export function generateSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * The headers of one delivery attempt: the webhook's custom headers first, then the system headers
 * (which always win), then the signature over `body` when the webhook has a secret. Built from the
 * webhook row in hand, so a caller holding a fresh row sends its current headers and secret.
 */
export function buildDeliveryHeaders(
  webhook: { headers?: Record<string, string> | null; secret?: string | null },
  event: string,
  idempotencyKey: string,
  deliveryId: string,
  body: string,
  retryCount = 0,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...sanitizeCustomHeaders(webhook.headers),
    'Content-Type': 'application/json',
    'User-Agent': 'OpenWA-Webhook/1.0.0',
    'X-OpenWA-Event': event,
    'X-OpenWA-Idempotency-Key': idempotencyKey,
    'X-OpenWA-Delivery-Id': deliveryId,
    'X-OpenWA-Retry-Count': String(retryCount),
  };
  if (webhook.secret) {
    headers['X-OpenWA-Signature'] = generateSignature(body, webhook.secret);
  }
  return headers;
}

/**
 * One SSRF-guarded POST + response classification: a non-ok status throws `HTTP <status>: <statusText>`,
 * ok returns the status. This is the byte-level delivery core BOTH paths previously duplicated line
 * for line; extracting it keeps the two sinks one contract: same fetch, same guard, same error
 * shape, same timeout knob.
 */
export async function postWebhookPayload(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetch: typeof withSafeFetch = withSafeFetch,
): Promise<{ status: number; statusText: string }> {
  const { ok, status, statusText } = await fetch(
    url,
    {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    },
    response => ({ ok: response.ok, status: response.status, statusText: response.statusText }),
    { guard: isSsrfProtectionEnabled() },
  );
  if (!ok) throw new Error(`HTTP ${status}: ${statusText}`);
  return { status, statusText };
}

/**
 * Record a terminal webhook delivery failure (all retries exhausted) to the durable table. Shared
 * wrapper so both paths write the identical row shape. Best-effort: never throws back into the
 * delivery result (the caller's semantics depend on that). Returns false when an identical failure
 * was already recorded, so the caller can keep the failure metric in step with the table.
 */
export async function recordTerminalFailure(
  failureRepository: Repository<WebhookDeliveryFailure>,
  logger: LoggerService,
  input: Omit<Parameters<typeof recordWebhookDeliveryFailure>[2], 'lastStatusCode' | 'lastError'> & { error: unknown },
): Promise<boolean> {
  const { error, ...row } = input;
  const errMessage = redactSsrfError(error);
  return recordWebhookDeliveryFailure(failureRepository, logger, {
    ...row,
    lastStatusCode: statusCodeFromError(errMessage),
    lastError: errMessage,
  });
}
