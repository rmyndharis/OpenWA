// The API client's handling of a response that proves the stored key unusable. A 401, or a 403 because
// the key's allowedIps refuse this client, must sign the dashboard out; a role 403 must not, or every
// page an operator cannot open would log them out.
import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let sessionApi: (typeof import('./api.ts'))['sessionApi'];
let pluginsApi: (typeof import('./api.ts'))['pluginsApi'];
const navigations: string[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // jsdom's location.assign cannot be spied on (it is unforgeable) and does not navigate anyway.
  Object.defineProperty(globalThis, 'window', {
    value: { location: { assign: (url: string) => navigations.push(url) } },
    configurable: true,
    writable: true,
  });
  ({ sessionApi, pluginsApi } = await import('./api.ts'));
});

beforeEach(() => {
  navigations.length = 0;
  sessionStorage.clear();
  sessionStorage.setItem('openwa_api_key_id', 'key-actor-1');
});

function answer(status: number, message: string): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ statusCode: status, message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
}

const settled = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 20)),
  ]);

for (const [status, message] of [
  [401, 'Invalid API key'],
  [403, 'IP address not allowed'],
  [403, 'Client IP could not be determined'],
] as const) {
  test(`a ${status} "${message}" clears the session actor, broadcasts logout to sibling tabs, and returns to login`, async () => {
    localStorage.clear();
    answer(status, message);
    const call = sessionApi.list();
    assert.equal(await settled(call), false, 'the call settled, so its caller would render the failure');
    assert.equal(sessionStorage.getItem('openwa_api_key_id'), null);
    assert.deepEqual(navigations, ['/']);
    const syncRaw = localStorage.getItem('openwa_auth_sync');
    assert.ok(syncRaw, 'expected cross-tab logout broadcast');
    const syncEvent = JSON.parse(syncRaw) as { type?: string };
    assert.equal(syncEvent.type, 'logout');
  });
}

test('a role 403 keeps the session actor and rejects with the status', async () => {
  answer(403, 'Insufficient permissions. Required: operator');
  await assert.rejects(sessionApi.list(), (err: Error & { status?: number }) => {
    assert.equal(err.status, 403);
    assert.equal(err.message, 'Insufficient permissions. Required: operator');
    return true;
  });
  assert.equal(sessionStorage.getItem('openwa_api_key_id'), 'key-actor-1');
  assert.deepEqual(navigations, []);
});

test('all request shapes send cookie credentials and X-Requested-With without an X-API-Key header', async () => {
  sessionStorage.setItem('openwa_api_key', 'should-never-be-sent');
  const seen: Array<{ credentials?: RequestCredentials; csrf: string | null; apiKeyHeader: string | null }> = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      credentials: init?.credentials,
      csrf: headers.get('X-Requested-With'),
      apiKeyHeader: headers.get('X-API-Key'),
    });
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  }) as typeof fetch;

  await sessionApi.list();
  await pluginsApi.getConfigUi('p1');
  await sessionApi.getMessageMediaBlob('s1', '100@c.us', 'WA1');

  assert.deepEqual(seen, [
    { credentials: 'include', csrf: 'OpenWA-Dashboard', apiKeyHeader: null },
    { credentials: 'include', csrf: 'OpenWA-Dashboard', apiKeyHeader: null },
    { credentials: 'include', csrf: 'OpenWA-Dashboard', apiKeyHeader: null },
  ]);
});

// Each response shape the client reads, so the session check covers every path into the failure handler.
const shapes = [
  ['JSON', () => sessionApi.list()],
  ['text', () => pluginsApi.getConfigUi('p1')],
  ['blob', () => sessionApi.getMessageMediaBlob('s1', '100@c.us', 'WA1')],
] as const;

