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
  sessionStorage.setItem('openwa_api_key', 'stored-key');
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
  test(`a ${status} "${message}" clears the key and returns to login`, async () => {
    answer(status, message);
    const call = sessionApi.list();
    assert.equal(await settled(call), false, 'the call settled, so its caller would render the failure');
    assert.equal(sessionStorage.getItem('openwa_api_key'), null);
    assert.deepEqual(navigations, ['/']);
  });
}

test('a role 403 keeps the key and rejects with the status', async () => {
  answer(403, 'Insufficient permissions. Required: operator');
  await assert.rejects(sessionApi.list(), (err: Error & { status?: number }) => {
    assert.equal(err.status, 403);
    assert.equal(err.message, 'Insufficient permissions. Required: operator');
    return true;
  });
  assert.equal(sessionStorage.getItem('openwa_api_key'), 'stored-key');
  assert.deepEqual(navigations, []);
});

// Each response shape the client reads, so the key check covers every path into the failure handler.
const shapes = [
  ['JSON', () => sessionApi.list()],
  ['text', () => pluginsApi.getConfigUi('p1')],
  ['blob', () => sessionApi.getMessageMediaBlob('s1', '100@c.us', 'WA1')],
] as const;

// Hold every response until the test releases them, recording the key each request was sent with.
function deferAnswers(status: number, message: string): { sentKeys: (string | undefined)[]; release: () => void } {
  const sentKeys: (string | undefined)[] = [];
  const releases: (() => void)[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    sentKeys.push((init?.headers as Record<string, string> | undefined)?.['X-API-Key']);
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
  return { sentKeys, release: () => releases.forEach(release => release()) };
}

// Both answers that prove a key unusable: a 401, and a 403 because the key's allowedIps refuse this client.
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
    test(`a late ${status} ${shape} answer for a key signed out since keeps the key signed in now`, stale, async () => {
      const pending = deferAnswers(status, message);
      const result = call();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(pending.sentKeys, ['stored-key']);
      sessionStorage.removeItem('openwa_api_key');
      sessionStorage.setItem('openwa_api_key', 'next-key');
      pending.release();
      await rejectsWithStatus(result, status);
      assert.equal(sessionStorage.getItem('openwa_api_key'), 'next-key');
      assert.deepEqual(navigations, []);
    });

    test(`a ${status} ${shape} answer for the key still in use clears it and returns to login`, async () => {
      const pending = deferAnswers(status, message);
      const result = call();
      await new Promise(resolve => setImmediate(resolve));
      pending.release();
      assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
      assert.equal(sessionStorage.getItem('openwa_api_key'), null);
      assert.deepEqual(navigations, ['/']);
    });

    test(`a late ${status} ${shape} answer while signed out stays silent and stays on the login form`, async () => {
      const pending = deferAnswers(status, message);
      const result = call();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(pending.sentKeys, ['stored-key']);
      sessionStorage.removeItem('openwa_api_key');
      pending.release();
      assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
      assert.equal(sessionStorage.getItem('openwa_api_key'), null);
      assert.deepEqual(navigations, []);
    });
  }

  test(`a burst of ${status}s for the key still in use keeps every call pending and navigates once`, async () => {
    const pending = deferAnswers(status, message);
    const results = shapes.map(([, call]) => call());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(pending.sentKeys, ['stored-key', 'stored-key', 'stored-key']);
    pending.release();
    for (const result of results) {
      assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
    }
    assert.equal(sessionStorage.getItem('openwa_api_key'), null);
    assert.deepEqual(navigations, ['/']);
  });
}

test('a 401 for a request sent without a key while none is stored stays silent on the login form', async () => {
  sessionStorage.removeItem('openwa_api_key');
  answer(401, 'API key is required');
  const result = sessionApi.list();
  assert.equal(await settled(result), false, 'the call settled, so its caller would render the failure');
  assert.equal(sessionStorage.getItem('openwa_api_key'), null);
  assert.deepEqual(navigations, []);
});

test('a late 401 for a request sent while signed out keeps the key signed in since', stale, async () => {
  sessionStorage.removeItem('openwa_api_key');
  const pending = deferAnswers(401, 'API key is required');
  const result = sessionApi.list();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pending.sentKeys, [undefined]);
  sessionStorage.setItem('openwa_api_key', 'next-key');
  pending.release();
  await rejectsWithStatus(result, 401);
  assert.equal(sessionStorage.getItem('openwa_api_key'), 'next-key');
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
  assert.equal((options?.headers as Record<string, string>)['X-API-Key'], 'stored-key');
  assert.equal(options?.signal, controller.signal);
  controller.abort();
  await assert.rejects(bytes, { name: 'AbortError' });
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
