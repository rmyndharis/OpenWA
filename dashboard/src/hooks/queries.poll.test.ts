// The overview polls the session list and stats while it stays open. A route that refuses the key stops the poll, so a
// key restricted to selected chats is not refused and audited every interval; any other failed read (a proxy 502 while
// the gateway restarts, a timeout) must not stop it, or the page stays stale with no error shown.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';
import type { useSessionsQuery as useSessionsQueryFn } from './queries.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useSessionsQuery: typeof useSessionsQueryFn;
// Loaded after the DOM globals exist: the query core decides at import time whether it runs on a server, where it
// never starts an interval.
let QueryClient: typeof QueryClientType;
let QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider;
const clients: QueryClientType[] = [];

// The status each read of the session list is answered with, in order; the last one repeats.
let answers: number[] = [];
let reads = 0;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() => {
    const status = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    const body = status === 200 ? [] : { message: status === 403 ? 'Forbidden' : 'Bad Gateway' };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  ({ QueryClient, QueryClientProvider } = await import('@tanstack/react-query'));
  rtl = await import('@testing-library/react');
  ({ useSessionsQuery } = await import('./queries.ts'));
});

afterEach(async () => {
  rtl.cleanup();
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  reads = 0;
});

function renderPoll() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return rtl.renderHook(() => useSessionsQuery(20), { wrapper });
}

const settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('the poll goes on after a read that failed for a reason other than a refusal', async () => {
  answers = [200, 502, 200];
  renderPoll();

  await rtl.waitFor(() => assert.ok(reads >= 3, `only ${reads} reads: the poll stopped after the failed one`));
});

test('the poll stops once the route refuses the key', async () => {
  answers = [403];
  renderPoll();

  await rtl.waitFor(() => assert.equal(reads, 1));
  await settle(150);
  assert.equal(reads, 1, 'a refused read was asked again');
});