// Hold every response until the test releases them, recording request headers and credentials.
function deferAnswers(
  status: number,
  message: string,
): {
  sent: Array<{ credentials?: RequestCredentials; csrf: string | null; apiKeyHeader: string | null }>;
  release: () => void;
} {
  const sent: Array<{ credentials?: RequestCredentials; csrf: string | null; apiKeyHeader: string | null }> = [];
  const releases: (() => void)[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      credentials: init?.credentials,
      csrf: headers.get('X-Requested-With'),
      apiKeyHeader: headers.get('X-API-Key'),
    });
    return new Promise<Response>(resolve => {
      releases.push(() =>
        resolve(
          new Response(JSON.stringify({ statusCode: status, message }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    });
  }) as typeof fetch;
  return { sent, release: () => releases.forEach(release => release()) };
}

// Both answers that prove a session unusable: a 401, and a 403 because allowedIps refuse this client.
const keyFailures = [
  [401, 'API key is revoked'],
  [403, 'IP address not allowed'],
] as const;

// A stale answer wrongly left pending drains the event loop, and node:test then cancels every later test;
// holding a timer open past the per-test timeout lets that timeout fail just the one test instead.
const stale = { timeout: 2000 };
async function rejectsWithStatus(result: Promise<unknown>, status: number): Promise<void> {
  const hold = setTimeout(() => {}, 3000);
  try {
    await assert.rejects(result, (err: Error & { status?: number }) => err.status === status);
  } finally {
    clearTimeout(hold);
  }
}

for (const [status, message] of keyFailures) {
  for (const [shape, call] of shapes) {
    test(
      `a late ${status} ${shape} answer for a session signed out since keeps the session signed in now`,
      stale,
      async () => {
        const pending = deferAnswers(status, message);
        const result = call();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(pending.sent, [{ credentials: 'include', csrf: 'OpenWA-Dashboard', apiKeyHeader: null }]);
        sessionStorage.removeItem('openwa_api_key_id');
        sessionStorage.setItem('openwa_api_key_id', 'key-actor-2');
        pending.release();
        await rejectsWithStatus(result, status);
        assert.equal(sessionStorage.getItem('openwa_api_key_id'), 'key-actor-2');
        assert.deepEqual(navigations, []);
      },
    );

    test(`a ${status} ${shape} answer for the session still in use clears it and returns to login`, async () => {
      const pending = deferAnswers(status, message);
      const result = call();
      await new Promise(resolve => setImmediate(resolve));
      pending.release();
      assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
      assert.equal(sessionStorage.getItem('openwa_api_key_id'), null);
      assert.deepEqual(navigations, ['/']);
    });

    test(`a late ${status} ${shape} answer while signed out stays silent and stays on the login form`, async () => {
      const pending = deferAnswers(status, message);
      const result = call();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(pending.sent, [{ credentials: 'include', csrf: 'OpenWA-Dashboard', apiKeyHeader: null }]);
      sessionStorage.removeItem('openwa_api_key_id');
      pending.release();
      assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
      assert.equal(sessionStorage.getItem('openwa_api_key_id'), null);
      assert.deepEqual(navigations, []);
    });
  }

  test(`a burst of ${status}s for the session still in use keeps every call pending and navigates once`, async () => {
    const pending = deferAnswers(status, message);
    const results = shapes.map(([, call]) => call());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.sent.length, 3);
    pending.release();
    for (const result of results) {
      assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
    }
    assert.equal(sessionStorage.getItem('openwa_api_key_id'), null);
    assert.deepEqual(navigations, ['/']);
  });
}

test('a 401 for a request sent without a session while none is stored stays silent on the login form', async () => {
  sessionStorage.removeItem('openwa_api_key_id');
  answer(401, 'API key is required');
  const result = sessionApi.list();
  assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
  assert.equal(sessionStorage.getItem('openwa_api_key_id'), null);
  assert.deepEqual(navigations, []);
});

test('a late 401 for a request sent while signed out keeps the session signed in since', stale, async () => {
  sessionStorage.removeItem('openwa_api_key_id');
  const pending = deferAnswers(401, 'API key is required');
  const result = sessionApi.list();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pending.sent, [{ credentials: 'include', csrf: 'OpenWA-Dashboard', apiKeyHeader: null }]);
  sessionStorage.setItem('openwa_api_key_id', 'key-actor-2');
  pending.release();
  await rejectsWithStatus(result, 401);
  assert.equal(sessionStorage.getItem('openwa_api_key_id'), 'key-actor-2');
  assert.deepEqual(navigations, []);
});

