// The install dialog (Upload, Catalog) and the plugin configuration dialog (Configuration, Sessions) are rows of
// role="tab" buttons: one stop in the Tab order each, and an arrow key selects another tab and takes focus there.
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
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') return Promise.resolve(jsonResponse([PLUGIN]));
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
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

const names = (tabs: HTMLElement[]) => tabs.map(tab => tab.textContent?.trim());
const stops = () => names(rtl.screen.getAllByRole('tab').filter(tab => tab.getAttribute('tabindex') !== '-1'));
const selectedTab = () => rtl.screen.getByRole('tab', { selected: true }).textContent?.trim();

async function openInstallDialog() {
  renderPlugins();
  await rtl.screen.findByTitle('Configure');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Install plugin/i }));
  await rtl.screen.findByRole('dialog');
}

test('in the install dialog an arrow key selects the other tab and takes focus there', async () => {
  await openInstallDialog();
  assert.deepEqual(names(rtl.screen.getAllByRole('tab')), ['Upload .zip', 'Catalog']);
  assert.deepEqual(stops(), ['Upload .zip']);
  const [upload, catalog] = rtl.screen.getAllByRole('tab');
  upload.focus();
  rtl.fireEvent.keyDown(upload, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Catalog'));
  assert.equal(selectedTab(), 'Catalog');
  assert.deepEqual(stops(), ['Catalog']);
  // The catalog read the tab starts has to land before the test ends.
  await rtl.screen.findByText('No plugins in the catalog.');

  rtl.fireEvent.keyDown(catalog, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Upload .zip'));
  assert.equal(selectedTab(), 'Upload .zip');
});

test('in the configuration dialog an arrow key selects the other tab and wraps at the ends', async () => {
  renderPlugins();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Configure'));
  await rtl.screen.findByRole('dialog');
  assert.deepEqual(names(rtl.screen.getAllByRole('tab')), ['Configuration', 'Sessions']);
  assert.deepEqual(stops(), ['Configuration']);
  const [config, sessions] = rtl.screen.getAllByRole('tab');
  config.focus();
  rtl.fireEvent.keyDown(config, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Sessions'));
  assert.equal(selectedTab(), 'Sessions');
  assert.deepEqual(stops(), ['Sessions']);

  rtl.fireEvent.keyDown(sessions, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Configuration'));
  assert.equal(selectedTab(), 'Configuration');
  rtl.fireEvent.keyDown(config, { key: 'End' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Sessions'));
});
