/**
 * Strip an IPv4-mapped IPv6 prefix so comparisons work consistently.
 * Node often reports socket addresses as `::ffff:1.2.3.4` behind dual-stack
 * listeners; this returns the bare `1.2.3.4`.
 */
export function normalizeIp(ip: string): string {
  if (!ip) return ip;
  const match = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return match ? match[1] : ip;
}

/** Minimal request shape needed for client-IP resolution (framework-agnostic). */
export interface RequestLike {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Resolve the real client IP. X-Forwarded-For is client-controllable, so it is only
 * honored when the request actually arrives from a configured trusted proxy. With no
 * trusted proxies, the direct socket address is used (prevents XFF spoofing). Shared by
 * ApiKeyGuard (allowedIps whitelist) and the throttler (per-client rate-limit bucket).
 */
export function resolveClientIp(req: RequestLike, trustedProxies: string[]): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.ip || '');

  if (!trustedProxies || trustedProxies.length === 0) {
    return socketIp;
  }

  const isTrusted = (ip: string): boolean => trustedProxies.some(proxy => ipMatches(ip, proxy));

  // Only trust the forwarded chain if the immediate peer is a trusted proxy.
  if (!isTrusted(socketIp)) {
    return socketIp;
  }

  const forwarded = req.headers['x-forwarded-for'];
  if (!forwarded) {
    return socketIp;
  }

  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
    .split(',')
    .map(hop => normalizeIp(hop.trim()))
    .filter(Boolean);

  // Walk right-to-left and return the first hop that is not a trusted proxy:
  // the closest address the trusted infrastructure actually observed.
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrusted(hops[i])) {
      return hops[i];
    }
  }

  return socketIp;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/**
 * True if `ip` equals or falls within `target`, where `target` is either an
 * exact IP or an IPv4 CIDR (e.g. `172.18.0.0/16`). IPv4-mapped IPv6 inputs are
 * normalized first. Malformed input yields `false` rather than throwing.
 */
export function ipMatches(ip: string, target: string): boolean {
  const candidate = normalizeIp((ip || '').trim());
  const ref = (target || '').trim();

  if (!ref.includes('/')) {
    return normalizeIp(ref) === candidate;
  }

  const [range, bitsRaw] = ref.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(candidate);
  const rangeInt = ipv4ToInt(normalizeIp(range));
  if (ipInt === null || rangeInt === null) return false;

  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}
