import { BlockList, isIPv4, isIPv6, type LookupFunction } from 'net';
import { lookup } from 'dns/promises';
import { type LookupAddress, type LookupOptions } from 'dns';
import { Agent, fetch as undiciFetch, Headers, type Dispatcher, type RequestInit, type Response } from 'undici';
import { createProxyDispatcher } from './proxy-dispatcher';

/** Thrown when an outbound URL is blocked by the SSRF guard. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Generic, non-revealing message to return to an API caller when an outbound URL is SSRF-blocked. The
 * raw SsrfBlockedError message names the resolved internal IP ("… resolves to a blocked internal address:
 * 10.0.0.5"), which is a recon / DNS-rebind oracle, so it must never reach a client — log the detail
 * server-side and return this instead. Shared by the single-send, bulk, and webhook-registration paths.
 */
export const SSRF_BLOCKED_CLIENT_MESSAGE = 'Destination address is not allowed';

/**
 * Map an error to a client/surfaced message, redacting SSRF detail. An `SsrfBlockedError`'s message
 * names the resolved internal IP ("… resolves to a blocked internal address: 10.0.0.5") — a recon /
 * metadata-service probe oracle when surfaced verbatim to an HTTP response, a persisted DLQ row, or a
 * hook payload. Log the full detail server-side (when a `logger` is supplied) and return the generic
 * {@link SSRF_BLOCKED_CLIENT_MESSAGE} instead; any other error passes through verbatim so genuine
 * receiver failures (5xx, timeout, bad-zip) keep their actionable text.
 */
export function redactSsrfError(error: unknown, logger?: { warn: (message: string) => void }, site?: string): string {
  if (error instanceof SsrfBlockedError) {
    logger?.warn(`SSRF guard blocked ${site ?? 'an outbound fetch'}: ${error.message}`);
    return SSRF_BLOCKED_CLIENT_MESSAGE;
  }
  // OS-level connect errors name the receiver's host:port (connect ECONNREFUSED 10.0.0.1:443) —
  // internal topology an API consumer has no business reading out of a delivery-failure row.
  // The error code stays (actionable), the address goes.
  return (error instanceof Error ? error.message : String(error)).replace(
    /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN)\s+[\w.-]+(?::\d+)?(?=\s|$)/g,
    '$1 [redacted]',
  );
}

/**
 * Outbound webhook SSRF protection. Default ON; disable only with an explicit
 * WEBHOOK_SSRF_PROTECT=false (e.g. a closed network that delivers to internal sidecars — prefer
 * the SSRF_ALLOWED_HOSTS escape-hatch instead of disabling protection wholesale).
 */
export function isSsrfProtectionEnabled(): boolean {
  return process.env.WEBHOOK_SSRF_PROTECT !== 'false';
}

/**
 * Escape-hatch for self-hosted topologies that intentionally fetch from / deliver to
 * internal hosts (e.g. a localhost media store or a sidecar webhook receiver).
 * `SSRF_ALLOWED_HOSTS` is a comma-separated list of hostnames and/or IP literals that
 * bypass the block. Matched case-insensitively against the URL hostname.
 */
function getAllowedHosts(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOWED_HOSTS ?? '')
      .split(',')
      // Strip IPv6 brackets so an entry copied from a URL (e.g. "[::1]") matches the
      // bracket-stripped url.hostname we compare against below.
      .map(h =>
        h
          .trim()
          .replace(/^\[|\]$/g, '')
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

// IPv4 ranges that must never be reachable by an outbound webhook (SSRF targets). Membership is
// delegated to net.BlockList (the vetted stdlib implementation) rather than hand-rolled IP math.
const BLOCKED_V4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network / unspecified
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

// IPv6 ranges with the same rule. The IPv4-embedding ranges (6to4 2002::/16, NAT64 64:ff9b::/96,
// IPv4-compatible ::/96, mapped/RFC6052 ::ffff:0:0/96) are deliberately NOT here: an embedding of a
// genuinely public IPv4 must stay reachable, so those are classified per-address by the
// decapsulation ladder in isBlockedAddress, not blanket-blocked by range.
const BLOCKED_V6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['0000::', 3], // reserved by IETF (RFC 4291: global unicast is 2000::/3) — ::, ::1 and the
  // IPv4-embedding forms return earlier via the ladder or their own entries, so the fallthrough
  // check only catches the rest of the block (e.g. 1::, fc0::, fe8::)
  ['fc00::', 7], // ULA (RFC 4193)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local (RFC 3879)
];

