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
   * `Retry-After` response header (seconds or an HTTP date). Undefined when neither is sent.
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
    const text = await res.text().catch(() => '');
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
/** 403 Forbidden: the API key's role or scope (session, IP or chat allow-list) refuses the call. */
export class OpenWAForbiddenError extends OpenWAApiError {}
/** 404 Not Found. */
export class OpenWANotFoundError extends OpenWAApiError {}
/** 409 Conflict — typically an {@link EngineNotReadyError} from the backend. */
export class OpenWAConflictError extends OpenWAApiError {}
/**
 * 429 Too Many Requests: rate limited. The global rate limiter's 429 lifts when its window
 * expires (seconds for the per-second tier, up to an hour for the hourly tier by default), and
 * `retryAfterSeconds` carries its `Retry-After` header. A 429 with `code: 'SEND_PACING_LIMITED'` is
 * not transient: do not retry it before `retryAfterSeconds`, which then comes from the body and can
 * be hours.
 */
export class OpenWARateLimitError extends OpenWAApiError {}
/** 501 Not Implemented — the active engine does not support this operation. */
export class OpenWANotImplementedError extends OpenWAApiError {}

/**
 * 503 Service Unavailable — a transport failure, not a refusal. The gateway answers this when the
 * engine did not confirm the operation in time: WhatsApp never replied, the socket was down, or the
 * request budget ran out. **Retryable**, but a catalog 503 can persist because WhatsApp may never
 * answer that query, so bound any retry.
 *
 * Not every 503 is safe to repeat blindly: the non-idempotent sends (group create, channel create,
 * media send) are deliberately left unbounded by the gateway so a slow WhatsApp reply never answers
 * one, and in a multi-node deployment a forwarded request answers 503 only when the owner node was
 * never reached. A forward that fails after the request was sent answers 502 or 504 instead (a plain
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
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody);
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  // Date.parse also accepts '-5' or '1.5' as a past date, which would read as "retry now".
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
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
