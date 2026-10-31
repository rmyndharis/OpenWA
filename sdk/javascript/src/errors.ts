/**
 * Typed error hierarchy for the OpenWA SDK.
 *
 * The OpenWA API returns NestJS-default errors of the shape:
 *   `{ statusCode: number, message: string | string[], error?: string }`
 * `error` is absent whenever the exception carried no explicit message, so it is never required to
 * recognise the envelope. This module maps that to a typed, ergonomic error tree so callers can
 * `instanceof`-check or branch on `.status`.
 *
 * @packageDocumentation
 */

/** Base class for every error thrown by the SDK. */
export class OpenWAError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenWAError';
  }
}

/**
 * Thrown when the API responds with a non-2xx status. Carries the HTTP status
 * code and the parsed error body (or the raw text if the body was not JSON).
 *
 * Use the static {@link OpenWAApiError.fromResponse} factory in most cases.
 */
export class OpenWAApiError extends OpenWAError {
  /** HTTP status code (e.g. 400, 404, 409, 429, 501). */
  readonly status: number;
  /** Parsed JSON body if available, otherwise the raw response text. */
  readonly body: unknown;
  /** Value of the `error` field in the NestJS error envelope, if present. */
  readonly errorKind?: string;
  /** The body's machine-readable `code` (e.g. `SEND_PACING_LIMITED`), if the body carries one. */
  readonly code?: string;
  /**
   * Seconds to wait before retrying: the body's `retryAfterSeconds` when present, else the
   * `Retry-After` response header (seconds or an HTTP date). Undefined when neither is sent. A longer
   * wait is reported as 2147483 (about 24.8 days), the most `setTimeout` accepts once multiplied by 1000.
   */
  readonly retryAfterSeconds?: number;
  /** The response headers, when the error came from a response. */
  readonly headers?: Headers;

  constructor(message: string, status: number, body: unknown, errorKind?: string, headers?: Headers) {
    super(message);
    this.name = 'OpenWAApiError';
    this.status = status;
    this.body = body;
    this.errorKind = errorKind;
    this.headers = headers;
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (typeof fields.code === 'string') this.code = fields.code;
    this.retryAfterSeconds = retryAfterSeconds(fields.retryAfterSeconds, headers?.get('retry-after'));
  }

  /** Build an {@link OpenWAApiError} from a fetch Response, awaiting its body. */
  static async fromResponse(res: Response, context: string): Promise<OpenWAApiError> {
    // An opaque unfollowed redirect (we set `redirect: 'manual'`) surfaces as status 0, not a 3xx.
    // Give it a clear message instead of "OpenWA API 0": the redirect was deliberately not followed
    // so the API key is never re-sent to the redirect target.
    if (res.status === 0) {
      return new OpenWAApiError(
        `Unexpected redirect (not followed; the API key is never re-sent to a redirect target) — ${context}`,
        0,
        undefined,
      );
    }
    let body: unknown = undefined;
    // An unreadable body leaves only the status to report, but an abort is the client timeout
    // firing mid-read: rethrow it so the caller sees OpenWATimeoutError, not this status.
    const text = await res.text().catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      return '';
    });
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const env = isNestEnvelope(body) ? body : undefined;
    const messageText = describeMessage(env?.message ?? body ?? res.statusText);
    const message = `OpenWA API ${res.status} ${res.statusText} — ${context}: ${messageText}`;
    return new OpenWAApiError(message, res.status, body, env?.error, res.headers);
  }
}

/** 401 Unauthorized — missing or invalid API key. */
export class OpenWAAuthError extends OpenWAApiError {}
/**
 * 403 Forbidden: the API key's role or scope (session, IP or chat allow-list) refuses the call, or
 * WhatsApp itself refused the operation (for example, missing group admin rights).
 */
export class OpenWAForbiddenError extends OpenWAApiError {}
/** 404 Not Found. */
export class OpenWANotFoundError extends OpenWAApiError {}
/** 409 Conflict: a conflicting state, typically a session that is not ready for the operation, or a keyed send that is pending or may already have been sent (see `code`). */
export class OpenWAConflictError extends OpenWAApiError {}
/**
 * 429 Too Many Requests: rate limited. The global rate limiter's 429 lifts when its window
 * expires (seconds for the per-second tier, up to an hour for the hourly tier by default), and
 * `retryAfterSeconds` carries its `Retry-After` header. A 429 with `code: 'SEND_PACING_LIMITED'` is
 * usually not transient: do not retry it before `retryAfterSeconds`, which then comes from the body:
 * a few seconds when only sends still in flight caused it, the rest of the failure breaker's cooldown
 * (`SEND_PACING_BREAKER_COOLDOWN_MS`, 15 minutes by default) after a run of send failures, otherwise
 * up to the next UTC day.
 */
export class OpenWARateLimitError extends OpenWAApiError {}
/** 501 Not Implemented — the active engine does not support this operation. */
export class OpenWANotImplementedError extends OpenWAApiError {}