const BLOCKED_V4 = new BlockList();
for (const [subnet, prefix] of BLOCKED_V4_RANGES) BLOCKED_V4.addSubnet(subnet, prefix, 'ipv4');

const BLOCKED_V6 = new BlockList();
for (const [subnet, prefix] of BLOCKED_V6_RANGES) BLOCKED_V6.addSubnet(subnet, prefix, 'ipv6');

// The single IPv6 ALLOW: RFC 4291's global-unicast 2000::/3. The fallthrough in isBlockedAddress
// allows only this range — everything outside it that no earlier branch classified (IPv6 multicast
// ff00::/8, the reserved blocks above 3fff:: — 4000::/3, 5f00::/16, 8000::/3, c000::/3, e000::/3)
// blocks, mirroring the IPv4 posture where multicast 224.0.0.0/4 and reserved 240.0.0.0/4 block.
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

/** Two 16-bit hextets → dotted IPv4 string (for IPv4-in-IPv6 embeddings like ::ffff:, 6to4, NAT64). */
function hextetsToV4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Expand a (possibly ::-compressed, possibly dotted-IPv4-tailed) IPv6 literal to its 8 numeric
 * hextets, or null if malformed. Full expansion is required so a compressed all-zero embedded segment
 * (e.g. 2002:7f00:: → 127.0.0.0) is read as 0x0000 rather than silently skipped.
 */
function expandIPv6(lower: string): number[] | null {
  let s = lower;
  // Fold a trailing dotted IPv4 (::a.b.c.d) into two hex hextets so the remainder is pure hex.
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) return null;
    const [a, b, c, d] = octets;
    s = s.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : gap < 1) return null;
  const parts = [...head, ...Array<string>(Math.max(gap, 0)).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return nums.some(n => Number.isNaN(n)) ? null : nums;
}

/**
 * Whether an IP literal points at an internal/reserved range that an outbound
 * webhook must not be allowed to reach (loopback, RFC1918, link-local/metadata,
 * CGNAT, multicast, IPv6 loopback/ULA/link-local, IPv4-mapped variants).
 * Anything that isn't a recognizable public IP is treated as blocked (fail-closed).
 */
