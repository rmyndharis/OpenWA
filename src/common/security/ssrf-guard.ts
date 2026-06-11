import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Opt-in SSRF guard for outbound webhook delivery.
 *
 * Webhook receivers on loopback/LAN are a legitimate use case (e.g. a local
 * n8n instance), so this protection is OFF by default and only enforced when
 * the operator sets WEBHOOK_SSRF_PROTECT=true. When enabled it blocks
 * non-http(s) schemes and any host that resolves to a private, loopback,
 * link-local, unique-local, or cloud-metadata address.
 */
export function isWebhookSsrfProtectionEnabled(): boolean {
  return process.env.WEBHOOK_SSRF_PROTECT === 'true';
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: string, bits: number): boolean => {
    const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local incl. 169.254.169.254 metadata
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) ||
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (addr.startsWith('fd00:ec2') || addr === 'fd00:ec2::254') return true; // AWS IPv6 metadata
  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a parseable IP -> block conservatively
}

/**
 * Throws if `rawUrl` is unsafe to call as a webhook target. No-op when SSRF
 * protection is disabled.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  if (!isWebhookSsrfProtectionEnabled()) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Webhook URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Webhook URL scheme not allowed: ${url.protocol}`);
  }

  const host = url.hostname;

  // Host is an IP literal -> classify directly.
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error('Webhook URL resolves to a blocked (internal) address');
    }
    return;
  }

  // Resolve all addresses and block if ANY is internal (defends against
  // round-robin / split-horizon DNS pointing one record at an internal host).
  const results = await lookup(host, { all: true });
  if (results.length === 0) {
    throw new Error('Webhook URL host could not be resolved');
  }
  for (const { address } of results) {
    if (isBlockedIp(address)) {
      throw new Error('Webhook URL resolves to a blocked (internal) address');
    }
  }
}