test('archived media forwards cancellation through fetch and the response body', async () => {
  const controller = new AbortController();
  let requested: string | undefined;
  let options: RequestInit | undefined;
  let reading = false;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input);
    options = init;
    return Promise.resolve({
      ok: true,
      blob: () => {
        reading = true;
        return new Promise<Blob>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        });
      },
    } as Response);
  }) as typeof fetch;
  const bytes = sessionApi.getMessageMediaBlob('s1', '100@c.us', 'WA1', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reading);
  assert.ok(requested?.endsWith('/sessions/s1/messages/100%40c.us/WA1/media'));
  assert.equal(options?.credentials, 'include');
  assert.equal((options?.headers as Record<string, string>)['X-Requested-With'], 'OpenWA-Dashboard');
  assert.equal((options?.headers as Record<string, string>)['X-API-Key'], undefined);
  assert.equal(options?.signal, controller.signal);
  controller.abort();
  await assert.rejects(bytes, { name: 'AbortError' });
});

test('a refused media download carries the Retry-After seconds it was sent, and none without the header', async () => {
  const refuse = (headers: Record<string, string>) => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ statusCode: 503, message: 'Too many media downloads are in progress' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...headers },
        }),
      )) as typeof fetch;
  };
  refuse({ 'Retry-After': '3' });
  await assert.rejects(
    sessionApi.getMessageMediaBlob('s1', '100@c.us', 'WA1'),
    (err: Error & { status?: number; retryAfterSeconds?: number }) => {
      assert.equal(err.status, 503);
      assert.equal(err.retryAfterSeconds, 3);
      return true;
    },
  );
  refuse({});
  await assert.rejects(
    sessionApi.getMessageMediaBlob('s1', '100@c.us', 'WA1'),
    (err: Error & { retryAfterSeconds?: number }) => {
      assert.equal('retryAfterSeconds' in err, false);
      return true;
    },
  );
});

test('the contact list walks past the 1000 contacts one response carries', async () => {
  const { contactApi } = await import('./api.ts');
  const requested: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url.replace(/^.*\/api/, ''));
    const count = url.includes('offset=0') ? 1000 : 5;
    const contacts = Array.from({ length: count }, (_, i) => ({ id: `${i}@c.us`, name: null, number: `${i}` }));
    return Promise.resolve(
      new Response(JSON.stringify(contacts), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;

  const contacts = await contactApi.list('s1');
  assert.equal(contacts.length, 1005);
  assert.deepEqual(requested, [
    '/sessions/s1/contacts?limit=1000&offset=0',
    '/sessions/s1/contacts?limit=1000&offset=1000',
  ]);
});

test('the contact list is not cut off at 10,000 contacts', async () => {
  const { contactApi } = await import('./api.ts');
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input), 'http://x').searchParams.get('offset'));
    const count = offset < 11_000 ? 1000 : 5;
    const contacts = Array.from({ length: count }, (_, i) => ({ id: `${offset + i}@c.us`, name: null }));
    return Promise.resolve(
      new Response(JSON.stringify(contacts), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;

  assert.equal((await contactApi.list('s1')).length, 11_005);
});

test('the contact list rejects instead of returning a partial list when a later page stays throttled', async () => {
  const { contactApi } = await import('./api.ts');
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (!String(input).includes('offset=0')) {
      return Promise.resolve(
        new Response(JSON.stringify({ statusCode: 429, message: 'Too Many Requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    const contacts = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}@c.us`, name: null }));
    return Promise.resolve(
      new Response(JSON.stringify(contacts), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;

  await assert.rejects(
    contactApi.list('s1'),
    (err: Error & { status?: number }) => err.status === 429 && err.message === 'Too Many Requests',
  );
});

function chatResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

for (const size of [1001, 2000, 11001]) {
  test(`the chat list loads all ${size} conversations in bounded pages`, async () => {
    const offsets: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const offset = Number(url.searchParams.get('offset'));
      assert.equal(url.searchParams.get('limit'), '1000');
      offsets.push(offset);
      return chatResponse(
        Array.from({ length: Math.min(1000, size - offset) }, (_, i) => ({ id: `chat-${offset + i}` })),
      );
    }) as typeof fetch;
    const chats = await sessionApi.getChats('s1');
    assert.equal(chats.length, size);
    assert.equal(chats.at(-1)?.id, `chat-${size - 1}`);
    assert.deepEqual(
      offsets,
      Array.from({ length: Math.floor(size / 1000) + 1 }, (_, i) => i * 1000),
    );
  });
}

test('chat pagination preserves first-seen order and deduplicates moving rows', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
    return chatResponse(
      offset === 0
        ? Array.from({ length: 1000 }, (_, i) => ({ id: `chat-${i}` }))
        : [{ id: 'chat-999' }, { id: 'tail' }],
    );
  }) as typeof fetch;
  const chats = await sessionApi.getChats('s1');
  assert.equal(chats.length, 1001);
  assert.equal(chats[999].id, 'chat-999');
  assert.equal(chats[1000].id, 'tail');
});

for (const status of [500, 429]) {
  test(`chat pagination rejects a later ${status} without returning a partial list`, async () => {
    let attempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
      if (offset === 0) return chatResponse(Array.from({ length: 1000 }, (_, i) => ({ id: `chat-${i}` })));
      attempts++;
      return chatResponse({ message: 'Later page failed' }, status);
    }) as typeof fetch;
    await assert.rejects(sessionApi.getChats('s1'), (err: Error & { status?: number }) => err.status === status);
    assert.equal(attempts, status === 429 ? 3 : 1);
  });
}