export function isBlockedAddress(ip: string): boolean {
  // The address family is passed explicitly to check(): without it, an IPv6 literal silently
  // answers false (BlockList defaults to interpreting the input as IPv4), which would fail open.
  if (isIPv4(ip)) {
    return BLOCKED_V4.check(ip, 'ipv4');
  }

  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();

    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) — classify by the embedded IPv4, handling
    // BOTH the dotted-decimal and the hex-hextet form (the hex form bypassed a dotted-only regex).
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice('::ffff:'.length);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) {
        return isBlockedAddress(tail);
      }
      const hextets = tail.split(':');
      if (hextets.length === 2 && hextets.every(h => /^[0-9a-f]{1,4}$/.test(h))) {
        const hi = parseInt(hextets[0], 16);
        const lo = parseInt(hextets[1], 16);
        return isBlockedAddress(hextetsToV4(hi, lo));
      }
    }

    // IPv6 forms that embed an IPv4 — 6to4 (2002::/16), NAT64 (64:ff9b::/96), and the deprecated
    // IPv4-compatible ::/96 — are classified by the embedded address so they reach the IPv4 blocklist,
    // mirroring the ::ffff: handling above. The literal is fully expanded first so a compressed all-zero
    // embedded hextet (e.g. 2002:7f00:: → 127.0.0.0) is not skipped. A 6to4/NAT64/compat of a genuinely
    // public IPv4 still returns false, so legitimate IPv6 delivery is unaffected.
    const hextets = expandIPv6(lower);
    if (hextets) {
      if (hextets[0] === 0x2002) {
        return isBlockedAddress(hextetsToV4(hextets[1], hextets[2])); // 6to4
      }
      if (hextets[0] === 0x64 && hextets[1] === 0xff9b) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7])); // NAT64
      }
      if (hextets.slice(0, 6).every(h => h === 0) && (hextets[6] | hextets[7]) !== 0) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7])); // IPv4-compatible ::/96
      }
      // RFC6052 IPv4-translatable (::ffff:0:a.b.c.d → 0:0:0:0:ffff:0:X:X): embeds an IPv4 in the
      // low 32 bits just like the mapped/NAT64 forms, so a NAT64/SIIT translator could otherwise
      // reach an internal IPv4 through it. Classify by the embedded address (public stays allowed).
      if (
        hextets[0] === 0 &&
        hextets[1] === 0 &&
        hextets[2] === 0 &&
        hextets[3] === 0 &&
        hextets[4] === 0xffff &&
        hextets[5] === 0
      ) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7]));
      }
      // Fully-expanded IPv4-mapped (::ffff:0:0/96 → 0:0:0:0:0:ffff:X:X): the compressed "::ffff:"
      // form is caught by the prefix check above, but the fully-expanded literal bypasses it.
      // Distinct from IPv4-compat (idx5 has no 0xffff) and RFC6052 (0xffff at idx4, not idx5).
      // Classify by the embedded IPv4 (public stays allowed).
      if (
        hextets[0] === 0 &&
        hextets[1] === 0 &&
        hextets[2] === 0 &&
        hextets[3] === 0 &&
        hextets[4] === 0 &&
        hextets[5] === 0xffff
      ) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7]));
      }
    }

    // Reserved-range membership (unspecified, loopback, ULA, link-local, deprecated site-local,
    // IETF-reserved 0000::/3) via the stdlib BlockList — numeric, so compressed and fully-expanded
    // spellings of the same address answer alike — and beyond that only RFC 4291 global unicast
    // (2000::/3) is allowed: IPv6 multicast (ff00::/8) and the reserved blocks above 3fff:: block
    // too, the same fail-closed posture as IPv4's multicast/reserved ranges. Embedded forms already
    // returned above (public embeddings, NAT64 included, stay allowed — only the ladder decides those).
    return BLOCKED_V6.check(lower, 'ipv6') || !GLOBAL_UNICAST_V6.check(lower, 'ipv6');
  }

  // Not a valid IP literal — cannot verify, so block.
  return true;
}

/**
 * Reject a response obtained with `redirect: 'manual'` that turned out to be a redirect.
 * The pre-fetch SSRF check only validates the original URL, so a followed 3xx to an
 * internal host would bypass it. We never follow redirects on guarded
 * fetches; a redirect is treated as a delivery failure.
 */
export function assertNoRedirect(response: { status: number; type?: string }, url: string): void {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new SsrfBlockedError(`Refusing to follow redirect from ${url}`);
  }
}

/** Default DNS resolution deadline (ms) — generous for healthy resolvers; bounds a hang. */
const DEFAULT_DNS_TIMEOUT_MS = 10000;

function resolveDnsTimeoutMs(): number {
  const raw = process.env.SSRF_DNS_TIMEOUT_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DNS_TIMEOUT_MS;
}

/** Redirect hops followed on the guarded download path before the chain is refused. */
const MAX_REDIRECT_HOPS = 5;

/** Status codes undici surfaces as a redirect when `redirect: 'manual'` is set. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve a host with `{ all: true }`, bounded by a deadline so a hanging/slow DNS resolver cannot
 * pin a worker indefinitely (the lookup is otherwise unbounded). The default deadline is generous
 * and overridable via SSRF_DNS_TIMEOUT_MS. On expiry — or on a rejected lookup (NXDOMAIN, transient
 * EAI_AGAIN, ESERVFAIL, …) — it throws SsrfBlockedError; the in-flight lookup is left to settle with
 * its late result swallowed (no unhandledRejection). Wrapping the rejection keeps every resolution
 * failure typed, so callers map it to a 4xx instead of leaking a raw DNS error as a generic 500.
 */
