// Render smoke test for the OpenWaQueues placeholder under the bare `node --test` runner.
// Mirrors Infrastructure.test.ts harness: QueryClientProvider → RoleProvider → ToastProvider,
// companion_operator role via localStorage. No Bull Board JSON fetch — counter UI removed.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
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

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
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

test('renders Filas migrating placeholder for companion_operator', async () => {
  const { screen } = rtl;
  renderOpenWaQueues();

  await screen.findByRole('heading', { name: /OpenWA Queues|Filas OpenWA/i });
  screen.getByRole('status');
  screen.getByRole('heading', { name: /Bull Board|Embed/i });
});
