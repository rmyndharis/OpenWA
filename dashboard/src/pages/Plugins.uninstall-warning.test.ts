// An uninstall that removed the plugin but could not drop its registry entry answers with the one call that removes
// the entry. The plugin's card is gone by then, so that warning is the only place the page says what is left to do,
// and it is about 260 characters long: it has to stay on screen until the operator has read it and closes it.
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

const KEPT =
  'Plugin greeter uninstalled, but the plugin registry could not be written: registry.json keeps its entry, ' +
  'emptied of config, sessions and the enable decision, reported at startup as a plugin with no code ' +
  'until DELETE /api/plugins/greeter is repeated once the registry is writable';

let catalogReads = 0;

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') return Promise.resolve(jsonResponse([PLUGIN]));
    if (method === 'GET' && path === '/api/plugins/catalog') {
      catalogReads++;
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'DELETE' && path === `/api/plugins/${PLUGIN.id}`) {
      return Promise.resolve(jsonResponse({ success: true, message: KEPT }));
    }
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let useToast: (typeof import('../hooks/useToast.ts'))['useToast'];
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
  ({ useToast } = await import('../hooks/useToast.ts'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  catalogReads = 0;
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

/** Renders the page beside a probe that can raise a toast of its own, and uninstalls the plugin. */
async function uninstallKeepingTheEntry(): Promise<{ warn: (title: string) => void }> {
  const { screen, fireEvent, waitFor } = rtl;
  const probe: { warn: (title: string) => void } = { warn: () => assert.fail('the probe did not render') };
  function Probe() {
    const toast = useToast();
    probe.warn = title => toast.warning(title);
    return null;
  }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins), createElement(Probe)),
    ),
  );
  await waitFor(() => assert.equal(catalogReads, 1));
  const realConfirm = window.confirm;
  window.confirm = () => true;
  try {
    fireEvent.click(await screen.findByTitle('Uninstall'));
    await screen.findByText(KEPT);
  } finally {
    window.confirm = realConfirm;
  }
  await waitFor(() => assert.equal(catalogReads, 2));
  await waitFor(() => assert.equal(queryClient?.isFetching(), 0));
  return probe;
}

test('the warning of an uninstall that kept its registry entry stays until it is closed', async () => {
  const { screen, waitFor } = rtl;
  const probe = await uninstallKeepingTheEntry();

  // A plain warning raised after it leaves on its own timer. Equal timers fire in the order they were set, so once it
  // is gone any timer the kept-entry warning had has already run.
  rtl.act(() => probe.warn('A later warning'));
  await screen.findByText('A later warning');
  await waitFor(() => assert.ok(screen.queryByText('A later warning') === null), { timeout: 10_000 });

  assert.ok(screen.queryByText(KEPT), 'the only pointer to DELETE /api/plugins/greeter left the page by itself');
});

test('the kept-entry warning leaves when it is closed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  await uninstallKeepingTheEntry();
  const toast = screen.getByText(KEPT).closest<HTMLElement>('.toast')!;
  assert.equal(toast.getAttribute('role'), 'alert');
  fireEvent.click(rtl.within(toast).getByRole('button', { name: 'Close' }));
  await waitFor(() => assert.ok(screen.queryByText(KEPT) === null));
});
