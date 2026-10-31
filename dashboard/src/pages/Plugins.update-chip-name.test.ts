// A plugin card with a newer catalog version shows a chip reading that version ("v2.0.0"). Its accessible
// name has to contain that visible text, so a voice user who says what they see can press it and a screen
// reader user hears which version is waiting.
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
  config: {},
  builtIn: false,
  provides: [],
  ingressCapable: false,
  sessionScoped: false,
  activeSessions: ['*'],
  sessionConfig: {},
};

const CATALOG_ENTRY = {
  id: 'greeter',
  name: 'Greeter',
  version: '2.0.0',
  description: 'Says hello',
  installed: true,
  installedVersion: '1.0.0',
  updateAvailable: true,
  download: 'https://example.invalid/greeter-2.0.0.zip',
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') return Promise.resolve(jsonResponse([PLUGIN]));
    if (method === 'GET' && path === '/api/plugins/catalog') return Promise.resolve(jsonResponse([CATALOG_ENTRY]));
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

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

test("the update chip's accessible name contains the version it shows", async () => {
  const { screen, within } = rtl;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );
  const card = (await screen.findByRole('heading', { name: 'Greeter' })).closest<HTMLElement>('.plugin-card')!;
  const chip = await rtl.waitFor(() => {
    const found = card.querySelector<HTMLElement>('.plugin-update-chip');
    assert.ok(found, 'the update chip renders once the catalog read answers');
    return found;
  });
  assert.equal(chip.textContent, 'v2.0.0');
  assert.ok(
    within(card).queryByRole('button', { name: 'v2.0.0, Update available' }),
    `the chip shows "v2.0.0" but is named "${chip.getAttribute('aria-label')}"`,
  );
});
