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
  /** Override the per-client timeout (ms) for this single request. */
  timeoutMs?: number;
  /** Extra headers merged on top of the client defaults (auth/JSON win). */
  headers?: Record<string, string>;
}

export interface ClientConfig {
  /** Base URL of the OpenWA API, e.g. `http://localhost:2785`. */
  baseUrl: string;
  /** API key sent as `X-API-Key`. */
  apiKey: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: FetchLike;
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
  const url = buildUrl(config.baseUrl, options.path, options.query);
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.defaultHeaders,
    ...options.headers,
    'X-API-Key': config.apiKey,
  };

  let res: Response;
  try {
    res = await config.fetch(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OpenWATimeoutError(timeoutMs);
    }
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const context = `${options.method} ${options.path}`;
    const apiError = await OpenWAApiError.fromResponse(res, context);
    throw classifyApiError(apiError.status, apiError.message, apiError.body, apiError.errorKind);
  }

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
}