async function lookupWithDeadline(host: string, signal?: AbortSignal | null): Promise<LookupAddress[]> {
  // An abort that already fired between hops burns no DNS query at all.
  if (signal?.aborted) throw signal.reason;
  const lookupPromise = lookup(host, { all: true });
  lookupPromise.catch(() => undefined); // swallow a late rejection if the deadline already fired
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SsrfBlockedError(`Timed out resolving host: ${host}`)), resolveDnsTimeoutMs());
    if (signal) {
      // Reject with the signal's own reason — for AbortSignal.timeout that is the same TimeoutError
      // a fetch-phase abort produces. Never an SsrfBlockedError: a caller timeout is not an SSRF
      // block, and the redaction layer must not rewrite it into "destination not allowed".
      onAbort = () => reject(signal.reason as Error);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([lookupPromise, deadline]);
  } catch (err) {
    if (signal?.aborted) throw signal.reason; // the caller's abort wins over a simultaneous DNS error
    if (err instanceof SsrfBlockedError) throw err; // deadline already produced a typed error
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new SsrfBlockedError(`Could not resolve host: ${host}${code ? ` (${code})` : ''}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Validate an outbound URL and resolve its host ONCE. Throws SsrfBlockedError if the scheme is not
 * http(s) or if the host (literal or any DNS-resolved address) is internal/reserved. Guards both
 * webhook delivery and server-side media fetches. Hosts named in `SSRF_ALLOWED_HOSTS` are allowed
 * through (escape-hatch for trusted internal targets).
 *
 * Returns the vetted resolved addresses so a caller can PIN the connection to them — defeating the
 * DNS-rebinding window where the address validated here differs from the one `fetch` would re-resolve.
 * Returns null when there is nothing to pin: an allowlisted host (trusted — deliberately left
 * unpinned, since the operator opts in to whatever its DNS returns) or a literal IP (no DNS, so no
 * rebind is possible — fetch connects straight to the validated literal).
 */
export async function resolveSafeFetchTarget(
  rawUrl: string,
  signal?: AbortSignal | null,
): Promise<LookupAddress[] | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked URL scheme: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (getAllowedHosts().has(host.toLowerCase())) {
    // Allowlisted = exempt from the BLOCK check, not from pinning: the operator opted into THIS
    // host, so freeze the connection to the addresses it resolves to right now. Returning null
    // here left a rebinding window where a name could flip to a different address after validation.
    return lookupWithDeadline(host, signal);
  }

  if (isIPv4(host) || isIPv6(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Blocked internal address: ${host}`);
    }
    return null; // literal IP — fetch connects directly, nothing to rebind
  }

  const resolved = await lookupWithDeadline(host, signal);
  if (resolved.length === 0) {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`Host ${host} resolves to a blocked internal address: ${address}`);
    }
  }
  return resolved; // vetted addresses — pin the connection to these
}

/**
 * Backwards-compatible assertion form: validate the URL (used at webhook registration time, where
 * only the throw/no-throw outcome matters).
 */
export async function assertSafeFetchUrl(rawUrl: string, signal?: AbortSignal | null): Promise<void> {
  await resolveSafeFetchTarget(rawUrl, signal);
}

/**
 * Build a `net`-style lookup function that always returns the pre-validated addresses and never
 * consults DNS — so a connection using it cannot be re-resolved to a different (internal) address.
 */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  // undici always invokes the lookup with an options object; `all: true` expects the address array,
  // otherwise a single (address, family) pair.
  const fn = (_hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void): void => {
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
  return fn as unknown as LookupFunction;
}

/**
 * Cancel an unread response body before the per-request dispatcher is destroyed.
 *
 * Status-only callers (webhook delivery) often leave `response.body` unread. When undici then
 * tears down the socket — or the peer resets it mid-flight — the body stream can emit an `error`
 * (`TypeError: terminated` / `ECONNRESET`) with no listener, which becomes a process-fatal
 * `uncaughtException` (see #887). Cancelling here drains that path safely; already-consumed
 * bodies (`bodyUsed`) are left alone so streaming readers (media / plugin downloads) are unaffected.
 */
async function settleUnreadResponseBody(response: Response): Promise<void> {
  // bodyUsed only covers *disturbed* streams. A stream the caller locked with getReader() but never
  // read from is not disturbed, and cancel() on a locked stream rejects — such callers must cancel
  // their own reader on error paths, so locked streams are left to them.
  if (response.bodyUsed || !response.body || response.body.locked) return;
  // Guard the call itself: a duck-typed response (e.g. a test mock without cancel) must not throw
  // synchronously from a `finally` and mask the original error.
  if (typeof response.body.cancel !== 'function') return;
  await response.body.cancel().catch(() => undefined);
}

/**
 * Run `use(response)` and always settle an unread body afterwards, even if `use` throws.
 */
