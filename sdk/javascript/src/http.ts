/**
 * Injectable HTTP transport for the OpenWA SDK.
 *
 * The client never calls `globalThis.fetch` directly. Instead it accepts a
 * `FetchLike` implementation (defaulting to the global `fetch`). This makes the
 * SDK trivially testable — a test passes a recorder as `fetch` instead of
 * monkey-patching globals — and lets consumers intercept/observability-wrap
 * outbound calls.
 *
 * @packageDocumentation
 */

import { classifyApiError, OpenWAApiError, OpenWATimeoutError } from './errors.js';

/** Subset of the WHATWG `fetch` signature the SDK relies on. */
export type FetchLike = typeof globalThis.fetch;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  /** Full path beginning with `/`, e.g. `/api/sessions`. */
  path: string;
  /** Query parameters, serialized into the URL. */
  query?: object;
  /** JSON-serializable request body. */
  body?: unknown;
  /** Override the per-client timeout (ms) for this single request; `0` or `Infinity` turns it off. */
  timeoutMs?: number;
  /** Extra headers merged on top of the client defaults (auth/JSON win). */
  headers?: Record<string, string>;
}

export interface ClientConfig {
  /** Base URL of the OpenWA API, e.g. `http://localhost:2785`. */
  baseUrl: string;
  /** API key sent as `X-API-Key`. */
  apiKey: string;
  /** Per-request timeout in milliseconds (default 30000); `0` or `Infinity` turns it off. */
  timeoutMs?: number;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Stands in for an empty or dot id; encodeURIComponent output never contains it. */
const BLANK_SEGMENT = '\u0000';

/**
 * Percent-encode a single path segment (e.g. a chat/message id) so a value
 * containing `/`, `#`, `?` or whitespace can't break out of its path position.
 * WhatsApp-id characters that are already path-safe (`@`, `:`, `+`) are kept
 * readable.
 *
 * An empty, `.` or `..` segment becomes {@link BLANK_SEGMENT}, which `send()`
 * rejects: fetch resolves dot segments before sending, and an empty one means
 * a required id was blank, so either would reach the parent resource instead
 * of the intended one. Marking it here rather than throwing keeps the refusal
 * a rejection of the returned promise, since resource methods are not async.
 */
export function encodeSegment(segment: string | number): string {
  const text = String(segment);
  if (text === '' || text === '.' || text === '..') return BLANK_SEGMENT;
  return encodeURIComponent(text).replace(/%40/g, '@').replace(/%3A/g, ':').replace(/%2B/g, '+');
}

/** Build a URL with serialized query params, omitting `undefined`/`null` values. */
export function buildUrl(baseUrl: string, path: string, query?: object): string {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Perform a single request against the OpenWA API and return the parsed JSON
 * body (or `null` for 204). Throws a typed {@link OpenWAApiError} subclass on
 * non-2xx, or {@link OpenWATimeoutError} on timeout.
 */
export async function request<T>(
  config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: FetchLike },
  options: RequestOptions,
): Promise<T> {
  return send(config, options, async res => {
    if (res.status === 204) {
      return null as T;
    }
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  });
}

/** A binary (non-JSON) 2xx body, e.g. the stored status media bytes. */
export interface BinaryResponse {
  data: Uint8Array;
  contentType: string | null;
}

/**
 * Like {@link request}, but for endpoints that stream raw bytes instead of
 * JSON (e.g. status media). Returns the body verbatim plus the served
 * Content-Type; a 204/empty body resolves to zero-length data.
 */
export async function requestBytes(
  config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: FetchLike },
  options: RequestOptions,
): Promise<BinaryResponse> {
  return send(config, options, async res => {
    if (res.status === 204) {
      return { data: new Uint8Array(0), contentType: null };
    }
    return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  });
}

/**
 * A timeout in milliseconds, coerced once: untyped JS config can pass a numeric string (process.env).
 * `0` or `Infinity` turns the timeout off, so any other value that is not a non-negative number (an
 * empty variable, `30s`) is refused rather than read as "off", which would let a request hang forever.
 */
export function toTimeoutMs(value: unknown): number {
  const ms = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (Number.isNaN(ms) || ms < 0) {
    throw new TypeError(
      `OpenWA: timeoutMs must be a non-negative number of milliseconds, got ${JSON.stringify(value)}`,
    );
  }
  return ms;
}

