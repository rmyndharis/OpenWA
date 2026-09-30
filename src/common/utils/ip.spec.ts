import { normalizeIp, ipMatches, limiterKeyForIp, resolveClientIp, isIpOrCidrEntry, invalidTrustedProxies } from './ip';

describe('normalizeIp', () => {
  it('strips an IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:172.18.0.1')).toBe('172.18.0.1');
  });

  it('leaves a plain IPv4 address untouched', () => {
    expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
  });

  it('leaves a real IPv6 address untouched', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('limiterKeyForIp', () => {
  it('gives two IPv6 addresses in one /64 the same key', () => {
    expect(limiterKeyForIp('2001:db8:1:2::a')).toBe(limiterKeyForIp('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(limiterKeyForIp('2001:db8:1:2::a')).toBe('2001:db8:1:2::/64');
  });

  it('keeps IPv6 addresses in different /64s apart', () => {
    expect(limiterKeyForIp('2001:db8:1:2::a')).not.toBe(limiterKeyForIp('2001:db8:1:3::a'));
  });

  it('keys IPv4 and loopback as they are, and an IPv4-mapped address as its IPv4 form', () => {
    expect(limiterKeyForIp('203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKeyForIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKeyForIp('::1')).toBe('::1');
    expect(limiterKeyForIp('')).toBe('');
  });
});

describe('ipMatches', () => {
  it('matches an exact IP', () => {
    expect(ipMatches('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(ipMatches('10.0.0.6', '10.0.0.5')).toBe(false);
  });

  it('matches within an IPv4 CIDR range', () => {
    expect(ipMatches('172.18.3.4', '172.18.0.0/16')).toBe(true);
    expect(ipMatches('172.19.0.1', '172.18.0.0/16')).toBe(false);
  });

  it('normalizes an IPv4-mapped IPv6 address before matching a CIDR', () => {
    expect(ipMatches('::ffff:172.18.0.9', '172.18.0.0/16')).toBe(true);
  });

  it('handles /32 and /0 boundaries', () => {
    expect(ipMatches('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(ipMatches('1.2.3.5', '1.2.3.4/32')).toBe(false);
    expect(ipMatches('9.9.9.9', '0.0.0.0/0')).toBe(true);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(ipMatches('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('10.0.0.1', 'garbage/99')).toBe(false);
  });
});

describe('ipMatches with IPv6', () => {
  it('matches within an IPv6 CIDR range', () => {
    expect(ipMatches('fd00:10:244::7', 'fd00::/8')).toBe(true);
    expect(ipMatches('fe80::1', 'fd00::/8')).toBe(false);
    expect(ipMatches('2001:db8:1:2::a', '2001:db8:1::/48')).toBe(true);
    expect(ipMatches('2001:db8:2::a', '2001:db8:1::/48')).toBe(false);
  });

  it('matches an exact IPv6 address in compressed or expanded form, in any case', () => {
    expect(ipMatches('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(ipMatches('2001:DB8::1', '2001:db8::1')).toBe(true);
    expect(ipMatches('2001:db8::2', '2001:db8::1')).toBe(false);
  });

  it('never matches across address families', () => {
    expect(ipMatches('10.0.0.1', '::/0')).toBe(false);
    expect(ipMatches('2001:db8::1', '0.0.0.0/0')).toBe(false);
  });

  it('returns false for a malformed IPv6 target or prefix', () => {
    expect(ipMatches('fd00::1', 'fd00::/129')).toBe(false);
    expect(ipMatches('fd00::1', 'fd00::zz/8')).toBe(false);
    expect(ipMatches('fd00::1', 'fd00::/8/1')).toBe(false);
    expect(ipMatches('fd00::1', 'fd00::/')).toBe(false);
  });
});

describe('isIpOrCidrEntry / invalidTrustedProxies', () => {
  it('accepts IPv4 and IPv6 addresses and CIDRs', () => {
    for (const entry of ['10.0.0.1', '172.18.0.0/16', '2001:db8::1', 'fd00::/8', '::ffff:10.0.0.1']) {
      expect(isIpOrCidrEntry(entry)).toBe(true);
    }
  });

  it('lists only the entries that are neither an IP nor a CIDR', () => {
    expect(invalidTrustedProxies(' 10.0.0.1, proxy.internal ,fd00::/8,, 10.0.0.0/33 ')).toEqual([
      'proxy.internal',
      '10.0.0.0/33',
    ]);
    expect(invalidTrustedProxies(undefined)).toEqual([]);
  });
});

describe('resolveClientIp', () => {
  const req = (socketIp: string, xff?: string) => ({
    socket: { remoteAddress: socketIp },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

  it('honors X-Forwarded-For from a proxy inside an IPv6 CIDR', () => {
    expect(resolveClientIp(req('fd00:10:244::7', '198.51.100.20'), ['fd00::/8'])).toBe('198.51.100.20');
  });

  it('strips a port from an IPv4 hop, so one client resolves to one address', () => {
    const a = resolveClientIp(req('10.0.0.2', '198.51.100.20:51000'), ['10.0.0.0/8']);
    const b = resolveClientIp(req('10.0.0.2', '198.51.100.20:51001'), ['10.0.0.0/8']);
    expect(a).toBe('198.51.100.20');
    expect(b).toBe('198.51.100.20');
    expect(ipMatches(a, '198.51.100.20')).toBe(true);
  });

  it('strips brackets and a port from an IPv6 hop', () => {
    expect(resolveClientIp(req('10.0.0.2', '[2001:db8::1]:443'), ['10.0.0.0/8'])).toBe('2001:db8::1');
    expect(resolveClientIp(req('10.0.0.2', '[2001:db8::1]'), ['10.0.0.0/8'])).toBe('2001:db8::1');
  });

  it('leaves a bare IPv6 hop untouched', () => {
    expect(resolveClientIp(req('10.0.0.2', '2001:db8::1:443'), ['10.0.0.0/8'])).toBe('2001:db8::1:443');
  });

  it('skips a trusted hop that carries a port', () => {
    expect(resolveClientIp(req('10.0.0.2', '198.51.100.20, 10.0.0.9:8080'), ['10.0.0.0/8'])).toBe('198.51.100.20');
  });
});
