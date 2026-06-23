import { withSafeFetch } from '../../common/security/ssrf-guard';

/** Default + hard-cap timeout for a plugin's outbound request. */
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
/** Cap the buffered response body so a hostile endpoint can't exhaust host memory through a plugin. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Request a sandboxed plugin may make through ctx.net.fetch. Body is a string (text/JSON APIs). */
export interface PluginNetRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Serializable response handed back to the plugin. No streaming / no methods — it must cross the
 * worker boundary via structuredClone, so the body is read host-side and returned as a string.
 */
export interface PluginNetResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Is `url` allowed by a plugin's manifest `net.allow` list? Deny-by-default. `'*'` allows any host
 * (the SSRF guard still blocks internal IPs at connect time); an entry may be `host:port` (exact) or
 * a bare `host` (any port). Only http(s) is ever allowed.
 */
export function isNetHostAllowed(allow: string[] | undefined, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const list = allow ?? [];
  if (list.includes('*')) return true;

  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return list.includes(`${parsed.hostname}:${port}`) || list.includes(parsed.hostname);
}

/**
 * Perform a plugin's outbound request through the SSRF guard (resolve-once-pin, redirect-refused),
 * bounded by a timeout and a response-size cap, and serialize the response for the capability bridge.
 * `deps.fetch` is injectable for tests; production uses {@link withSafeFetch}.
 */
export async function performPluginFetch(
  url: string,
  init: PluginNetRequestInit = {},
  deps: { fetch?: typeof withSafeFetch } = {},
): Promise<PluginNetResponse> {
  const safeFetch = deps.fetch ?? withSafeFetch;
  const timeoutMs = Math.min(Math.max(init.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);

  return safeFetch<PluginNetResponse>(
    url,
    {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    },
    async response => {
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new Error(`plugin net.fetch response exceeds the ${MAX_BODY_BYTES}-byte cap`);
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > MAX_BODY_BYTES) {
        throw new Error(`plugin net.fetch response exceeds the ${MAX_BODY_BYTES}-byte cap`);
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        body: buf.toString('utf-8'),
      };
    },
  );
}
