// A new API key is shown exactly once, in the post-creation dialog. The button that copies it must say what it does
// to a screen reader; an icon alone is announced as a nameless button.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const operatorKey = {
  id: 'key-1',
  name: 'billing-bot',
  keyPrefix: 'owa_k1ab',
  role: 'operator',
  isActive: true,
  usageCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse([]));
    if (init?.method === 'POST' && path === '/api/auth/api-keys') {
      return Promise.resolve(jsonResponse({ ...operatorKey, id: 'key-new', apiKey: 'owa_k1_new_plaintext' }, 201));
    }
    if (path === '/api/auth/api-keys') return Promise.resolve(jsonResponse([operatorKey]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let i18n: (typeof import('../i18n/index.ts'))['default'];
let ApiKeys: (typeof import('./ApiKeys.tsx'))['ApiKeys'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const mod = await import('../i18n/index.ts');
  await mod.i18nReady;
  i18n = mod.default;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ ApiKeys } = await import('./ApiKeys.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  await i18n.changeLanguage('en');
});

function renderApiKeys(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(ApiKeys)),
    ),
  );
}

test('the button that copies a newly created key has an accessible name', async () => {
  renderApiKeys();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Create API Key/i }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name'), { target: { value: 'reporting' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Create' }));
  const shown = await rtl.screen.findByText('owa_k1_new_plaintext');
  const dialog = shown.closest('[role="dialog"]') as HTMLElement;
  const unnamed = rtl.within(dialog).queryAllByRole('button', { name: (name: string) => name.trim() === '' });
  assert.equal(unnamed.length, 0, `nameless buttons in the created-key dialog: ${unnamed.length}`);
  assert.ok(rtl.within(dialog).getByRole('button', { name: 'Copy key' }));
});
