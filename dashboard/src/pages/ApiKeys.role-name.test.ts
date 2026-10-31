// The key list names each key's role in the dashboard's language, as the role selects on the same page do; a role
// this build has no name for still shows as the API sends it.
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

let keyList: Record<string, unknown>[] = [operatorKey];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse([]));
    if (init?.method === 'POST' && path === '/api/auth/api-keys') {
      return Promise.resolve(jsonResponse({ ...operatorKey, id: 'key-new', apiKey: 'owa_k1_new_plaintext' }, 201));
    }
    if (path === '/api/auth/api-keys') return Promise.resolve(jsonResponse(keyList));
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
  keyList = [operatorKey];
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

const roleBadge = async (): Promise<string | null> => {
  await rtl.screen.findByText('billing-bot');
  return document.querySelector('.permission-badge')?.textContent ?? null;
};

test('the key list names a role in the dashboard language', async () => {
  await i18n.changeLanguage('zh-CN');
  renderApiKeys();
  assert.equal(await roleBadge(), i18n.t('apiKeys.roles.operator'));
});

test('the key list names a role in English as the role select does', async () => {
  renderApiKeys();
  assert.equal(await roleBadge(), 'Operator');
});

test('a role this build does not know is shown as the API sends it', async () => {
  keyList = [{ ...operatorKey, role: 'billing' }];
  renderApiKeys();
  assert.equal(await roleBadge(), 'billing');
});
