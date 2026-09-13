// Render smoke test for OpenWaQueues Bull Board embed under the bare `node --test` runner.
// Mirrors Infrastructure.test.ts harness: QueryClientProvider → RoleProvider → ToastProvider,
// companion_operator role via localStorage. Mint stubs via fetch before iframe appears.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

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
let originalFetch: typeof fetch;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  originalFetch = globalThis.fetch;
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
  globalThis.fetch = originalFetch;
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

test('mints board session then renders iframe to /api/admin/queues', async () => {
  let minted = false;
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if ((init?.method ?? 'GET') === 'POST' && path.includes('/admin/queues-board-session')) {
      minted = true;
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  };
  renderOpenWaQueues();
  const iframe = await rtl.screen.findByTitle(/Bull Board|Filas|Queues/i);
  assert.equal(minted, true);
  assert.match(iframe.getAttribute('src') ?? '', /\/api\/admin\/queues\/?$/);
});
