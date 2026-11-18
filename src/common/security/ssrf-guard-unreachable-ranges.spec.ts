import { isBlockedAddress, resolveSafeFetchTarget, SsrfBlockedError } from './ssrf-guard';

// The IANA special-purpose registries mark these blocks "not globally reachable": no public host ever lives
// in them, so an outbound fetch can only land on a host inside the operator's own network, which the guard
// refuses. SSRF_ALLOWED_HOSTS is how an operator names such a host on purpose.
describe('isBlockedAddress: documentation and benchmarking blocks', () => {
  it.each([
    ['TEST-NET-1', '192.0.2.0'],
    ['TEST-NET-1', '192.0.2.10'],
    ['TEST-NET-1', '192.0.2.255'],
    ['TEST-NET-2', '198.51.100.0'],
    ['TEST-NET-2', '198.51.100.10'],
    ['TEST-NET-2', '198.51.100.255'],
    ['TEST-NET-3', '203.0.113.0'],
    ['TEST-NET-3', '203.0.113.10'],
    ['TEST-NET-3', '203.0.113.255'],
    ['IPv6 documentation 2001:db8::/32', '2001:db8::'],
    ['IPv6 documentation 2001:db8::/32', '2001:db8::10'],
    ['IPv6 documentation 2001:db8::/32', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['IPv6 documentation 3fff::/20', '3fff::'],
    ['IPv6 documentation 3fff::/20', '3fff::10'],
    ['IPv6 documentation 3fff::/20', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['IPv6 benchmarking 2001:2::/48', '2001:2::'],
    ['IPv6 benchmarking 2001:2::/48', '2001:2::10'],
    ['IPv6 benchmarking 2001:2::/48', '2001:2:0:ffff:ffff:ffff:ffff:ffff'],
  ])('blocks %s (%s)', (_name, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  // The IPv6 forms that carry an IPv4 address are classified by the address they carry.
  it.each([
    ['IPv4-mapped, dotted', '::ffff:203.0.113.10'],
    ['IPv4-mapped, hex', '::ffff:cb00:710a'],
    ['NAT64 of TEST-NET-3', '64:ff9b::cb00:710a'],
    ['6to4 of TEST-NET-3', '2002:cb00:710a::1'],
    ['IPv4-compatible of TEST-NET-1', '::c000:20a'],
    ['NAT64 of TEST-NET-2', '64:ff9b::c633:640a'],
  ])('blocks %s (%s)', (_name, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  // A prefix that grows past its block would refuse hosts that are reachable.
  it.each([
    ['the address below TEST-NET-1', '192.0.1.255'],
    ['the address above TEST-NET-1', '192.0.3.0'],
    ['the address below TEST-NET-2', '198.51.99.255'],
    ['the address above TEST-NET-2', '198.51.101.0'],
    ['the address below TEST-NET-3', '203.0.112.255'],
    ['the address above TEST-NET-3', '203.0.114.0'],
    ['the block below 2001:db8::/32', '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['the block above 2001:db8::/32', '2001:db9::1'],
    ['an address past 3fff::/20', '3fff:1000::1'],
    ['the block below 2001:2::/48', '2001:1:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['the block above 2001:2::/48', '2001:2:1::1'],
    ['a public address', '93.184.216.34'],
    ['a public IPv6 address', '2606:4700:4700::1111'],
    ['NAT64 of a public address', '64:ff9b::5db8:d822'],
    ['6to4 of a public address', '2002:5db8:d822::1'],
    // The registry marks these allocations inside 2001::/23 globally reachable, so they are not blocked with it.
    ['AMT 2001:3::/32', '2001:3::1'],
    ['AS112 2001:4:112::/48', '2001:4:112::1'],
    ['ORCHIDv2 2001:20::/28', '2001:20::1'],
    ['2001:30::/28', '2001:30::1'],
    ['an anycast address of 2001:1::/32', '2001:1::1'],
  ])('allows %s (%s)', (_name, address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('resolveSafeFetchTarget: documentation and benchmarking blocks', () => {
  const saved = process.env.SSRF_ALLOWED_HOSTS;

  afterEach(() => {
    if (saved === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
    else process.env.SSRF_ALLOWED_HOSTS = saved;
  });

  it.each([
    ['an IPv4 documentation literal', 'http://203.0.113.10/hook'],
    ['a TEST-NET-1 literal', 'http://192.0.2.10/hook'],
    ['a TEST-NET-2 literal', 'https://198.51.100.10:8443/hook'],
    ['an IPv6 documentation literal', 'http://[2001:db8::10]/hook'],
    ['an IPv6 benchmarking literal', 'http://[2001:2::10]/hook'],
    ['an IPv4-mapped documentation literal', 'http://[::ffff:203.0.113.10]/hook'],
  ])('refuses %s', async (_name, url) => {
    await expect(resolveSafeFetchTarget(url)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('lets an operator name such a host in SSRF_ALLOWED_HOSTS on purpose', async () => {
    process.env.SSRF_ALLOWED_HOSTS = '203.0.113.10';

    await expect(resolveSafeFetchTarget('http://203.0.113.10/hook')).resolves.toEqual([
      expect.objectContaining({ address: '203.0.113.10' }),
    ]);
    await expect(resolveSafeFetchTarget('http://203.0.113.11/hook')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
