// The plugin config dialog (Configuration / Sessions) and the install dialog (Upload / Catalog) switch their content
// with a row of buttons. A screen reader must hear that these are tabs and which one is showing, as it does for the
// pairing tabs on the Sessions page and the mode tabs on the Number Checker.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const PLUGIN = {
  id: 'greeter',
  name: 'Greeter',
  version: '1.0.0',
  type: 'extension',
  status: 'enabled',
  config: { greeting: 'hello' },
  builtIn: false,
  provides: [],
  ingressCapable: false,
  configSchema: { type: 'object', properties: { greeting: { type: 'string', title: 'Greeting' } } },
  sessionScoped: true,
  activeSessions: ['*'],
  sessionConfig: {},
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') return Promise.resolve(jsonResponse([PLUGIN]));
    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderPlugins(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );
}

test('the config dialog exposes Configuration and Sessions as tabs with the shown one selected', async () => {
  renderPlugins();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Configure'));
  await rtl.screen.findByRole('dialog');
  const tabs = rtl.screen.queryAllByRole('tab');
  assert.deepEqual(
    tabs.map(tab => [tab.textContent, tab.getAttribute('aria-selected')]),
    [
      ['Configuration', 'true'],
      ['Sessions', 'false'],
    ],
  );
});

test('the install dialog exposes Upload and Catalog as tabs with the shown one selected', async () => {
  renderPlugins();
  await rtl.screen.findByTitle('Configure');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Install plugin/i }));
  await rtl.screen.findByRole('dialog');
  const tabs = rtl.screen.queryAllByRole('tab');
  assert.equal(tabs.length, 2, 'the install dialog exposes no tabs');
  assert.deepEqual(
    tabs.map(tab => tab.getAttribute('aria-selected')),
    ['true', 'false'],
  );
});