/**
 * Shared transport for {@link request} and {@link requestBytes}: builds the
 * URL/headers, performs the fetch under the per-request timeout, translates a
 * non-2xx into a typed error, then hands the response to `consume` — still
 * inside the timeout window, so a stalled body read aborts too.
 */
async function send<T>(
  config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: FetchLike },
  options: RequestOptions,
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  if (options.path.includes(BLANK_SEGMENT)) {
    throw new TypeError(`OpenWA: empty or dot path segment in ${JSON.stringify(options.path)}`);
  }
  const url = buildUrl(config.baseUrl, options.path, options.query);
  // fetch resolves `.` and `..` segments before sending, so such a segment would reach the parent
  // resource instead of the intended one. Mirror the URL parser: it drops tab and newline, reads `\`
  // as `/`, treats %2e as a dot, and trims trailing C0 controls and spaces, which end the path only
  // when no query or fragment follows it. Empty segments, such as a trailing slash, are sent as
  // written; a blank id is refused above.
  const tail = url.slice(config.baseUrl.replace(/\/$/, '').length);
  const rawPath = tail.split(/[?#]/, 1)[0];
  let pathOnly = rawPath.replace(/[\t\n\r]/g, '');
  if (rawPath.length === tail.length) pathOnly = pathOnly.replace(/[\x00-\x20]+$/, '');
  for (const segment of pathOnly.split(/[/\\]/).slice(1)) {
    const dots = segment.replace(/%2e/gi, '.');
    if (dots === '.' || dots === '..') {
      throw new TypeError(`OpenWA: dot path segment in ${JSON.stringify(options.path)}`);
    }
  }
  const timeoutMs = toTimeoutMs(options.timeoutMs ?? config.timeoutMs);

  const controller = new AbortController();
  // 0 or Infinity means no client timeout. setTimeout fires after 1 ms for a delay that is not
  // finite or exceeds 2^31-1, so cap it rather than abort every request.
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), Math.min(timeoutMs, 2_147_483_647))
      : undefined;

  // Auth and JSON content-type WIN over caller-supplied defaults/per-request headers — the SDK only
  // ever sends a JSON body, and this matches the Python and PHP SDKs (which force JSON) and the
  // documented "JSON headers win" contract. Header names are case-insensitive and fetch joins duplicates,
  // so drop a caller's copy in any case before adding ours; putting ours last is not enough.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...config.defaultHeaders, ...options.headers })) {
    const lower = name.toLowerCase();
    if (lower !== 'content-type' && lower !== 'x-api-key') headers[name] = value;
  }
  headers['Content-Type'] = 'application/json';
  headers['X-API-Key'] = config.apiKey;

  // Called without a receiver: a platform fetch passed in as `fetch: globalThis.fetch` throws
  // "Illegal invocation" in browsers and Workers when invoked as a method of `config`.
  const doFetch = config.fetch;
  try {
    const res = await doFetch(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      // Never auto-follow redirects: doing so would re-send the X-API-Key header
      // to the redirect target (potentially a different origin). A 3xx surfaces
      // as a non-2xx error instead.
      redirect: 'manual',
    });

    if (!res.ok) {
      const context = `${options.method} ${options.path}`;
      const apiError = await OpenWAApiError.fromResponse(res, context);
      throw classifyApiError(apiError.status, apiError.message, apiError.body, apiError.errorKind, apiError.headers);
    }

    return await consume(res);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OpenWATimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Warn (NOT throw) when a URL is `http://` and the host is not localhost. The API key is sent as
 * an `X-API-Key` header on every request — over plaintext http to a non-local host that's cleartext
 * on the wire. Warning (not refusing) keeps local dev and TLS-terminating-proxy topologies working.
 */
export function warnIfInsecureHttpUrl(url: string, label = 'baseUrl'): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' && !LOCALHOST_HOSTS.has(parsed.hostname.toLowerCase())) {
      console.warn(
        `[OpenWA SDK] ${label} uses an insecure http:// URL (host: ${parsed.hostname}). ` +
          'The API key will be sent in cleartext. Use https:// in production.',
      );
    }
  } catch {
    // Unparseable — the request will fail downstream with a clear error.
  }
}
