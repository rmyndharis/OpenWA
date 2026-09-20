import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let response: unknown[] = [];
let status = 200;

function installFetchStub(): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(status === 200 ? response : { message: 'Failed to load plugins' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: () => React.ReactElement;
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  response = [];
  status = 200;
});

function renderPlugins(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtl.render(
    createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, createElement(Plugins))),
  ).container;
}

test('renders one empty state without the empty plugin rail', async () => {
  const container = renderPlugins();
  await rtl.waitFor(() => assert.equal(container.querySelectorAll('.empty-state').length, 1));
  assert.equal(container.querySelectorAll('.plugins-layout').length, 0);
});

test('shows the load error instead of claiming no plugins are installed', async () => {
  status = 500;
  const container = renderPlugins();
  await rtl.waitFor(() => assert.equal(container.querySelectorAll('.error-banner').length, 1));
  assert.equal(container.querySelectorAll('.empty-state').length, 0);
});
