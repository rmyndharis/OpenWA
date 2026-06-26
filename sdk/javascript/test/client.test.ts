import { describe, expect, it } from 'vitest';
import {
  OpenWAClient,
  OpenWAApiError,
  OpenWAAuthError,
  OpenWAForbiddenError,
  OpenWANotFoundError,
  OpenWAConflictError,
  OpenWARateLimitError,
  OpenWANotImplementedError,
  OpenWATimeoutError,
} from '../src';
import type { FetchLike } from '../src';
import { MockTransport } from './helpers';

function client(transport: MockTransport): OpenWAClient {
  return new OpenWAClient({
    baseUrl: 'http://localhost:2785',
    apiKey: 'owa_k1_test',
    fetch: transport.asFetch(),
  });
}

describe('OpenWAClient', () => {
  it('requires baseUrl and apiKey', () => {
    expect(() => new OpenWAClient({ baseUrl: '', apiKey: 'x' })).toThrow();
    expect(() => new OpenWAClient({ baseUrl: 'http://x', apiKey: '' })).toThrow();
  });

  it('sends the API key as X-API-Key and JSON content type', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', { body: [] });
    await client(t).sessions.list();
    expect(t.lastCall!.headers['x-api-key']).toBe('owa_k1_test');
    expect(t.lastCall!.headers['content-type']).toBe('application/json');
  });

  it('strips a trailing slash from baseUrl', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', { body: [] });
    const c = new OpenWAClient({ baseUrl: 'http://localhost:2785/', apiKey: 'k', fetch: t.asFetch() });
    await c.sessions.list();
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions');
  });

  it('does not auto-follow redirects (passes redirect: manual to fetch)', async () => {
    // Auto-following a redirect would re-send X-API-Key to the redirect target,
    // potentially a different origin. The SDK must not follow silently.
    let seenInit: RequestInit | undefined;
    const recordingFetch: FetchLike = async (_url, init) => {
      seenInit = init as RequestInit;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const c = new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: recordingFetch });
    await c.health.check();
    expect(seenInit?.redirect).toBe('manual');
  });

  it('treats an unfollowed redirect (3xx) as an error', async () => {
    // Redirects are never followed, so a 3xx is not a usable response — it must throw, keeping the
    // JS transport aligned with the Python and PHP SDKs (which now also error on >= 300).
    const redirectingFetch: FetchLike = async () =>
      new Response('{"redirected":true}', { status: 302, headers: { location: 'http://evil.example/x' } });
    const c = new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: redirectingFetch });
    await expect(c.sessions.list()).rejects.toThrow();
  });

  it('surfaces a real opaque unfollowed redirect (status 0) as a clear OpenWAApiError', async () => {
    // With `redirect: 'manual'` the runtime returns an opaque response with status 0 (not a 3xx);
    // this is the actual shape the no-redirect guard produces, and it must throw a clear error.
    const opaqueRedirectFetch: FetchLike = async () => Response.error();
    const c = new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: opaqueRedirectFetch });
    const err = await c.sessions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenWAApiError);
    expect((err as OpenWAApiError).status).toBe(0);
    expect((err as OpenWAApiError).message).toMatch(/redirect/i);
  });

  it('percent-encodes path segments but keeps @ in JIDs readable', async () => {
    const t = new MockTransport().on('GET', /\/history$/, { body: [] });
    await client(t).messages.history('s', 'a@c.us');
    expect(t.lastCall!.url).toContain('/messages/a@c.us/history'); // @ preserved
    const t2 = new MockTransport().on('GET', /\/history$/, { body: [] });
    await client(t2).messages.history('s', 'weird/id#x');
    expect(t2.lastCall!.url).toContain('weird%2Fid%23x'); // path-breaking chars encoded
  });

  it('serializes query params and skips null/undefined', async () => {
    const t = new MockTransport().on('GET', /\/messages/, { body: [] });
    await client(t).messages.list('s1', { chatId: 'a@c.us', from: undefined, limit: 10 });
    expect(t.lastCall!.url).toContain('chatId=a%40c.us');
    expect(t.lastCall!.url).toContain('limit=10');
    expect(t.lastCall!.url).not.toContain('from=');
  });

  it('maps a 404 to OpenWANotFoundError with parsed body', async () => {
    const t = new MockTransport().on('GET', '/api/sessions/missing', {
      status: 404,
      body: { statusCode: 404, message: 'Session not found', error: 'Not Found' },
    });
    await expect(client(t).sessions.get('missing')).rejects.toBeInstanceOf(OpenWANotFoundError);
    await expect(client(t).sessions.get('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('exposes all expected resource properties', () => {
    const c = client(new MockTransport());
    for (const r of ['sessions', 'messages', 'contacts', 'groups', 'webhooks', 'chats', 'status', 'health']) {
      expect(c).toHaveProperty(r);
    }
  });

  it('treats 204 as a null result', async () => {
    const t = new MockTransport().on('DELETE', '/api/sessions/x', { status: 204 });
    await expect(client(t).sessions.delete('x')).resolves.toBeNull();
  });

  it('OpenWAApiError.fromResponse parses the NestJS envelope', async () => {
    const t = new MockTransport().on('POST', /send-text/, {
      status: 409,
      body: { statusCode: 409, message: 'Engine not ready', error: 'Conflict' },
    });
    await expect(client(t).messages.sendText('s', { chatId: 'a@c.us', text: 'hi' })).rejects.toBeInstanceOf(
      OpenWAApiError,
    );
  });

  it('maps each status code to its typed error subclass', async () => {
    const cases: Array<[number, new (...a: never[]) => OpenWAApiError]> = [
      [401, OpenWAAuthError],
      [403, OpenWAForbiddenError],
      [404, OpenWANotFoundError],
      [409, OpenWAConflictError],
      [429, OpenWARateLimitError],
      [501, OpenWANotImplementedError],
    ];
    for (const [status, cls] of cases) {
      const t = new MockTransport().on('GET', '/api/sessions', {
        status,
        body: { statusCode: status, message: 'x', error: 'E' },
      });
      await expect(client(t).sessions.list()).rejects.toBeInstanceOf(cls);
    }
  });

  it('falls back to the generic OpenWAApiError (with .status) for an unmapped status', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', {
      status: 418,
      body: { statusCode: 418, message: 'teapot', error: 'Teapot' },
    });
    await expect(client(t).sessions.list()).rejects.toMatchObject({ status: 418 });
    await expect(client(t).sessions.list()).rejects.toBeInstanceOf(OpenWAApiError);
  });

  it('throws OpenWATimeoutError when the request aborts', async () => {
    const abortingFetch: FetchLike = async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    };
    const c = new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: abortingFetch });
    await expect(c.sessions.list()).rejects.toBeInstanceOf(OpenWATimeoutError);
  });

  it('keeps X-API-Key winning over defaultHeaders', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', { body: [] });
    const c = new OpenWAClient({
      baseUrl: 'http://x',
      apiKey: 'REAL',
      defaultHeaders: { 'X-API-Key': 'EVIL', 'X-Trace': 'keep' },
      fetch: t.asFetch(),
    });
    await c.sessions.list();
    expect(t.lastCall!.headers['x-api-key']).toBe('REAL');
    expect(t.lastCall!.headers['x-trace']).toBe('keep');
  });

  it('keeps the JSON Content-Type winning over a defaultHeaders override', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', { body: [] });
    const c = new OpenWAClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      defaultHeaders: { 'Content-Type': 'text/plain', 'X-Trace': 'keep' },
      fetch: t.asFetch(),
    });
    await c.sessions.list();
    // JSON wins (matches the Python/PHP SDKs), but an unrelated default header is still preserved.
    expect(t.lastCall!.headers['content-type']).toBe('application/json');
    expect(t.lastCall!.headers['x-trace']).toBe('keep');
  });
});
