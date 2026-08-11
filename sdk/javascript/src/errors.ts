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

  constructor(message: string, status: number, body: unknown, errorKind?: string) {
    super(message);
    this.name = 'OpenWAApiError';
    this.status = status;
    this.body = body;
    this.errorKind = errorKind;
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
    return new OpenWAApiError(message, res.status, body, env?.error);
  }
}

/** 401 Unauthorized — missing or invalid API key. */
export class OpenWAAuthError extends OpenWAApiError {}
/** 403 Forbidden — the API key's role is insufficient for this endpoint. */
export class OpenWAForbiddenError extends OpenWAApiError {}
/** 404 Not Found. */
export class OpenWANotFoundError extends OpenWAApiError {}
/** 409 Conflict — typically an {@link EngineNotReadyError} from the backend. */
export class OpenWAConflictError extends OpenWAApiError {}
/** 429 Too Many Requests — rate limited. */
export class OpenWARateLimitError extends OpenWAApiError {}
/** 501 Not Implemented — the active engine does not support this operation. */
export class OpenWANotImplementedError extends OpenWAApiError {}

/**
 * 503 Service Unavailable — a transport failure, not a refusal. The gateway answers this when the
 * engine did not confirm the operation in time: WhatsApp never replied, the socket was down, or the
 * request budget ran out. **Retryable**, unlike every other typed error here.
 *
 * Not every 503 is safe to repeat blindly: the non-idempotent sends (group create, channel create,
 * media send) are deliberately left unbounded by the gateway precisely so they never answer one.
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
export function classifyApiError(status: number, message: string, body: unknown, errorKind?: string): OpenWAApiError {
  switch (status) {
    case 401:
      return new OpenWAAuthError(message, status, body, errorKind);
    case 403:
      return new OpenWAForbiddenError(message, status, body, errorKind);
    case 404:
      return new OpenWANotFoundError(message, status, body, errorKind);
    case 409:
      return new OpenWAConflictError(message, status, body, errorKind);
    case 429:
      return new OpenWARateLimitError(message, status, body, errorKind);
    case 501:
      return new OpenWANotImplementedError(message, status, body, errorKind);
    case 503:
      return new OpenWAServiceUnavailableError(message, status, body, errorKind);
    default:
      return new OpenWAApiError(message, status, body, errorKind);
  }
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
  return String(message);
}
