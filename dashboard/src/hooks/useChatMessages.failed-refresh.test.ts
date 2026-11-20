// A refresh of a loaded thread that fails (the reconnect invalidates it and its stored read is refused) leaves the newest
// page stale. The retry the strip offers must be that refresh: an older page that landed instead would end the error and
// the invalidation, and the messages of the gap would stay missing.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { loadMoreOfThread as loadMoreFn, useChatMessages as useChatMessagesFn } from './useChatMessages.ts';

type RTL = typeof import('@testing-library/react');
let rtl: RTL;
let useChatMessages: typeof useChatMessagesFn;
let loadMoreOfThread: typeof loadMoreFn;
const clients: QueryClient[] = [];
const stored: Array<{ offset: number; status: number }> = [];
let storedStatus = 200;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const row = (n: number) => ({
  id: 'm' + n,
  sessionId: 's1',
  chatId: 'c1@c.us',
  direction: 'incoming',
  type: 'text',
  body: 'stored ' + n,
  createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
});

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  sessionStorage.setItem('openwa_api_key', 'k');
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.includes('/history')) return Promise.resolve(json([]));
    if (url.pathname.endsWith('/messages')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      stored.push({ offset, status: storedStatus });
      if (storedStatus !== 200) return Promise.resolve(json({ message: 'refused' }, storedStatus));
      // A full first page, so that an older one exists.
      const rows = Array.from({ length: 100 }, (_, i) => row(offset + i));
      return Promise.resolve(json({ messages: rows, total: 250 }));
    }
    return Promise.resolve(json({ message: 'unstubbed ' + url.pathname }, 404));
  }) as typeof fetch;
  rtl = await import('@testing-library/react');
  ({ useChatMessages, loadMoreOfThread } = await import('./useChatMessages.ts'));
});

afterEach(async () => {
  rtl.cleanup();
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  stored.length = 0;
  storedStatus = 200;
});

test('the retry of a failed refresh is the refresh, and the newest page is read again', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const { result } = rtl.renderHook(() => useChatMessages('s1', 'c1@c.us', false), { wrapper });
  await rtl.waitFor(() => assert.equal(result.current.isSuccess, true));
  assert.equal(result.current.hasNextPage, true);

  // The reconnect invalidates the thread and the stored read is refused: the loaded thread stays, with the failure.
  storedStatus = 503;
  await rtl.act(() => client.invalidateQueries({ queryKey: ['messages', 's1', 'c1@c.us'] }));
  await rtl.waitFor(() => assert.equal(result.current.isRefetchError, true));
  assert.equal(result.current.isFetchNextPageError, false);
  assert.ok(result.current.data && result.current.data.length > 0, 'the loaded thread is kept');

  // The strip asks again, and the gateway answers: the newest page is what is read, not an older one.
  storedStatus = 200;
  stored.length = 0;
  await rtl.act(() => loadMoreOfThread(result.current));
  await rtl.waitFor(() => assert.equal(result.current.isError, false));
  assert.deepEqual(
    stored.map(read => read.offset),
    [0],
  );
});

test('the retry of a failed older page is still an older page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const { result } = rtl.renderHook(() => useChatMessages('s1', 'c1@c.us', false), { wrapper });
  await rtl.waitFor(() => assert.equal(result.current.isSuccess, true));

  storedStatus = 503;
  await rtl.act(() => result.current.fetchNextPage());
  await rtl.waitFor(() => assert.equal(result.current.isFetchNextPageError, true));

  storedStatus = 200;
  stored.length = 0;
  await rtl.act(() => loadMoreOfThread(result.current));
  await rtl.waitFor(() => assert.equal(result.current.isError, false));
  assert.deepEqual(
    stored.map(read => read.offset),
    [100],
  );
});
