import {
  isBlockedAddress,
  assertSafeFetchUrl,
  assertNoRedirect,
  SsrfBlockedError,
  isSsrfProtectionEnabled,
  redactSsrfError,
  resolveSafeFetchTarget,
  pinnedLookup,
  withSafeFetch,
} from './ssrf-guard';
import * as dnsPromises from 'dns/promises';
import { getEventListeners } from 'node:events';
import { fetch as undiciFetch, Agent, Headers } from 'undici';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Default to the real resolver (so the localhost/real-DNS cases below behave normally); individual
// tests override a single call with mockResolvedValueOnce to simulate a specific resolution.
jest.mock('dns/promises', () => {
  const actual = jest.requireActual<typeof import('dns/promises')>('dns/promises');
  return { __esModule: true, ...actual, lookup: jest.fn(actual.lookup) };
});

// Mock undici's fetch (keep the real Agent so withSafeFetch builds a real pinned dispatcher).
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

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
    ['fec0::1', 'IPv6 site-local fec0::/10 (deprecated, RFC 3879)'],
    ['feff::1', 'IPv6 site-local upper bound feff'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback (dotted)'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback (hex)'],
    ['::ffff:0a00:0001', 'IPv4-mapped RFC1918 (hex, zero-padded)'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped cloud metadata 169.254.169.254 (hex)'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of cloud metadata 169.254.169.254'],
    ['64:ff9b::7f00:1', 'NAT64 of loopback 127.0.0.1'],
    ['64:ff9b::127.0.0.1', 'NAT64 of loopback (dotted tail)'],
    ['2002:7f00:1::', '6to4 of loopback 127.0.0.1'],
    ['2002:a9fe:a9fe::', '6to4 of cloud metadata 169.254.169.254'],
    ['2002:0a00:0001::', '6to4 of RFC1918 10.0.0.1'],
    ['2002:7f00::', '6to4 of loopback net 127.0.0.0 (low hextet compressed away)'],
    ['2002:a9fe::', '6to4 of metadata net 169.254.0.0 (compressed)'],
    ['2002:c0a8::', '6to4 of RFC1918 net 192.168.0.0 (compressed)'],
    ['::127.0.0.1', 'IPv4-compatible loopback (deprecated, dotted)'],
    ['::a9fe:a9fe', 'IPv4-compatible cloud metadata (deprecated, hex)'],
    ['::ffff:0:7f00:1', 'IPv4-translatable loopback 127.0.0.1 (RFC6052, hex)'],
    ['::ffff:0:127.0.0.1', 'IPv4-translatable loopback (RFC6052, dotted tail)'],
    ['::ffff:0:a9fe:a9fe', 'IPv4-translatable cloud metadata 169.254.169.254 (RFC6052)'],
    ['0:0:0:0:0:ffff:7f00:1', 'fully-expanded IPv4-mapped loopback 127.0.0.1 (hex)'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'fully-expanded IPv4-mapped loopback (dotted tail)'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'fully-expanded IPv4-mapped cloud metadata 169.254.169.254'],
  ])('blocks %s (%s)', ip => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['1.1.1.1', 'public IPv4'],
    ['172.32.0.1', 'just outside 172.16/12'],
    ['2001:4860:4860::8888', 'public IPv6'],
    ['::ffff:0808:0808', 'IPv4-mapped public 8.8.8.8 (hex)'],
    ['2002:0808:0808::', '6to4 of public 8.8.8.8 stays allowed'],
    ['64:ff9b::0808:0808', 'NAT64 of public 8.8.8.8 stays allowed'],
    ['::ffff:0:0808:0808', 'IPv4-translatable public 8.8.8.8 stays allowed'],
    ['0:0:0:0:0:ffff:0808:0808', 'fully-expanded IPv4-mapped public 8.8.8.8 stays allowed (hex)'],
    ['0:0:0:0:0:ffff:8.8.8.8', 'fully-expanded IPv4-mapped public 8.8.8.8 stays allowed (dotted)'],
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
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
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

describe('pinnedLookup (DNS-rebind defense)', () => {
  it('returns the captured addresses and never re-resolves DNS (all: true)', () => {
    const pinned = [{ address: '93.184.216.34', family: 4 }];
    const callback = jest.fn();
    pinnedLookup(pinned)('evil.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, pinned);
  });

  it('returns the first captured address in single-result form (all: false)', () => {
    const pinned = [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];
    const callback = jest.fn();
    pinnedLookup(pinned)('evil.example', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
});

describe('resolveSafeFetchTarget', () => {
  const orig = process.env.SSRF_ALLOWED_HOSTS;
  afterEach(() => {
    if (orig === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
    else process.env.SSRF_ALLOWED_HOSTS = orig;
  });

  it('returns null for a public literal IP (no hostname to rebind)', async () => {
    await expect(resolveSafeFetchTarget('https://8.8.8.8/hook')).resolves.toBeNull();
  });

  it('returns null for an allowlisted host (trusted, no pin needed)', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'minio';
    await expect(resolveSafeFetchTarget('http://minio:9000/x.png')).resolves.toBeNull();
  });

  it('throws for a blocked literal address', async () => {
    await expect(resolveSafeFetchTarget('http://127.0.0.1/x')).rejects.toThrow(SsrfBlockedError);
  });

  it('returns the resolved public addresses for a hostname (the IPs to pin to)', async () => {
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    await expect(resolveSafeFetchTarget('https://example.com/hook')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('throws when a hostname resolves to a blocked address', async () => {
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(resolveSafeFetchTarget('https://rebind.example/hook')).rejects.toThrow(SsrfBlockedError);
  });

  it('maps a DNS lookup failure (rejection) to SsrfBlockedError instead of leaking a raw error', async () => {
    // A rejected lookup (NXDOMAIN, or a transient EAI_AGAIN under resolver pressure) must become a
    // typed SsrfBlockedError so callers map it to a 4xx. A raw error here leaks as a generic 500 —
    // the intermittent failure seen at webhook registration (POST /sessions/:id/webhooks).
    (dnsPromises.lookup as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND nxdomain.example'), { code: 'ENOTFOUND' }),
    );
    await expect(resolveSafeFetchTarget('https://nxdomain.example/hook')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects when DNS resolution exceeds the deadline (a hanging resolver cannot pin a worker)', async () => {
    const prev = process.env.SSRF_DNS_TIMEOUT_MS;
    process.env.SSRF_DNS_TIMEOUT_MS = '30';
    (dnsPromises.lookup as jest.Mock).mockReturnValueOnce(new Promise(() => undefined)); // never resolves
    try {
      await expect(resolveSafeFetchTarget('https://slow.example/hook')).rejects.toThrow(/timed out resolving/i);
    } finally {
      if (prev === undefined) delete process.env.SSRF_DNS_TIMEOUT_MS;
      else process.env.SSRF_DNS_TIMEOUT_MS = prev;
    }
  }, 1000);
});

describe('withSafeFetch (guarded + pinned fetch)', () => {
  afterEach(() => {
    (undiciFetch as jest.Mock).mockReset();
  });

  it('rejects a blocked host before performing any fetch (fail-closed)', async () => {
    const use = jest.fn();
    await expect(withSafeFetch('http://127.0.0.1/hook', {}, use, { guard: true })).rejects.toThrow(SsrfBlockedError);
    expect(use).not.toHaveBeenCalled();
  });

  it('pins the connection by passing a dispatcher to fetch for a hostname target', async () => {
    // The security property: for a DNS hostname the connection MUST go through a pinned dispatcher,
    // else fetch re-resolves DNS independently and the rebind window reopens. Removing the pin
    // (dispatcher = undefined) makes this fail.
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'used');

    const result = await withSafeFetch('https://example.com/hook', { method: 'POST' }, use, { guard: true });

    expect(result).toBe('used');
    expect(use).toHaveBeenCalledTimes(1);
    const [url, init] = (undiciFetch as jest.Mock).mock.calls[0] as [string, { redirect: string; dispatcher: unknown }];
    expect(url).toBe('https://example.com/hook');
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBeDefined();
  });

  it('refuses a redirect on the pinned path (real undici manual-redirect shape: 302/basic)', async () => {
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({ status: 302, type: 'basic' });

    await expect(withSafeFetch('https://example.com/hook', {}, jest.fn(), { guard: true })).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('skips validation and pinning entirely when guard is false (SSRF opt-out)', async () => {
    (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'ok');

    // An internal host would normally be blocked — with guard:false it is delivered unpinned.
    const result = await withSafeFetch('http://127.0.0.1/hook', {}, use, { guard: false });

    expect(result).toBe('ok');
    const [, init] = (undiciFetch as jest.Mock).mock.calls[0] as [string, { redirect: string; dispatcher: unknown }];
    expect(init.redirect).toBe('follow');
    expect(init.dispatcher).toBeUndefined();
  });

  it('follows redirects hop-by-hop, re-validating each target and delivering the final 200 (download path)', async () => {
    // GitHub Releases 302 to a CDN; the download path must follow (not refuse) redirects — but by
    // fetching each hop with `redirect: 'manual'` and re-running resolveSafeFetchTarget on the
    // Location, so every hop is checked BEFORE its socket opens. Here hop 0 is a 302 to a second
    // hostname, and hop 1 is the final 200 delivered to `use`.
    (dnsPromises.lookup as jest.Mock)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // github.com
      .mockResolvedValueOnce([{ address: '185.199.108.153', family: 4 }]); // objects.githubusercontent.com
    (undiciFetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 302,
        type: 'basic',
        headers: new Map([['location', 'https://objects.githubusercontent.com/cdn/p.zip']]),
      })
      .mockResolvedValueOnce({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'downloaded');

    const result = await withSafeFetch('https://github.com/x/releases/download/v1/p.zip', {}, use, {
      followRedirects: true,
    });

    expect(result).toBe('downloaded');
    expect(use).toHaveBeenCalledTimes(1);
    // Both hops are fetched manually (undici never follows on its own) and each carries a dispatcher.
    const calls = (undiciFetch as jest.Mock).mock.calls as Array<[string, { redirect: string; dispatcher: unknown }]>;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('https://github.com/x/releases/download/v1/p.zip');
    expect(calls[1][0]).toBe('https://objects.githubusercontent.com/cdn/p.zip');
    for (const [, init] of calls) {
      expect(init.redirect).toBe('manual');
      expect(init.dispatcher).toBeDefined();
    }
  });

  it('still rejects an internal ORIGINAL url even with followRedirects (scheme/host validated first)', async () => {
    const use = jest.fn();
    await expect(withSafeFetch('http://127.0.0.1/p.zip', {}, use, { followRedirects: true })).rejects.toThrow(
      SsrfBlockedError,
    );
    expect(use).not.toHaveBeenCalled();
  });

  it('refuses a redirect hop that downgrades from https to http', async () => {
    // The payload on this path is executable code, so the caller forces https on the initial URL;
    // a 302 to a plain-http hop would expose the bytes to on-path substitution. The refusal must
    // happen BEFORE that hop's socket opens.
    const savedHatch = process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS;
    delete process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS; // pin the secure default
    try {
      (dnsPromises.lookup as jest.Mock)
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      (undiciFetch as jest.Mock).mockResolvedValueOnce({
        status: 302,
        type: 'basic',
        headers: new Map([['location', 'http://cdn.example.com/p.zip']]),
      });
      const use = jest.fn();

      await expect(
        withSafeFetch('https://github.com/x/releases/p.zip', {}, use, { followRedirects: true }),
      ).rejects.toThrow(/downgrades from https to http/);
      expect(use).not.toHaveBeenCalled();
      expect(undiciFetch as jest.Mock).toHaveBeenCalledTimes(1);
    } finally {
      if (savedHatch === undefined) delete process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS;
      else process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS = savedHatch;
    }
  });

  it('allows a chain that started on plain http (no downgrade — it never was secure)', async () => {
    (dnsPromises.lookup as jest.Mock)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 302,
        type: 'basic',
        headers: new Map([['location', 'http://mirror.example.com/catalog.json']]),
      })
      .mockResolvedValueOnce({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'catalog');

    const result = await withSafeFetch('http://plugins.internal.example/catalog.json', {}, use, {
      followRedirects: true,
    });

    expect(result).toBe('catalog');
    expect(undiciFetch as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('follows an https→http hop only when the insecure-redirect escape hatch is enabled', async () => {
    const savedHatch = process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS;
    process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS = 'true';
    try {
      (dnsPromises.lookup as jest.Mock)
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      (undiciFetch as jest.Mock)
        .mockResolvedValueOnce({
          status: 302,
          type: 'basic',
          headers: new Map([['location', 'http://cdn.example.com/p.zip']]),
        })
        .mockResolvedValueOnce({ status: 200, type: 'basic' });
      const use = jest.fn(() => 'downloaded');

      const result = await withSafeFetch('https://github.com/x/releases/p.zip', {}, use, {
        followRedirects: true,
      });

      expect(result).toBe('downloaded');
      expect(undiciFetch as jest.Mock).toHaveBeenCalledTimes(2);
    } finally {
      if (savedHatch === undefined) delete process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS;
      else process.env.PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS = savedHatch;
    }
  });

  it('strips credentials on a cross-origin hop and rewrites 303 to a bodiless GET', async () => {
    (dnsPromises.lookup as jest.Mock)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 303,
        type: 'basic',
        headers: new Map([['location', 'https://cdn.example.com/p']]),
      })
      .mockResolvedValueOnce({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'ok');
    const init = {
      method: 'POST',
      body: 'payload',
      headers: { authorization: 'Bearer secret', 'x-custom': 'keep' },
    };

    await withSafeFetch('https://api.example.com/upload', init, use, { followRedirects: true });

    const calls = (undiciFetch as jest.Mock).mock.calls as Array<
      [string, { method?: string; body?: unknown; headers?: Headers }]
    >;
    const hop2 = calls[1][1];
    expect(hop2.method).toBe('GET');
    expect(hop2.body).toBeUndefined();
    expect(hop2.headers?.get('authorization')).toBeNull();
    expect(hop2.headers?.get('x-custom')).toBe('keep');
  });

  it('keeps credentials on a same-origin hop', async () => {
    (dnsPromises.lookup as jest.Mock)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 302,
        type: 'basic',
        headers: new Map([['location', 'https://api.example.com/other']]),
      })
      .mockResolvedValueOnce({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'ok');
    const init = { headers: { authorization: 'Bearer secret' } };

    await withSafeFetch('https://api.example.com/first', init, use, { followRedirects: true });

    const calls = (undiciFetch as jest.Mock).mock.calls as Array<
      [string, { headers?: Headers | Record<string, string> }]
    >;
    const hop2Headers = calls[1][1].headers;
    const auth = hop2Headers instanceof Headers ? hop2Headers.get('authorization') : hop2Headers?.authorization;
    expect(auth).toBe('Bearer secret');
  });

  it('surfaces the hop-cap error verbatim (not redacted to the generic SSRF message)', async () => {
    // A legit >5-hop chain must be distinguishable from an SSRF block: the operator needs the real
    // cause, and the message carries only the caller-supplied URL — nothing internal to redact.
    for (let i = 0; i < 6; i++) {
      (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    }
    (undiciFetch as jest.Mock).mockResolvedValue({
      status: 302,
      type: 'basic',
      headers: new Map([['location', 'https://cdn.example.com/next']]),
    });
    const use = jest.fn(() => 'ok');

    const error: unknown = await withSafeFetch('https://github.com/x/releases/p.zip', {}, use, {
      followRedirects: true,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Too many redirects');
    expect(redactSsrfError(error)).toContain('Too many redirects');
  });

  it('cancels an unread response body before tearing down the dispatcher (#887)', async () => {
    // Status-only callers leave the body unread; if we destroy the Agent while the stream is still
    // open, undici can emit TypeError: terminated / ECONNRESET as an uncaughtException. Cancelling
    // the unread body before destroy closes that path.
    const cancel = jest.fn().mockResolvedValue(undefined);
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({
      status: 200,
      type: 'basic',
      bodyUsed: false,
      body: { cancel },
    });
    const use = jest.fn(() => ({ ok: true, status: 200 }));

    await expect(withSafeFetch('https://example.com/hook', {}, use, { guard: true })).resolves.toEqual({
      ok: true,
      status: 200,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a body the caller already consumed', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({
      status: 200,
      type: 'basic',
      bodyUsed: true,
      body: { cancel },
    });

    await withSafeFetch('https://example.com/hook', {}, () => 'consumed', { guard: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('still cancels an unread body when use throws', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({
      status: 500,
      type: 'basic',
      bodyUsed: false,
      body: { cancel },
    });

    await expect(
      withSafeFetch(
        'https://example.com/hook',
        {},
        () => {
          throw new Error('HTTP 500');
        },
        { guard: true },
      ),
    ).rejects.toThrow('HTTP 500');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels an unread body when the response is a refused redirect (#887)', async () => {
    // assertNoRedirect throws before `use` runs; the settle must still happen so a refused 3xx
    // cannot reach dispatcher.destroy() with an unread body either.
    const cancel = jest.fn().mockResolvedValue(undefined);
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({
      status: 302,
      type: 'basic',
      bodyUsed: false,
      body: { cancel },
    });
    const use = jest.fn();

    await expect(withSafeFetch('https://example.com/hook', {}, use, { guard: true })).rejects.toThrow(SsrfBlockedError);
    expect(use).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejection from the unread-body cancel so teardown never throws (#887)', async () => {
    // cancel() itself can reject (the very "terminated" error we cancel to avoid). Swallowing it keeps
    // teardown from turning a delivery into a crash.
    const cancel = jest.fn().mockRejectedValue(new Error('terminated'));
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic', bodyUsed: false, body: { cancel } });

    await expect(withSafeFetch('https://example.com/hook', {}, () => 'ok', { guard: true })).resolves.toBe('ok');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the unread body BEFORE destroying the dispatcher — the ordering is the fix (#887)', async () => {
    // A refactor swapping the two `finally` steps would re-open the crash path while keeping every
    // call-count assertion green; pin the order explicitly.
    const cancel = jest.fn().mockResolvedValue(undefined);
    const destroy = jest.spyOn(Agent.prototype, 'destroy').mockResolvedValue(undefined);
    try {
      (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic', bodyUsed: false, body: { cancel } });

      await withSafeFetch('https://example.com/hook', {}, () => 'ok', { guard: true });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]);
    } finally {
      destroy.mockRestore();
    }
  });

  it('leaves a locked body stream to its reader (cancel on a locked stream would reject)', async () => {
    // A caller that acquired a reader but never read has bodyUsed === false yet a locked stream;
    // the settle must skip it — cancelling someone else's locked stream is not safe.
    const cancel = jest.fn().mockResolvedValue(undefined);
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({
      status: 200,
      type: 'basic',
      bodyUsed: false,
      body: { cancel, locked: true },
    });

    await withSafeFetch('https://example.com/hook', {}, () => 'ok', { guard: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('tolerates a duck-typed body without a cancel method instead of throwing from the finally', async () => {
    (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic', bodyUsed: false, body: {} });

    await expect(withSafeFetch('https://example.com/hook', {}, () => 'ok', { guard: true })).resolves.toBe('ok');
  });

  it('swallows a rejection from the dispatcher teardown on the pinned path', async () => {
    const destroy = jest.spyOn(Agent.prototype, 'destroy').mockRejectedValue(new Error('destroy failed'));
    try {
      (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic', bodyUsed: true, body: {} });

      await expect(withSafeFetch('https://example.com/hook', {}, () => 'ok', { guard: true })).resolves.toBe('ok');
      expect(destroy).toHaveBeenCalled();
    } finally {
      destroy.mockRestore();
    }
  });

  it('swallows a rejection from the dispatcher teardown on the redirect-following path', async () => {
    const destroy = jest.spyOn(Agent.prototype, 'destroy').mockRejectedValue(new Error('destroy failed'));
    try {
      (dnsPromises.lookup as jest.Mock).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      (undiciFetch as jest.Mock).mockResolvedValue({ status: 200, type: 'basic', bodyUsed: true, body: {} });

      await expect(
        withSafeFetch('https://github.com/x/releases/download/v1/p.zip', {}, () => 'ok', { followRedirects: true }),
      ).resolves.toBe('ok');
      expect(destroy).toHaveBeenCalled();
    } finally {
      destroy.mockRestore();
    }
  });
});

describe('withSafeFetch DNS phase honors the caller abort signal', () => {
  afterEach(() => {
    (undiciFetch as jest.Mock).mockReset();
  });

  it('a pre-aborted signal skips DNS entirely and rejects with the abort reason', async () => {
    const lookupSpy = dnsPromises.lookup as jest.Mock;
    lookupSpy.mockClear();
    const signal = AbortSignal.abort(new Error('already dead'));

    await expect(
      withSafeFetch('https://plugins.example.com/p.zip', { signal }, jest.fn(), { followRedirects: true }),
    ).rejects.toThrow('already dead');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('a wedged DNS lookup is cut by the caller timeout, not by the 10s DNS deadline', async () => {
    (dnsPromises.lookup as jest.Mock).mockReturnValueOnce(new Promise<never>(() => undefined)); // never settles
    const use = jest.fn();

    const started = Date.now();
    await expect(
      withSafeFetch('https://plugins.example.com/p.zip', { signal: AbortSignal.timeout(30) }, use, {
        followRedirects: true,
      }),
    ).rejects.toThrow(/aborted due to timeout/i);
    expect(Date.now() - started).toBeLessThan(1000); // ~30ms — not the 10s DNS deadline
    expect(use).not.toHaveBeenCalled();
  });

  it('a signal fired mid-chain ends the loop at the next hop resolve', async () => {
    (dnsPromises.lookup as jest.Mock)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // hop 0 resolves
      .mockReturnValueOnce(new Promise<never>(() => undefined)); // hop 1 DNS wedges
    (undiciFetch as jest.Mock).mockResolvedValueOnce({
      status: 302,
      type: 'basic',
      headers: new Map([['location', 'https://cdn.example.com/p.zip']]),
    });
    const use = jest.fn();

    await expect(
      withSafeFetch('https://github.com/x/p.zip', { signal: AbortSignal.timeout(30) }, use, {
        followRedirects: true,
      }),
    ).rejects.toThrow(/aborted due to timeout/i);
    expect(undiciFetch as jest.Mock).toHaveBeenCalledTimes(1); // hop 1 never fetched
  });

  it('removes its abort listener once each hop settles (no listener accumulation across a chain)', async () => {
    const controller = new AbortController();
    (dnsPromises.lookup as jest.Mock)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    (undiciFetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 302,
        type: 'basic',
        headers: new Map([['location', 'https://cdn.example.com/p.zip']]),
      })
      .mockResolvedValueOnce({ status: 200, type: 'basic' });
    const use = jest.fn(() => 'ok');

    await withSafeFetch('https://github.com/x/p.zip', { signal: controller.signal }, use, {
      followRedirects: true,
    });

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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

// Real-server proof that the followRedirects download path validates EVERY hop. The per-hop guard
// runs resolveSafeFetchTarget on the Location before any socket opens to it, so a 302 whose target
// is a blocked IP literal (which Node never sends through DNS, defeating a connect.lookup guard)
// is refused before connecting.
describe('withSafeFetch followRedirects validates every hop over real sockets', () => {
  const realFetch = jest.requireActual<typeof import('undici')>('undici').fetch;
  let savedAllowedHosts: string | undefined;

  beforeEach(() => {
    // Restore the real fetch so the redirect chain actually connects to the local test servers.
    (undiciFetch as unknown as jest.Mock).mockImplementation(realFetch);
    savedAllowedHosts = process.env.SSRF_ALLOWED_HOSTS;
    process.env.SSRF_ALLOWED_HOSTS = 'localhost'; // the redirector host is reached over an allowed host
  });

  afterEach(() => {
    process.env.SSRF_ALLOWED_HOSTS = savedAllowedHosts;
    (undiciFetch as unknown as jest.Mock).mockReset();
  });

  it('refuses a redirect to a blocked IP literal before opening a socket to it', async () => {
    const internal = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('INTERNAL-SECRET-DATA');
    });
    await new Promise<void>(resolve => internal.listen(0, '127.0.0.1', resolve));
    const internalPort = (internal.address() as AddressInfo).port;

    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` });
      res.end();
    });
    await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorPort = (redirector.address() as AddressInfo).port;

    try {
      // The redirector is reached over an allowlisted host so the FIRST hop passes; the second hop
      // is a blocked literal and must be refused before any socket is opened to it.
      await expect(
        withSafeFetch(`http://localhost:${redirectorPort}/`, {}, async response => await response.text(), {
          followRedirects: true,
        }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    } finally {
      await new Promise<void>(resolve => internal.close(() => resolve()));
      await new Promise<void>(resolve => redirector.close(() => resolve()));
    }
  });

  it('still follows a redirect to an allowed destination', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK-PAYLOAD');
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as AddressInfo).port;

    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${targetPort}/` });
      res.end();
    });
    await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorPort = (redirector.address() as AddressInfo).port;

    try {
      const body = await withSafeFetch(
        `http://localhost:${redirectorPort}/`,
        {},
        async response => await response.text(),
        {
          followRedirects: true,
        },
      );
      expect(body).toBe('OK-PAYLOAD');
    } finally {
      await new Promise<void>(resolve => target.close(() => resolve()));
      await new Promise<void>(resolve => redirector.close(() => resolve()));
    }
  });

  it('refuses a redirect chain longer than the hop cap', async () => {
    const server = createServer((_req, res) => {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(302, { location: `http://localhost:${port}/next` });
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      // An actionable operator error (not a blocked address), so it is not an SsrfBlockedError.
      await expect(
        withSafeFetch(`http://localhost:${port}/`, {}, async response => await response.text(), {
          followRedirects: true,
        }),
      ).rejects.toThrow(/Too many redirects/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
