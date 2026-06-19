import { isIPv4, isIPv6, type LookupFunction } from 'net';
import { lookup } from 'dns/promises';
import { type LookupAddress, type LookupOptions } from 'dns';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

/** Thrown when an outbound URL is blocked by the SSRF guard. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
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

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

// IPv4 ranges that must never be reachable by an outbound webhook (SSRF targets).
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
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

/**
 * Whether an IP literal points at an internal/reserved range that an outbound
 * webhook must not be allowed to reach (loopback, RFC1918, link-local/metadata,
 * CGNAT, multicast, IPv6 loopback/ULA/link-local, IPv4-mapped variants).
 * Anything that isn't a recognizable public IP is treated as blocked (fail-closed).
 */
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

export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => inCidr4(n, base, bits));
  }

  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;

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
        return isBlockedAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }

    const firstHextet = lower.split(':')[0];
    if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10

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
    }
    return false;
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
export async function resolveSafeFetchTarget(rawUrl: string): Promise<LookupAddress[] | null> {
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
    return null; // explicitly allowlisted internal target
  }

  if (isIPv4(host) || isIPv6(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Blocked internal address: ${host}`);
    }
    return null; // literal IP — fetch connects directly, nothing to rebind
  }

  const resolved = await lookup(host, { all: true });
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
export async function assertSafeFetchUrl(rawUrl: string): Promise<void> {
  await resolveSafeFetchTarget(rawUrl);
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
 * Perform an SSRF-safe fetch and hand the response to `use`, then tear down the per-request
 * connection. The host is validated and resolved ONCE; the connection is pinned to the vetted IP(s)
 * via an undici dispatcher so it cannot be re-resolved to an internal address between check and
 * connect (DNS-rebinding TOCTOU). The original hostname is preserved for TLS SNI and the Host header,
 * so virtual hosting and certificate validation are unaffected, and ALL vetted addresses are offered
 * so A-record failover still works. Redirects are refused (the guard only validated the original host).
 *
 * `use` must read everything it needs from the response before returning — the dispatcher (and its
 * sockets) is destroyed once `use` settles, so a still-streaming body would be cut off.
 *
 * @param opts.guard - when false (the WEBHOOK_SSRF_PROTECT opt-out), skips validation/pinning and
 *   performs a plain redirect-following fetch. Defaults to true (always guard).
 */
export async function withSafeFetch<T>(
  rawUrl: string,
  init: RequestInit,
  use: (response: Response) => Promise<T> | T,
  opts: { guard?: boolean } = {},
): Promise<T> {
  const guard = opts.guard ?? true;
  if (!guard) {
    return use(await undiciFetch(rawUrl, { ...init, redirect: 'follow' }));
  }

  const target = await resolveSafeFetchTarget(rawUrl);
  const dispatcher = target ? new Agent({ connect: { lookup: pinnedLookup(target) } }) : undefined;
  try {
    const response = await undiciFetch(rawUrl, { ...init, redirect: 'manual', dispatcher });
    assertNoRedirect(response, rawUrl);
    return await use(response);
  } finally {
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
  }
}
