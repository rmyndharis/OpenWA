import { withSafeFetch } from '../../common/security/ssrf-guard';

/** Default + hard-cap timeout for a plugin's outbound request. */
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
/** Cap the buffered response body so a hostile endpoint can't exhaust host memory through a plugin. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/**
 * Global cap on concurrent plugin fetches. Each buffers up to MAX_BODY_BYTES host-side (outside the
 * worker heap cap), so without a ceiling many concurrent fetches across plugins/workers could OOM the
 * host. This bounds total plugin-fetch buffering to MAX_INFLIGHT_FETCHES × MAX_BODY_BYTES regardless of
 * plugin or worker count. Reject-when-full (mirrors the sandbox in-flight-cap pattern) instead of an
 * unbounded queue, so abuse fails fast rather than deferring the memory blow-up.
 */
const MAX_INFLIGHT_FETCHES = 16;
let inFlightFetches = 0;

/** Request a sandboxed plugin may make through ctx.net.fetch. Body may be a string (text/JSON) or raw
 * bytes (binary uploads, e.g. multipart) — a Uint8Array survives the worker structuredClone bridge. */
export interface PluginNetRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
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
 * The effective outbound-host allowlist for a plugin: its static manifest `net.allow` plus the host of
 * every `net.allowConfigHosts` config key that resolves to an https URL. Lets a marketplace adapter reach
 * an operator-configured host (e.g. a Chatwoot base URL) without `net.allow:['*']`. Credentialed or
 * non-https values are ignored; the SSRF guard still blocks private IPs at connect regardless.
 */
export function effectiveNetAllow(
  allow: string[] | undefined,
  allowConfigHosts: string[] | undefined,
  config: Record<string, unknown>,
): string[] {
  const out = [...(allow ?? [])];
  for (const key of allowConfigHosts ?? []) {
    const raw = config[key];
    if (typeof raw !== 'string') continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      if (u.hostname.includes('*')) continue; // never let a config value inject the '*' wildcard sentinel
      out.push(u.host); // host:port when a port is set, else bare host
    } catch {
      // Not a URL — skip.
    }
  }
  return out;
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
  // Reject-when-full BEFORE reserving a slot, so total concurrent host-side buffering stays bounded to
  // MAX_INFLIGHT_FETCHES × MAX_BODY_BYTES. Check + increment are synchronous (single event-loop turn),
  // so no interleaving can overshoot the cap; the slot is released in the finally below.
  if (inFlightFetches >= MAX_INFLIGHT_FETCHES) {
    throw new Error(`too many concurrent plugin net.fetch calls (max ${MAX_INFLIGHT_FETCHES}); retry shortly`);
  }
  inFlightFetches++;
  // Coerce a non-finite timeoutMs (a string/object/NaN from the untrusted worker) to the default
  // instead of letting it flow through as NaN — `Math.max('abc', 1)` is NaN, and AbortSignal.timeout(NaN)
  // throws a RangeError, silently defeating the documented default + hard-cap clamp.
  const requested =
    typeof init.timeoutMs === 'number' && Number.isFinite(init.timeoutMs) ? init.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requested, 1), MAX_TIMEOUT_MS);

  try {
    return await safeFetch<PluginNetResponse>(
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
        // Stream with a running cap so a chunked response without an honest content-length can't blow
        // past the limit (arrayBuffer() would buffer the whole body first). Mirrors plugin-download.
        const reader = response.body?.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        if (reader) {
          for (;;) {
            const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
              await reader.cancel().catch(() => undefined);
              throw new Error(`plugin net.fetch response exceeds the ${MAX_BODY_BYTES}-byte cap`);
            }
            chunks.push(Buffer.from(value));
          }
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
          body: Buffer.concat(chunks).toString('utf-8'),
        };
      },
    );
  } finally {
    inFlightFetches--;
  }
}
