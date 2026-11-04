// A test delivery the receiver refused with an error status comes back with the status and no error text. The toast
// reports it in the dashboard's language, not with an English word spliced into a translated sentence; error text
// from the gateway still wins when there is some.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const webhook = {
  id: 'w1',
  sessionId: 'sess-1',
  url: 'https://receiver.example/hook',
  events: ['message.received'],
  filters: null,
  active: true,
  retryCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// The receiver answered 500: the gateway reports the status and no error text.
let testReply: Record<string, unknown> = { success: false, statusCode: 500 };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions')
      return Promise.resolve(jsonResponse([{ id: 'sess-1', name: 'main', status: 'ready' }]));
    if (path === '/api/webhooks') return Promise.resolve(jsonResponse([webhook]));
    if (path === '/api/sessions/sess-1/chats') return Promise.resolve(jsonResponse([]));
    if (init?.method === 'POST' && path === '/api/sessions/sess-1/webhooks/w1/test') {
      return Promise.resolve(jsonResponse(testReply));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let i18n: (typeof import('../i18n/index.ts'))['default'];
let Webhooks: (typeof import('./Webhooks.tsx'))['Webhooks'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  const mod = await import('../i18n/index.ts');
  await mod.i18nReady;
  i18n = mod.default;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Webhooks } = await import('./Webhooks.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  testReply = { success: false, statusCode: 500 };
  await i18n.changeLanguage('en');
});

function renderWebhooks(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Webhooks))),
    ),
  );
}

test('a test delivery the receiver refused is reported without English text in another language', async () => {
  await i18n.changeLanguage('es');
  renderWebhooks();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Probar'));
  const toast = await rtl.screen.findByText(/Prueba de webhook fallida/);
  assert.ok(!/\bStatus\b/.test(toast.textContent ?? ''), `the Spanish toast reads: ${toast.textContent}`);
  assert.match(toast.textContent ?? '', /HTTP 500/);
});

test('in English the refused test names the receiver status', async () => {
  renderWebhooks();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Test'));
  assert.ok(await rtl.screen.findByText('Webhook test failed: the receiver answered HTTP 500'));
});

test('error text from the gateway still wins over the status', async () => {
  testReply = { success: false, error: 'Connection refused' };
  renderWebhooks();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Test'));
  assert.ok(await rtl.screen.findByText('Webhook test failed: Connection refused'));
});
