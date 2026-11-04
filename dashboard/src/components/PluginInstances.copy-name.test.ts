// A freshly minted instance secret, verify token and ingress URL are shown once. The button that copies each one
// must say what it does to a screen reader; an icon alone is announced as a nameless button.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE = '/api/integration/plugins/chatwoot/instances';
const MINTED = {
  id: 'i-2',
  pluginId: 'chatwoot',
  instanceId: 'acct2',
  sessionScope: null,
  secret: 'plain-signing-secret-0123',
  verifyToken: 'auto-verify-token-4567',
  config: null,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ingressUrls: [{ route: 'webhook', url: 'https://gw.example/api/integration/chatwoot/acct2/webhook' }],
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === BASE) return Promise.resolve(jsonResponse([]));
    if (method === 'POST' && path === BASE) return Promise.resolve(jsonResponse(MINTED, 201));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let PluginInstances: (typeof import('./PluginInstances.tsx'))['PluginInstances'];
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('./Toast.tsx'));
  ({ PluginInstances } = await import('./PluginInstances.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

test('every button in the minted-instance view has an accessible name', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(PluginInstances, { pluginId: 'chatwoot' })),
    ),
  );
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Create instance' }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('Instance ID'), { target: { value: 'acct2' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Create' }));
  const dialog = await rtl.screen.findByRole('dialog', { name: 'Instance created' });
  const unnamed = rtl
    .within(dialog)
    .queryAllByRole('button', { name: (name: string) => name.trim() === '' })
    .map(button => button.closest('.pi-secret')?.querySelector('code')?.textContent ?? button.className);
  assert.deepEqual(unnamed, [], `nameless copy buttons beside: ${unnamed.join(' | ')}`);
});