test('the chat list request carries the caller signal, so an abort cuts a request that never answers', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | null | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen = init?.signal;
    // A half-open connection: the request answers only when its signal aborts it.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }) as typeof fetch;

  const result = sessionApi.getChats('s1', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  // Asserted before waiting on the result, which would never settle without the signal.
  assert.ok(seen, 'the request carried no signal');
  controller.abort();
  assert.equal(seen.aborted, true, 'the signal of the request did not follow the caller');
  await assert.rejects(result, { name: 'AbortError' });
});

for (const change of ['replace key', 'sign out', 'abort'] as const) {
  test(`chat pagination stops before the next page after ${change}`, async () => {
    let release!: (response: Response) => void;
    let requests = 0;
    const pending = new Promise<Response>(resolve => {
      release = resolve;
    });
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      requests++;
      return pending;
    }) as typeof fetch;
    const result = sessionApi.getChats('s1', controller.signal);
    if (change === 'replace key') sessionStorage.setItem('openwa_api_key_id', 'key-actor-2');
    if (change === 'sign out') sessionStorage.removeItem('openwa_api_key_id');
    if (change === 'abort') controller.abort();
    release(chatResponse(Array.from({ length: 1000 }, (_, i) => ({ id: `chat-${i}` }))));
    await assert.rejects(result, change === 'abort' ? { name: 'AbortError' } : /Signed out/);
    assert.equal(requests, 1);
  });
}

