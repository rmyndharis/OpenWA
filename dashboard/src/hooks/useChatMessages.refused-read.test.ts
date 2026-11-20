// A stored-message read that is refused for a reason that may pass leaves a thread of engine history alone: no media
// payloads, no delivery state and no older page. The cache must not hold that as the whole thread.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { useChatMessages as useChatMessagesFn } from './useChatMessages.ts';

type RTL = typeof import('@testing-library/react');
let rtl: RTL;
let useChatMessages: typeof useChatMessagesFn;
const clients: QueryClient[] = [];
const calls: string[] = [];
let storedStatus = 503;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const historyRow = (n: number) => ({
  id: 'true_c1@c.us_H' + n,
  chatId: 'c1@c.us',
  from: 'c1@c.us',
  to: 'me@c.us',
  body: 'history ' + n,
  type: 'text',
  timestamp: 1_700_000_000 + n,
  fromMe: false,
  isGroup: false,
  kind: 'individual',
});

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  sessionStorage.setItem('openwa_api_key', 'k');
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/history')) return Promise.resolve(json([historyRow(1), historyRow(2), historyRow(3)]));
    if (url.includes('/messages?')) {
      return Promise.resolve(json({ message: 'refused' }, storedStatus));
    }
    return Promise.resolve(json({ message: 'unstubbed ' + url }, 404));
  }) as typeof fetch;
  rtl = await import('@testing-library/react');
  ({ useChatMessages } = await import('./useChatMessages.ts'));
});

afterEach(async () => {
  rtl.cleanup();
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  calls.length = 0;
  storedStatus = 503;
});

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const first = rtl.renderHook(() => useChatMessages('s1', 'c1@c.us', true), { wrapper });
  await rtl.waitFor(() => assert.equal(first.result.current.isSuccess || first.result.current.isError, true));
  const settled = first.result.current;
  const requests = calls.length;
  first.unmount();
  const second = rtl.renderHook(() => useChatMessages('s1', 'c1@c.us', true), { wrapper });
  await rtl.waitFor(() => assert.equal(second.result.current.isSuccess || second.result.current.isError, true));
  return { settled, requests, requestsAfterReopen: calls.length };
}

for (const status of [503, 429, 500]) {
  test(`a stored read refused with ${status} fails the thread instead of caching the history alone`, async () => {
    storedStatus = status;
    const { settled, requests, requestsAfterReopen } = await open();
    assert.equal(settled.isError, true);
    assert.equal(settled.data, undefined);
    assert.ok(requestsAfterReopen > requests, 'the chat was not asked for again when it was reopened');
  });
}

test('a stored read that never got an answer fails the thread too', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    String(input).includes('/messages?') && !String(input).includes('/history')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : realFetch(input)) as typeof fetch;
  try {
    const { settled } = await open();
    assert.equal(settled.isError, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The control: a refusal that asking again does not change keeps the history in place of the stored rows, as it did.
test('a stored read refused with a 4xx still shows the history it could read', async () => {
  storedStatus = 404;
  const { settled } = await open();
  assert.equal(settled.isError, false);
  assert.equal(settled.data?.length, 3);
});
