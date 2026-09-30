import { describe, expect, it, vi } from 'vitest';
import {
  OpenWAClient,
  OpenWAApiError,
  OpenWAAuthError,
  OpenWAForbiddenError,
  OpenWANotFoundError,
  OpenWAConflictError,
  OpenWARateLimitError,
  OpenWANotImplementedError,
  OpenWAServiceUnavailableError,
  OpenWATimeoutError,
} from '../src';
import type { FetchLike } from '../src';
import { MockTransport, type MockResponseSpec } from './helpers';

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

  it('refuses an empty or dot id instead of letting fetch collapse the path to the parent resource', async () => {
    const t = new MockTransport().passthrough({ status: 204 });
    const c = client(t);
    await expect(c.webhooks.delete('s1', '..')).rejects.toThrow(TypeError);
    await expect(c.contacts.delete('s1', '.')).rejects.toThrow(TypeError);
    await expect(c.templates.delete('s1', '')).rejects.toThrow(TypeError);
    await expect(c.request({ method: 'DELETE', path: '/api/sessions/s1/labels/%2E%2e' })).rejects.toThrow(TypeError);
    // The URL parser also reads `\` as `/`, drops tab and newline, and trims trailing controls and spaces.
    for (const tail of ['labels\\..', 'labels/\t..', 'labels/.\n.', 'labels/.. ']) {
      const path = `/api/sessions/s1/${tail}`;
      await expect(c.request({ method: 'DELETE', path })).rejects.toThrow(TypeError);
    }
    expect(t.calls).toHaveLength(0);

    // Dots inside an id, and a dot-only query value, are not path segments and still go out.
    await c.webhooks.delete('s1', '628123@c.us');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s1/webhooks/628123@c.us');
    await c.request({ method: 'GET', path: '/api/sessions/s1/labels/a.b?x=/..' });
    expect(t.calls).toHaveLength(2);
  });

  it('sends a raw path with a trailing slash, a double slash or only a slash as written', async () => {
    const t = new MockTransport().passthrough({ status: 200, body: [] });
    const c = client(t);
    for (const path of ['/api/sessions/', '/api/sessions//x', '/']) {
      await c.request({ method: 'GET', path });
      expect(t.lastCall!.url).toBe(`http://localhost:2785${path}`);
    }
    await c.requestBytes({ method: 'GET', path: '/api/search/', query: { q: 'x' } });
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/search/?q=x');
    // A space before an appended query is not trailing, so `.. ` is sent as `..%20`, not as a dot segment.
    await c.request({ method: 'GET', path: '/api/labels/.. ', query: { q: 'x' } });
    expect(t.calls).toHaveLength(5);
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

  it('maps a 503 to OpenWAServiceUnavailableError', async () => {
    // The gateway answers 503 when the engine never confirmed an operation: a transport failure, which
    // is worth retrying, as a 429 is. It used to fall through to the base class while 501, which is
    // permanent, had a subclass of its own.
    const t = new MockTransport().on('POST', '/api/sessions/s1/messages/send-text', {
      status: 503,
      body: { statusCode: 503, message: 'WhatsApp did not answer in time', error: 'Service Unavailable' },
    });
    await expect(client(t).messages.sendText('s1', { chatId: 'c@c.us', text: 'x' })).rejects.toBeInstanceOf(
      OpenWAServiceUnavailableError,
    );
  });

  it('renders a non-envelope error body as JSON in the message', async () => {
    // The readiness probe answers 503 with `{ status, details }`, which has no `statusCode`/`message`.
    const t = new MockTransport().on('GET', '/api/health/ready', {
      status: 503,
      body: { status: 'error', details: { mainDatabase: { status: 'down' } } },
    });
    const err = await client(t)
      .health.ready()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenWAServiceUnavailableError);
    expect((err as OpenWAApiError).message).toContain('"mainDatabase":{"status":"down"}');
    expect((err as OpenWAApiError).message).not.toContain('[object Object]');
  });

  it('exposes all expected resource properties', () => {
    const c = client(new MockTransport());
    for (const r of [
      'sessions',
      'messages',
      'contacts',
      'groups',
      'webhooks',
      'chats',
      'status',
      'health',
      'labels',
      'channels',
      'catalog',
      'templates',
      'search',
      'profile',
      'calls',
    ]) {
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

  // A stock production gateway runs the ValidationPipe with `disableErrorMessages`, so NestJS omits
  // `error` and answers `{ statusCode, message }`. Every case above sends the three-key development
  // shape, which is why the suite stayed green while this body rendered as "[object Object]".
  it('parses the envelope a production gateway actually sends, with no `error` key', async () => {
    const t = new MockTransport().on('POST', '/api/sessions', {
      status: 400,
      body: { message: 'Bad Request', statusCode: 400 },
    });
    const err = await client(t)
      .sessions.create({ name: 'x' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenWAApiError);
    expect((err as OpenWAApiError).message).toContain('Bad Request');
    expect((err as OpenWAApiError).message).not.toContain('[object Object]');
    expect((err as OpenWAApiError).status).toBe(400);
    // No `error` key was sent, so there is no kind to report — undefined, not a stringified object.
    expect((err as OpenWAApiError).errorKind).toBeUndefined();
  });

  it('still reads `error` as the kind when the gateway sends one', async () => {
    const t = new MockTransport().on('POST', '/api/sessions', {
      status: 400,
      body: { message: ['name must be a string'], error: 'Bad Request', statusCode: 400 },
    });
    const err = await client(t)
      .sessions.create({ name: 'x' })
      .catch((e: unknown) => e);

    expect((err as OpenWAApiError).errorKind).toBe('Bad Request');
    expect((err as OpenWAApiError).message).toContain('name must be a string');
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

  it('exposes the body code, the retry delay and the response headers on an API error', async () => {
    const fail = async (spec: MockResponseSpec): Promise<OpenWAApiError> =>
      (await client(new MockTransport().passthrough(spec))
        .sessions.list()
        .catch((e: unknown) => e)) as OpenWAApiError;

    const throttled = await fail({
      status: 429,
      headers: { 'Retry-After': '7' },
      body: { statusCode: 429, message: 'ThrottlerException: Too Many Requests' },
    });
    expect(throttled).toBeInstanceOf(OpenWARateLimitError);
    expect(throttled.retryAfterSeconds).toBe(7);
    expect(throttled.code).toBeUndefined();
    expect(throttled.headers?.get('retry-after')).toBe('7');

    // Send pacing puts its wait in the body; a header must not shorten it.
    const pacing = {
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Daily send cap reached',
      code: 'SEND_PACING_LIMITED',
      retryAfterSeconds: 34521,
    };
    for (const headers of [undefined, { 'Retry-After': '1' }]) {
      const err = await fail({ status: 429, headers, body: pacing });
      expect(err.code).toBe('SEND_PACING_LIMITED');
      expect(err.retryAfterSeconds).toBe(34521);
    }

    const dated = await fail({ status: 503, headers: { 'Retry-After': new Date(Date.now() + 2000).toUTCString() } });
    expect(dated.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(dated.retryAfterSeconds).toBeLessThanOrEqual(3);
    // Only whole seconds or an HTTP date count; Date.parse would read '-5' or '1.5' as a past date.
    for (const bad of ['soon', '-5', '1.5', 'Tue 5']) {
      expect((await fail({ status: 503, headers: { 'Retry-After': bad } })).retryAfterSeconds).toBeUndefined();
    }

    const logout = await fail({
      status: 502,
      body: { statusCode: 502, message: 'x', code: 'SESSION_LOGOUT_INCOMPLETE' },
    });
    expect(logout.code).toBe('SESSION_LOGOUT_INCOMPLETE');
    const plain = await fail({ status: 500, text: 'oops', contentType: 'text/plain' });
    expect(plain.code).toBeUndefined();
    expect(plain.retryAfterSeconds).toBeUndefined();
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

  it('keeps the timeout armed while reading a stalled response body', async () => {
    const stalledBodyFetch: FetchLike = async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            const error = new Error('body aborted');
            error.name = 'AbortError';
            controller.error(error);
          });
        },
      });
      return new Response(body, { status: 200 });
    };
    const c = new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', timeoutMs: 5, fetch: stalledBodyFetch });

    await expect(c.sessions.list()).rejects.toBeInstanceOf(OpenWATimeoutError);
  });

  it('turns the timeout off for 0 or Infinity, and caps a delay setTimeout cannot hold', async () => {
    // setTimeout fires after 1 ms for a delay that is not finite or exceeds 2^31-1, which would
    // abort every request instead of waiting longer.
    const slowFetch: FetchLike = async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (init?.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return new Response('[]', { status: 200 });
    };
    for (const timeoutMs of [0, Infinity, 2 ** 31]) {
      const c = new OpenWAClient({ baseUrl: 'http://localhost', apiKey: 'k', timeoutMs, fetch: slowFetch });
      await expect(c.sessions.list()).resolves.toEqual([]);
    }
  });

  it('arms the timeout for a numeric string from untyped config', async () => {
    // A plain-JS caller passing process.env.OPENWA_TIMEOUT_MS hands over a string.
    const slowFetch: FetchLike = async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (init?.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return new Response('[]', { status: 200 });
    };
    const timeoutMs = '5' as unknown as number;
    const c = new OpenWAClient({ baseUrl: 'http://localhost', apiKey: 'k', timeoutMs, fetch: slowFetch });
    await expect(c.sessions.list()).rejects.toThrow(new OpenWATimeoutError(5));
  });

  it('refuses a timeout that is not a number of milliseconds instead of turning it off', () => {
    // An environment variable that is set but empty, or carries a unit, would otherwise let a
    // stalled request hang forever.
    for (const timeoutMs of ['', ' ', '30s', 'abc', -1]) {
      expect(
        () => new OpenWAClient({ baseUrl: 'http://localhost', apiKey: 'k', timeoutMs: timeoutMs as unknown as number }),
      ).toThrow(TypeError);
    }
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

  it('keeps the auth and JSON headers winning over a caller header that differs only in case', async () => {
    // fetch folds header names case-insensitively and joins duplicates, so read what goes on the wire.
    let wire: Headers | undefined;
    const recordingFetch: FetchLike = async (_url, init) => {
      wire = new Headers(init?.headers);
      return new Response('[]', { status: 200 });
    };
    const c = new OpenWAClient({
      baseUrl: 'http://localhost',
      apiKey: 'REAL',
      defaultHeaders: { 'x-api-key': 'EVIL', 'x-trace': 'keep' },
      fetch: recordingFetch,
    });
    await c.request({ method: 'GET', path: '/api/sessions', headers: { 'content-type': 'text/plain' } });
    expect(wire!.get('x-api-key')).toBe('REAL');
    expect(wire!.get('content-type')).toBe('application/json');
    expect(wire!.get('x-trace')).toBe('keep');
  });

  it('calls the global fetch unbound from the client config when none is injected', async () => {
    // Browsers and Workers reject a fetch invoked as a method of another object ("Illegal invocation").
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    try {
      const c = new OpenWAClient({ baseUrl: 'http://localhost', apiKey: 'k' });
      await expect(c.sessions.list()).resolves.toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('calls an injected platform fetch without the client config as receiver', async () => {
    // `fetch: window.fetch` or `fetch: globalThis.fetch` hands over the unbound platform function.
    const receivers: unknown[] = [];
    const strictFetch = function (this: unknown) {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response('[]', { status: 200 }));
    } as unknown as FetchLike;
    const c = new OpenWAClient({ baseUrl: 'http://localhost', apiKey: 'k', fetch: strictFetch });
    await expect(c.sessions.list()).resolves.toEqual([]);
    expect(receivers).toEqual([undefined]);
  });
});