/**
 * 503 Service Unavailable: the gateway could not complete the request right now. The path to
 * WhatsApp failed (WhatsApp never replied, the socket was down, or the request budget ran out), the
 * gateway is draining or short of a dependency, or, on Baileys, WhatsApp itself throttled (code 429)
 * or timed out (code 408) the request; a throttle or timeout names its code in the message.
 * **Retryable**, but back off and retry later instead of at once: repeating a throttled request
 * straight away prolongs the throttle. A catalog 503 can persist because WhatsApp may never answer
 * that query, so bound any retry.
 *
 * On a send or a single write, a throttle turned the request away before it ran, so nothing was
 * sent or applied. A send also sent nothing when its recipient lookup failed, its connection closed
 * before the message was written, or its media or preview image URL could not be fetched through
 * the session's proxy. Each of these frees a keyed send's `Idempotency-Key` for the retry. A group
 * settings update with several fields applies them one at a time, so a 503 on a later field, a
 * throttle included, leaves the earlier ones applied; the message lists them after
 * `already applied:`, so re-read the settings before retrying, or send one field per request. Any
 * other timeout proves nothing: the write may still have been applied, and a keyed send keeps its key
 * taken. The non-idempotent sends (group create, channel create, media send) are deliberately left
 * unbounded by the gateway so a slow WhatsApp reply never answers one, and in a multi-node
 * deployment a forward that fails before reaching the owner node answers 503. A 503 from the owner
 * itself is relayed unchanged and keeps its meaning, so a bounded write such as a group, channel,
 * contact or profile change that timed out may still have been applied; re-read the state before
 * repeating it. A forward that fails after the request was sent answers 502 or 504 instead (a plain
 * `OpenWAApiError`): the owner may already have carried it out, so do not repeat a non-idempotent
 * send on those unchecked.
 */
export class OpenWAServiceUnavailableError extends OpenWAApiError {}

/** Thrown when a request exceeds the configured timeout. */
export class OpenWATimeoutError extends OpenWAError {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'OpenWATimeoutError';
  }
}

/**
 * Construct the most specific {@link OpenWAApiError} subclass for a status code.
 * Falls back to the generic {@link OpenWAApiError} for unmapped statuses.
 */
export function classifyApiError(
  status: number,
  message: string,
  body: unknown,
  errorKind?: string,
  headers?: Headers,
): OpenWAApiError {
  switch (status) {
    case 401:
      return new OpenWAAuthError(message, status, body, errorKind, headers);
    case 403:
      return new OpenWAForbiddenError(message, status, body, errorKind, headers);
    case 404:
      return new OpenWANotFoundError(message, status, body, errorKind, headers);
    case 409:
      return new OpenWAConflictError(message, status, body, errorKind, headers);
    case 429:
      return new OpenWARateLimitError(message, status, body, errorKind, headers);
    case 501:
      return new OpenWANotImplementedError(message, status, body, errorKind, headers);
    case 503:
      return new OpenWAServiceUnavailableError(message, status, body, errorKind, headers);
    default:
      return new OpenWAApiError(message, status, body, errorKind, headers);
  }
}

/**
 * The body's `retryAfterSeconds` wins: send pacing puts its wait (possibly hours) only there, and a
 * header added by a proxy must not shorten it. Otherwise read `Retry-After` as seconds or an HTTP
 * date, clamped at 0.
 */
function retryAfterSeconds(fromBody: unknown, header: string | null | undefined): number | undefined {
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
    return capSeconds(Math.ceil(fromBody));
  }
  const value = header?.trim();
  if (!value) return undefined;
  // A digit string past Number's range reads as Infinity, which the cap brings back to the ceiling.
  if (/^\d+$/.test(value)) return capSeconds(Number(value));
  // Date.parse also accepts '-5' or '1.5' as a past date, which would read as "retry now".
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : capSeconds(Math.max(0, Math.ceil((at - Date.now()) / 1000)));
}

/** setTimeout fires at once for a delay over 2^31-1 ms, so a longer wait would turn `seconds * 1000` into a retry now. */
const MAX_RETRY_AFTER_SECONDS = 2_147_483;

function capSeconds(seconds: number): number {
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Narrow the NestJS error envelope shape: `{ statusCode, message, error }`.
 *
 * `error` is optional. NestJS omits it whenever the exception was constructed without an explicit
 * message — which is what the global ValidationPipe does under `disableErrorMessages`, the default
 * when `NODE_ENV=production` and `VALIDATION_ERROR_DETAIL` is unset. Every rejected request in a
 * stock production deployment therefore answers `{ statusCode, message }` and nothing else.
 */
interface NestErrorEnvelope {
  statusCode: number;
  message: string | string[];
  error?: string;
}

function isNestEnvelope(body: unknown): body is NestErrorEnvelope {
  return typeof body === 'object' && body !== null && 'statusCode' in body && 'message' in body;
}

function describeMessage(message: string | string[] | unknown): string {
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message === 'string') return message;
  // A body without the envelope, such as the readiness 503's `{ status, details }`. It came from
  // JSON.parse, so it always stringifies.
  if (typeof message === 'object' && message !== null) return JSON.stringify(message);
  return String(message);
}
