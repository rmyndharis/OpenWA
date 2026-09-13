import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

let installJsdomGlobals: typeof installJsdomGlobalsFn;
const calls: FetchCall[] = [];
let originalFetch: typeof fetch;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
  sessionStorage.clear();
});

function installFetchMock(status = 204): void {
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: headerRecord,
    });
    return new Response(null, { status });
  };
}

test('queuesBoardSessionApi.mint POSTs /api/admin/queues-board-session', async () => {
  installFetchMock();
  const { queuesBoardSessionApi } = await import('./api.ts');
  await queuesBoardSessionApi.mint();
  assert.equal(calls[0]!.method, 'POST');
  assert.match(calls[0]!.url, /\/api\/admin\/queues-board-session$/);
});

test('queuesBoardSessionApi.clear DELETEs /api/admin/queues-board-session', async () => {
  installFetchMock();
  const { queuesBoardSessionApi } = await import('./api.ts');
  await queuesBoardSessionApi.clear();
  assert.equal(calls[0]!.method, 'DELETE');
  assert.match(calls[0]!.url, /\/api\/admin\/queues-board-session$/);
});

test('queuesBoardSessionApi sends session X-API-Key header', async () => {
  installFetchMock();
  sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  const { queuesBoardSessionApi } = await import('./api.ts');
  await queuesBoardSessionApi.mint();
  assert.equal(calls[0]!.headers['x-api-key'], 'test-admin-key');
});

test('queuesBoardSessionApi.mint resolves on 204 without parsing JSON', async () => {
  let jsonCalled = false;
  globalThis.fetch = async () => {
    const res = new Response(null, { status: 204 });
    res.json = async () => {
      jsonCalled = true;
      return {};
    };
    return res;
  };
  const { queuesBoardSessionApi } = await import('./api.ts');
  const result = await queuesBoardSessionApi.mint();
  assert.equal(result, undefined);
  assert.equal(jsonCalled, false);
});