test('dynamic path segments and stats period are URL-encoded across every API group', async () => {
  const { webhookApi, templateApi, contactApi, apiKeyApi, messageApi, pluginInstancesApi, statsApi } =
    await import('./api.ts');
  const requested: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requested.push(
      String(input)
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/^\/api/, ''),
    );
    return Promise.resolve(
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;

  const tricky = '../admin/x?a=1#frag';
  const encTricky = encodeURIComponent(tricky);
  const tricky2 = 'sub/id?b=2#h';
  const encTricky2 = encodeURIComponent(tricky2);

  await sessionApi.get(tricky);
  await sessionApi.start(tricky);
  await sessionApi.getConfig(tricky);
  await sessionApi.getGroups(tricky);
  await sessionApi.getSubscribedChannels(tricky);
  await sessionApi.getContactStatuses(tricky);
  await webhookApi.listBySession(tricky);
  await webhookApi.update(tricky, tricky2, { active: false });
  await webhookApi.delete(tricky, tricky2);
  await webhookApi.test(tricky, tricky2);
  await templateApi.list(tricky);
  await templateApi.update(tricky, tricky2, { body: 'hi' });
  await templateApi.delete(tricky, tricky2);
  await contactApi.listBlocked(tricky);
  await contactApi.block(tricky, tricky2);
  await apiKeyApi.update(tricky, { name: 'k' });
  await apiKeyApi.delete(tricky);
  await apiKeyApi.revoke(tricky);
  await messageApi.sendText(tricky, '1555@c.us', 'hi');
  await messageApi.react(tricky, { chatId: '1555@c.us', messageId: 'm1', emoji: '👍' });
  await pluginsApi.get(tricky);
  await pluginsApi.enable(tricky);
  await pluginsApi.updateSessionConfig(tricky, tricky2, {});
  await pluginsApi.getConfigUi(tricky);
  await pluginInstancesApi.list(tricky);
  await pluginInstancesApi.regenerateSecret(tricky, tricky2);
  await pluginInstancesApi.update(tricky, tricky2, { enabled: false });
  await pluginInstancesApi.remove(tricky, tricky2);
  await statsApi.getMessages('7d&x=1' as '7d');

  assert.deepEqual(requested, [
    `/sessions/${encTricky}`,
    `/sessions/${encTricky}/start`,
    `/sessions/${encTricky}/config`,
    `/sessions/${encTricky}/groups`,
    `/sessions/${encTricky}/channels`,
    `/sessions/${encTricky}/status`,
    `/sessions/${encTricky}/webhooks`,
    `/sessions/${encTricky}/webhooks/${encTricky2}`,
    `/sessions/${encTricky}/webhooks/${encTricky2}`,
    `/sessions/${encTricky}/webhooks/${encTricky2}/test`,
    `/sessions/${encTricky}/templates`,
    `/sessions/${encTricky}/templates/${encTricky2}`,
    `/sessions/${encTricky}/templates/${encTricky2}`,
    `/sessions/${encTricky}/contacts/blocked`,
    `/sessions/${encTricky}/contacts/${encTricky2}/block`,
    `/auth/api-keys/${encTricky}`,
    `/auth/api-keys/${encTricky}`,
    `/auth/api-keys/${encTricky}/revoke`,
    `/sessions/${encTricky}/messages/send-text`,
    `/sessions/${encTricky}/messages/react`,
    `/plugins/${encTricky}`,
    `/plugins/${encTricky}/enable`,
    `/plugins/${encTricky}/config/${encTricky2}`,
    `/plugins/${encTricky}/config-ui`,
    `/integration/plugins/${encTricky}/instances`,
    `/integration/plugins/${encTricky}/instances/${encTricky2}/regenerate-secret`,
    `/integration/plugins/${encTricky}/instances/${encTricky2}`,
    `/integration/plugins/${encTricky}/instances/${encTricky2}`,
    `/stats/messages?period=${encodeURIComponent('7d&x=1')}`,
  ]);
});

test('chat and contact list pagination stop at the 50,000 item ceiling on non-terminating servers', async () => {
  const { contactApi } = await import('./api.ts');
  let chatPages = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
    chatPages++;
    if (chatPages > 52) throw new Error('pagination exceeded ceiling');
    return chatResponse(Array.from({ length: 1000 }, (_, i) => ({ id: `chat-${offset + i}` })));
  }) as typeof fetch;

  const chats = await sessionApi.getChats('s1');
  assert.equal(chats.length, 50_000);
  assert.equal(chatPages, 50);

  let contactPages = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
    contactPages++;
    if (contactPages > 52) throw new Error('pagination exceeded ceiling');
    return chatResponse(
      Array.from({ length: 1000 }, (_, i) => ({ id: `${offset + i}@c.us`, number: `${offset + i}` })),
    );
  }) as typeof fetch;

  const contacts = await contactApi.list('s1');
  assert.equal(contacts.length, 50_000);
  assert.equal(contactPages, 50);
});

test('authApi.deleteSession uses keepalive and authApi.createSession waits for in-flight logout to settle', async () => {
  const { authApi } = await import('./api.ts');
  const order: string[] = [];
  let finishDelete!: () => void;
  let deleteKeepalive: boolean | undefined;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    if (method === 'DELETE' && url.endsWith('/auth/session')) {
      deleteKeepalive = init?.keepalive;
      order.push('delete:start');
      return new Promise<Response>(resolve => {
        finishDelete = () => {
          order.push('delete:end');
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        };
      });
    }
    if (method === 'POST' && url.endsWith('/auth/session')) {
      order.push('create:start');
      return Promise.resolve(
        new Response(JSON.stringify({ valid: true, role: 'admin', apiKeyId: 'k-new' }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;

  const delPromise = authApi.deleteSession();
  const createPromise = authApi.createSession('owa_new_key');

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deleteKeepalive, true, 'expected keepalive: true on DELETE /auth/session');
  assert.deepEqual(order, ['delete:start'], 'createSession must wait until pending deleteSession finishes');

  finishDelete();
  await Promise.all([delPromise, createPromise]);
  assert.deepEqual(order, ['delete:start', 'delete:end', 'create:start']);
});
