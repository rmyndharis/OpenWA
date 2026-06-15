import {
  isBlockedAddress,
  assertSafeFetchUrl,
  assertNoRedirect,
  SsrfBlockedError,
  isSsrfProtectionEnabled,
} from './ssrf-guard';

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['10.1.2.3', 'RFC1918 10/8'],
    ['172.16.5.5', 'RFC1918 172.16/12'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['100.64.0.1', 'CGNAT 100.64/10'],
    ['0.0.0.0', 'unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'IPv6 ULA fc00::/7'],
    ['fd12:3456::1', 'IPv6 ULA fd'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback (dotted)'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback (hex)'],
    ['::ffff:0a00:0001', 'IPv4-mapped RFC1918 (hex, zero-padded)'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped cloud metadata 169.254.169.254 (hex)'],
  ])('blocks %s (%s)', ip => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['1.1.1.1', 'public IPv4'],
    ['172.32.0.1', 'just outside 172.16/12'],
    ['2001:4860:4860::8888', 'public IPv6'],
    ['::ffff:0808:0808', 'IPv4-mapped public 8.8.8.8 (hex)'],
  ])('allows %s (%s)', ip => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertSafeFetchUrl', () => {
  it('rejects a non-http(s) scheme', async () => {
    await expect(assertSafeFetchUrl('ftp://example.com/hook')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects a literal loopback IPv4 host', async () => {
    await expect(assertSafeFetchUrl('http://127.0.0.1/hook')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects the cloud metadata IP', async () => {
    await expect(assertSafeFetchUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects a literal IPv6 loopback host', async () => {
    await expect(assertSafeFetchUrl('http://[::1]:8080/hook')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects a hostname that resolves to loopback (localhost)', async () => {
    await expect(assertSafeFetchUrl('http://localhost:9999/hook')).rejects.toThrow(SsrfBlockedError);
  });

  it('allows a public literal IP', async () => {
    await expect(assertSafeFetchUrl('https://8.8.8.8/hook')).resolves.toBeUndefined();
  });
});

describe('assertSafeFetchUrl — SSRF_ALLOWED_HOSTS escape-hatch', () => {
  const orig = process.env.SSRF_ALLOWED_HOSTS;
  afterEach(() => {
    if (orig === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
    else process.env.SSRF_ALLOWED_HOSTS = orig;
  });

  it('allows an internal host that is explicitly allowlisted (case-insensitive)', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'Localhost, minio';
    await expect(assertSafeFetchUrl('http://localhost:9000/bucket/x.png')).resolves.toBeUndefined();
    await expect(assertSafeFetchUrl('http://minio:9000/x.png')).resolves.toBeUndefined();
  });

  it('still blocks internal hosts that are NOT allowlisted', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'minio';
    await expect(assertSafeFetchUrl('http://127.0.0.1/x.png')).rejects.toThrow(SsrfBlockedError);
  });

  it('allows an allowlisted literal internal IP', async () => {
    process.env.SSRF_ALLOWED_HOSTS = '10.0.0.5';
    await expect(assertSafeFetchUrl('http://10.0.0.5/x.png')).resolves.toBeUndefined();
  });

  it('allows an allowlisted IPv6 literal whether or not it is bracketed', async () => {
    // The URL hostname is compared bracket-stripped, so a bracketed allowlist entry
    // (as copy-pasted from a URL) must still match.
    process.env.SSRF_ALLOWED_HOSTS = '[::1]';
    await expect(assertSafeFetchUrl('http://[::1]:8080/hook')).resolves.toBeUndefined();

    process.env.SSRF_ALLOWED_HOSTS = '::1';
    await expect(assertSafeFetchUrl('http://[::1]:8080/hook')).resolves.toBeUndefined();
  });
});

describe('assertNoRedirect (redirect bypass)', () => {
  it('throws on an undici opaqueredirect response', () => {
    expect(() => assertNoRedirect({ status: 0, type: 'opaqueredirect' }, 'http://evil.example')).toThrow(
      SsrfBlockedError,
    );
  });

  it('throws on a 3xx status (node-fetch manual)', () => {
    expect(() => assertNoRedirect({ status: 302 }, 'http://evil.example')).toThrow(SsrfBlockedError);
    expect(() => assertNoRedirect({ status: 301 }, 'http://evil.example')).toThrow(SsrfBlockedError);
  });

  it('passes a normal 2xx response', () => {
    expect(() => assertNoRedirect({ status: 200, type: 'basic' }, 'http://ok.example')).not.toThrow();
  });
});

describe('isSsrfProtectionEnabled', () => {
  const orig = process.env.WEBHOOK_SSRF_PROTECT;
  afterEach(() => {
    process.env.WEBHOOK_SSRF_PROTECT = orig;
  });

  it('is ON by default and off only when explicitly "false"', () => {
    delete process.env.WEBHOOK_SSRF_PROTECT;
    expect(isSsrfProtectionEnabled()).toBe(true);
    process.env.WEBHOOK_SSRF_PROTECT = 'true';
    expect(isSsrfProtectionEnabled()).toBe(true);
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    expect(isSsrfProtectionEnabled()).toBe(false);
  });
});
