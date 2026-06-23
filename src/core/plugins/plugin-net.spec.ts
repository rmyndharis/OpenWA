import { isNetHostAllowed, performPluginFetch } from './plugin-net';
import type { withSafeFetch } from '../../common/security/ssrf-guard';

/** A stand-in for withSafeFetch that hands `use` a canned Response and records the init it was given. */
function fakeSafeFetch(response: Response, sink: { init?: RequestInit }): typeof withSafeFetch {
  return (<T>(_url: string, init: RequestInit, use: (r: Response) => Promise<T> | T): Promise<T> => {
    sink.init = init;
    return Promise.resolve(use(response));
  }) as typeof withSafeFetch;
}

function cannedResponse(body: string, headers: Record<string, string>, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  let read = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: new Headers(headers),
    // Minimal ReadableStream-like body: yields the bytes once, then done.
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(read ? { done: true, value: undefined } : ((read = true), { done: false, value: bytes })),
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Response;
}

describe('isNetHostAllowed', () => {
  it('denies by default (no allowlist)', () => {
    expect(isNetHostAllowed(undefined, 'https://api.example.com/x')).toBe(false);
    expect(isNetHostAllowed([], 'https://api.example.com/x')).toBe(false);
  });

  it("'*' allows any public host (the SSRF guard still blocks internal IPs at fetch time)", () => {
    expect(isNetHostAllowed(['*'], 'https://api.example.com/x')).toBe(true);
    expect(isNetHostAllowed(['*'], 'http://other.example.org:8080/y')).toBe(true);
  });

  it('matches host:port, defaulting the port from the scheme', () => {
    expect(isNetHostAllowed(['api.example.com:443'], 'https://api.example.com/x')).toBe(true);
    expect(isNetHostAllowed(['api.example.com:80'], 'http://api.example.com/x')).toBe(true);
    expect(isNetHostAllowed(['api.example.com:443'], 'https://api.example.com:8443/x')).toBe(false);
  });

  it('a bare host (no port) allows any port on that host', () => {
    expect(isNetHostAllowed(['api.example.com'], 'https://api.example.com:8443/x')).toBe(true);
    expect(isNetHostAllowed(['api.example.com'], 'https://other.example.com/x')).toBe(false);
  });

  it('rejects non-http(s) schemes and unparseable URLs', () => {
    expect(isNetHostAllowed(['*'], 'ftp://api.example.com/x')).toBe(false);
    expect(isNetHostAllowed(['*'], 'file:///etc/passwd')).toBe(false);
    expect(isNetHostAllowed(['*'], 'not a url')).toBe(false);
  });
});

describe('performPluginFetch', () => {
  it('routes through the safe-fetch guard and serializes the response', async () => {
    const sink: { init?: RequestInit } = {};
    const fetcher = fakeSafeFetch(cannedResponse('{"hello":"hi"}', { 'content-type': 'application/json' }), sink);

    const res = await performPluginFetch(
      'https://api.example.com/t',
      { method: 'POST', body: '{}', headers: { 'x-k': 'v' } },
      { fetch: fetcher },
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hello: 'hi' });
    expect(res.headers['content-type']).toBe('application/json');
    // method/headers/body are passed to the guarded fetch (which does the SSRF pinning).
    expect(sink.init?.method).toBe('POST');
    expect(sink.init?.body).toBe('{}');
  });

  it('rejects a response whose declared content-length exceeds the cap', async () => {
    const sink: { init?: RequestInit } = {};
    const big = String(11 * 1024 * 1024);
    const fetcher = fakeSafeFetch(cannedResponse('x', { 'content-length': big }), sink);

    await expect(performPluginFetch('https://api.example.com/t', {}, { fetch: fetcher })).rejects.toThrow(/cap/i);
  });
});
