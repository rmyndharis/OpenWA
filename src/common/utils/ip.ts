import { BlockList, isIP } from 'net';
import { normalizeIp as maskIpv6Subnet } from '@nestjs/throttler';

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
    .map(hop => normalizeIp(stripHopPort(hop.trim())))
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

/**
 * Drop a port some proxies append to an X-Forwarded-For hop: `203.0.113.7:51000` and
 * `[2001:db8::1]:443` (or bracketed without a port). A bare IPv6 address is left alone, since its
 * last group cannot be told apart from a port.
 */
function stripHopPort(hop: string): string {
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(hop);
  if (v4) return v4[1];
  const v6 = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(hop);
  return v6 ? v6[1] : hop;
}

/**
 * Key for a per-client limiter, budget or counter: an IPv6 address is masked to its /64 (the
 * `@nestjs/throttler` default the global guard uses), so a client holding a /64 cannot rotate
 * addresses into fresh buckets. IPv4 and loopback addresses come back unchanged, and an IPv4-mapped
 * address as its dotted IPv4 form.
 * For limiter keys ONLY: allowlist matching, audit rows, logs and responses need the real
 * address from `resolveClientIp`.
 */
export function limiterKeyForIp(ip: string): string {
  return maskIpv6Subnet(ip, 64);
}

interface IpTarget {
  address: string;
  type: 'ipv4' | 'ipv6';
  /** Prefix length for a CIDR; absent for an exact address. */
  bits?: number;
}

/** Parse an exact IPv4/IPv6 address or CIDR; null when `entry` is neither. */
function parseIpTarget(entry: string): IpTarget | null {
  const ref = (entry || '').trim();
  const slash = ref.indexOf('/');
  const address = normalizeIp(slash === -1 ? ref : ref.slice(0, slash));
  const family = isIP(address);
  if (family === 0) return null;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (slash === -1) return { address, type };
  const bitsRaw = ref.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsRaw)) return null;
  const bits = Number(bitsRaw);
  if (bits > (family === 6 ? 128 : 32)) return null;
  return { address, type, bits };
}

/** True if `entry` is an exact IPv4/IPv6 address or a CIDR range. */
export function isIpOrCidrEntry(entry: string): boolean {
  return parseIpTarget(entry) !== null;
}

/**
 * The TRUSTED_PROXIES entries (comma-separated) that are neither an IP nor a CIDR. Such an entry
 * never matches a peer, so the proxy it was meant to name is treated as a direct client.
 */
export function invalidTrustedProxies(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry && !isIpOrCidrEntry(entry));
}

/**
 * True if `ip` equals or falls within `target`, where `target` is an exact IP or a CIDR range, IPv4
 * (`172.18.0.0/16`) or IPv6 (`fd00::/8`). IPv4-mapped IPv6 inputs are normalized first, an address
 * never matches a target of the other family, and compressed and expanded IPv6 forms compare equal.
 * Malformed input yields `false` rather than throwing.
 */
export function ipMatches(ip: string, target: string): boolean {
  const candidate = normalizeIp((ip || '').trim());
  const parsed = parseIpTarget(target);
  if (!parsed || isIP(candidate) !== (parsed.type === 'ipv6' ? 6 : 4)) return false;
  try {
    const list = new BlockList();
    if (parsed.bits === undefined) list.addAddress(parsed.address, parsed.type);
    else list.addSubnet(parsed.address, parsed.bits, parsed.type);
    return list.check(candidate, parsed.type);
  } catch {
    return false;
  }
}