async function useAndSettleBody<T>(response: Response, use: (response: Response) => Promise<T> | T): Promise<T> {
  try {
    return await use(response);
  } finally {
    await settleUnreadResponseBody(response);
  }
}

/**
 * Escape hatch for deployments whose plugin vendor / release host legitimately redirects an https
 * URL to a plain-http hop (e.g. behind TLS-terminating infrastructure). Default OFF: an https→http
 * downgrade hop is refused because the payload on this path is executable code and an http hop
 * exposes it to on-path substitution. Set PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS=true to allow.
 */
function isInsecureRedirectHopAllowed(): boolean {
  return process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS === 'true';
}

/**
 * undici's native redirector strips credentials on cross-origin hops and rewrites 301/302/303 to a
 * bodiless GET — the manual loop must do the same, or a redirect target would receive the original
 * request's Authorization/Cookie headers and body.
 */
function nextRedirectHopInit(init: RequestInit, status: number, nextUrl: string, initialOrigin: string): RequestInit {
  let next = init;
  if (
    status !== 307 &&
    status !== 308 &&
    next.method !== undefined &&
    next.method !== 'GET' &&
    next.method !== 'HEAD'
  ) {
    next = { ...next, method: 'GET' };
    delete next.body;
  }
  if (new URL(nextUrl).origin !== initialOrigin && next.headers !== undefined) {
    const headers = new Headers(next.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    next = { ...next, headers };
  }
  return next;
}

/**
 * The dispatcher one guarded request rides, destroyed by the caller once the request settles.
 *
 * With a session proxy the request leaves through it, whatever the guard decided: the proxy is the
 * session's egress and a fetch that quietly went direct would put the gateway's own address on the
 * wire (#1626). What the guard can still enforce there is narrower than on the direct path, and
 * worth stating exactly:
 *
 * - The scheme check and the blocked-address check on the URL itself run unchanged, so `file:`,
 *   `http://169.254.169.254/` and a name resolving into a reserved range are refused before any
 *   socket is opened, proxy or not.
 * - Destination PINNING survives only through SOCKS, which carries the destination address in the
 *   request. The whole vetted list goes over, to be dialled in order, so the address-family failover
 *   the direct path gets from happy-eyeballs is not lost to a proxy that can route only one of them.
 *   An HTTP/HTTPS proxy is handed the destination by name in the CONNECT line and resolves it with
 *   its own resolver, so the vetted address cannot be expressed and a DNS rebind between check and
 *   connect is not structurally preventable.
 *
 * Without a proxy the behaviour is byte-identical to before: the pinned `Agent` for a vetted
 * hostname, and no dispatcher at all for an IP literal or an unguarded fetch.
 */
function requestDispatcher(proxyUrl: string | undefined, target: LookupAddress[] | null): Dispatcher | undefined {
  if (proxyUrl) {
    return createProxyDispatcher(proxyUrl, { pinnedAddresses: target?.map(({ address }) => address) });
  }
  return target ? new Agent({ connect: { lookup: pinnedLookup(target) } }) : undefined;
}

/**
 * Perform an SSRF-safe fetch and hand the response to `use`, then tear down the per-request
 * connection. The host is validated and resolved ONCE; the connection is pinned to the vetted IP(s)
 * via an undici dispatcher so it cannot be re-resolved to an internal address between check and
 * connect (DNS-rebinding TOCTOU). The original hostname is preserved for TLS SNI and the Host header,
 * so virtual hosting and certificate validation are unaffected, and ALL vetted addresses are offered
 * so A-record failover still works (behind a SOCKS proxy the same list is dialled in order, and
 * behind an HTTP/HTTPS proxy the CONNECT line carries the name for the proxy to resolve). Redirects
 * are refused (the guard only validated the original host).
 *
 * `use` must read everything it needs from the response before returning — the dispatcher (and its
 * sockets) is destroyed once `use` settles, so a still-streaming body would be cut off. Unread
 * bodies are cancelled automatically before teardown so status-only callers cannot crash the process
 * when the peer resets the connection (#887).
 *
 * @param opts.guard - when false (the WEBHOOK_SSRF_PROTECT opt-out), skips validation/pinning and
 *   performs a plain redirect-following fetch. Defaults to true (always guard).
 * @param opts.proxyUrl - the egress proxy every request of this fetch must leave through; see
 *   {@link requestDispatcher} for what the guard can still enforce behind one.
 */
export async function withSafeFetch<T>(
  rawUrl: string,
  init: RequestInit,
  use: (response: Response) => Promise<T> | T,
  opts: { guard?: boolean; followRedirects?: boolean; proxyUrl?: string } = {},
): Promise<T> {
  const guard = opts.guard ?? true;
  if (!guard) {
    // Redirect-following is a separate decision from SSRF protection: an operator who disabled the
    // guard (closed network) did not opt into chasing 3xx chains to arbitrary hosts. Fail loudly
    // unless WEBHOOK_SSRF_REDIRECTS=true says otherwise.
    //
    // The proxy still applies: turning the guard off says nothing about which address the request
    // may leave from, so an unguarded fetch for a proxied session is proxied too.
    const follow = process.env.WEBHOOK_SSRF_REDIRECTS === 'true';
    const dispatcher = requestDispatcher(opts.proxyUrl, null);
    try {
      return await useAndSettleBody(
        await undiciFetch(rawUrl, { ...init, redirect: follow ? 'follow' : 'error', dispatcher }),
        use,
      );
    } finally {
      if (dispatcher) await dispatcher.destroy().catch(() => undefined);
    }
  }

  if (opts.followRedirects) {
    // Download path (plugin .zip / catalog JSON): public release hosts legitimately 302 to a CDN, so
    // refusing every redirect breaks them. Follow them manually and re-validate EVERY hop with
    // resolveSafeFetchTarget, which rejects blocked IP literals directly.
    //
    // Do NOT delegate hop checking to an Agent's `connect.lookup`: Node skips DNS entirely for an
    // IP-literal host, so a custom lookup is never invoked for `Location: http://127.0.0.1/` and the
    // hop goes unchecked. Each hop below is validated BEFORE its socket is opened.
    let currentUrl = rawUrl;
    let initialOrigin: string | undefined;
    let hopInit = init;
    let sawSecureHop = false;
    for (let hop = 0; ; hop++) {
      const target = await resolveSafeFetchTarget(currentUrl, init.signal);
      // Parsed already by resolveSafeFetchTarget above, so this cannot throw.
      const current = new URL(currentUrl);
      initialOrigin ??= current.origin;
      // A hop that downgrades https→http exposes the (executable) download to on-path substitution.
      // Chains that STARTED on plain http are unaffected — they were never secure to begin with.
      if (current.protocol === 'http:' && sawSecureHop && !isInsecureRedirectHopAllowed()) {
        throw new Error(`Refusing redirect that downgrades from https to http: ${currentUrl}`);
      }
      if (current.protocol === 'https:') sawSecureHop = true;
      const dispatcher = requestDispatcher(opts.proxyUrl, target);
      try {
        const response = await undiciFetch(currentUrl, { ...hopInit, redirect: 'manual', dispatcher });
        if (!REDIRECT_STATUSES.has(response.status)) {
          return await useAndSettleBody(response, use);
        }
        const location = response.headers.get('location');
        await settleUnreadResponseBody(response);
        if (!location) {
          throw new SsrfBlockedError(`Redirect from ${currentUrl} carried no Location header`);
        }
        if (hop >= MAX_REDIRECT_HOPS) {
          // Deliberately NOT an SsrfBlockedError: this is an actionable operator error, not a
          // blocked-address rejection, so it must survive redactSsrfError verbatim.
          throw new Error(`Too many redirects while fetching ${rawUrl}`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        hopInit = nextRedirectHopInit(hopInit, response.status, nextUrl, initialOrigin);
        currentUrl = nextUrl;
      } finally {
        if (dispatcher) await dispatcher.destroy().catch(() => undefined);
      }
    }
  }

  const target = await resolveSafeFetchTarget(rawUrl, init.signal);
  const dispatcher = requestDispatcher(opts.proxyUrl, target);
  try {
    const response = await undiciFetch(rawUrl, { ...init, redirect: 'manual', dispatcher });
    try {
      assertNoRedirect(response, rawUrl);
      return await use(response);
    } finally {
      // Settle even when assertNoRedirect throws: a refused 3xx still carries an unread body,
      // and tearing the dispatcher down with it open is the same crash path as #887.
      await settleUnreadResponseBody(response);
    }
  } finally {
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
  }
}
