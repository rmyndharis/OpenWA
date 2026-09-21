import { withSafeFetch } from '../security/ssrf-guard';
import { urlFetchProxy } from '../security/proxy-dispatcher';

/** Default cap on a server-side media download: 50 MiB (overridable via MEDIA_DOWNLOAD_MAX_BYTES). */
const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
/** Default timeout for a server-side media download: 30s (overridable via MEDIA_DOWNLOAD_TIMEOUT_MS). */
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;

/**
 * Read a positive-integer knob. Boot validation rejects a malformed value for every key read here,
 * so the fallback covers unset and empty only: `parseInt` accepts the leading digits of a
 * unit-suffixed value and would silently take `50mb` as 50.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Fetch remote media as a Buffer for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. It goes through `withSafeFetch`, which pins the connection to
 * the vetted IP and refuses redirects (the guard only validated the original host — a followed 3xx
 * could reach an internal target). The cap is enforced while streaming (Content-Length may be absent
 * or wrong) to bound memory use.
 *
 * Engine-neutral: returns raw bytes + the response content-type, so any engine adapter can use it.
 *
 * `sessionProxyUrl` is the egress proxy of the session the fetch is attributed to, or undefined for
 * a direct one. It is required rather than optional so a new call site cannot leave a proxied
 * session's fetch going direct by omission; `urlFetchProxy` applies the operator's opt-out.
 */
export async function loadRemoteMediaBuffer(
  url: string,
  sessionProxyUrl: string | undefined,
): Promise<{ data: Buffer; mimetype: string }> {
  const maxBytes = positiveIntFromEnv('MEDIA_DOWNLOAD_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES);
  const timeoutMs = positiveIntFromEnv('MEDIA_DOWNLOAD_TIMEOUT_MS', DEFAULT_MEDIA_TIMEOUT_MS);

  // Always guarded (media SSRF is independent of the webhook opt-out); withSafeFetch validates the
  // host, pins the connection to the vetted IP, and refuses redirects. The streaming cap runs inside
  // the callback so the connection stays open for the body read and is torn down right after.
  const proxyUrl = urlFetchProxy(sessionProxyUrl);
  return withSafeFetch(
    url,
    { signal: AbortSignal.timeout(timeoutMs) },
    async response => {
      if (!response.ok) {
        throw new Error(`Media fetch failed with status ${response.status}`);
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Media exceeds the ${maxBytes}-byte limit`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Media response has no body');
      }

      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Media exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(Buffer.from(value));
      }

      const mimetype = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      return { data: Buffer.concat(chunks), mimetype };
    },
    { proxyUrl },
  );
}
