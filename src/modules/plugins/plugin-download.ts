import { createHash } from 'crypto';
import { withSafeFetch } from '../../common/security/ssrf-guard';

/** Default cap on a server-side plugin download: 5 MiB (matches the upload limit). */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Default timeout for a server-side plugin download: 30s. */
const DEFAULT_TIMEOUT_MS = 30_000;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Optional content integrity for a plugin download, carried IN the URL so it works over any
 * transport (a catalog `download` link, a dashboard paste, a raw API call):
 *   - URL fragment:  https://host/pkg.zip#sha256=<64 hex>   — never sent to the server
 * The fragment is the only honored marker: unlike a query param it is not part of the request, so
 * it cannot collide with a param the download host itself uses — a `?sha256=`/`?checksum=` on a
 * CDN or artifact URL means something to THAT host, and seizing it as an integrity pin would
 * fail or mis-verify an unrelated download.
 * Returns the lowercase expected digest, or null when the URL carries no integrity marker.
 *
 * Throws when the marker is present but malformed (not 64 hex chars): the caller explicitly asked
 * for integrity, so an unusable marker fails closed rather than silently degrading to no
 * verification.
 */
export function expectedSha256FromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // not a parseable URL — the SSRF guard / fetch rejects it downstream
  }
  if (!parsed.hash.startsWith('#sha256=')) return null;
  const digest = parsed.hash.slice('#sha256='.length).trim().toLowerCase();
  if (!SHA256_HEX.test(digest)) {
    throw new Error('the URL carries a sha256 integrity marker that is not a 64-character hex digest');
  }
  return digest;
}

/**
 * Fail-closed sha256 verification of a downloaded plugin package. No-op when the URL carries no
 * integrity marker (HTTPS + the SSRF guard remain the baseline); otherwise the digest of the
 * downloaded bytes MUST equal the expected one — a mismatch means the bytes were substituted in
 * transit (or the marker is stale), and the caller must not install them.
 */
export function assertDownloadSha256(url: string, body: Buffer): void {
  const expected = expectedSha256FromUrl(url);
  if (expected === null) return;
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for the downloaded package (expected ${expected}, got ${actual})`);
  }
}

/**
 * Fetch a remote resource (plugin .zip or catalog JSON) as a Buffer, always behind the SSRF guard:
 * every host (the original URL and every redirect hop) is validated before its socket opens and a hop
 * resolving to an internal/reserved address is refused. Redirects ARE followed — public release hosts
 * (e.g. GitHub Releases) legitimately 302 to a CDN — but each hop is re-validated, so following them
 * cannot reach an internal target. The byte cap is enforced while streaming (Content-Length may be
 * absent or wrong) so a hostile or oversized response can't exhaust memory.
 *
 * Operators must add a non-public catalog/release host to `SSRF_ALLOWED_HOSTS`; public hosts
 * (github.com, objects.githubusercontent.com, raw.githubusercontent.com) resolve and pass normally.
 */
export async function fetchSafeBuffer(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
  // Coerce a missing/non-finite/non-positive cap to the default: `??` alone would let a NaN through
  // (e.g. a misparsed env value), which makes every `> maxBytes` guard below inert.
  const maxBytes =
    Number.isFinite(opts.maxBytes) && (opts.maxBytes as number) > 0 ? (opts.maxBytes as number) : DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return withSafeFetch(
    url,
    { signal: AbortSignal.timeout(timeoutMs) },
    async response => {
      if (!response.ok) {
        throw new Error(`download failed with status ${response.status}`);
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`download exceeds the ${maxBytes}-byte limit`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('download response has no body');
      }

      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`download exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(Buffer.from(value));
      }

      return Buffer.concat(chunks);
    },
    { followRedirects: true },
  );
}
