// Render smoke test for the OpenWaQueues page under the bare `node --test` runner. Mirrors
// Infrastructure.test.ts / Sessions.test.ts: QueryClientProvider → RoleProvider → ToastProvider,
// stub fetch for /admin/openwa-remote-queues, companion_operator role via localStorage.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OpenWaRemoteQueuesStatus } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

const REMOTE_QUEUES: OpenWaRemoteQueuesStatus = {
  configured: true,
  source: 'bull-board',
  queues: [{ name: 'webhook-queue', counts: { pending: 1, completed: 2, failed: 0 } }],
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    if (method === 'GET' && path === '/api/admin/openwa-remote-queues') {
      return Promise.resolve(jsonResponse(REMOTE_QUEUES));
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── Harness bootstrap ────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type OpenWaQueuesModule = typeof import('./OpenWaQueues.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let OpenWaQueues: OpenWaQueuesModule['OpenWaQueues'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  window.localStorage.setItem('openwa_user_role', 'companion_operator');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ OpenWaQueues } = await import('./OpenWaQueues.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderOpenWaQueues() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(OpenWaQueues))),
    ),
  );
}

// ── Smoke tests ──────────────────────────────────────────────────────────────

test('renders remote queue names for companion_operator', async () => {
  const { screen } = rtl;
  renderOpenWaQueues();

  await screen.findByText('webhook-queue');
  screen.getByText('1');
  screen.getByText('Pending');
});
