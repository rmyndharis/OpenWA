// Render test for the plugin instance manager under the bare `node --test` runner, on the ApiKeys.test.ts
// harness: the edit modal's session scope and the view that shows a freshly minted instance.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE = '/api/integration/plugins/chatwoot/instances';

const BOUND = {
  id: 'i-1',
  pluginId: 'chatwoot',
  instanceId: 'acct1',
  sessionScope: 'sess-a',
  secret: '***',
  verifyToken: null,
  config: null,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ingressUrls: [],
};

// The create response is the one place the plaintext secret and an auto-generated verify token appear.
const MINTED = {
  ...BOUND,
  instanceId: 'acct2',
  sessionScope: null,
  secret: 'plain-signing-secret-0123',
  verifyToken: 'auto-verify-token-4567',
};

const calls: { method: string; path: string; body?: unknown }[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET' && path === BASE) return Promise.resolve(jsonResponse([BOUND]));
    if (method === 'PATCH' && path === `${BASE}/acct1`) return Promise.resolve(jsonResponse(BOUND));
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
  calls.length = 0;
});

function renderInstances(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(PluginInstances, { pluginId: 'chatwoot' })),
    ),
  );
}

test('clearing a bound session scope saves the instance for all sessions', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderInstances();

  fireEvent.click(await screen.findByTitle('Edit'));
  const scope = (await screen.findByLabelText('Session scope (optional)')) as HTMLInputElement;
  assert.equal(scope.value, 'sess-a');
  fireEvent.change(scope, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    const patch = calls.find(c => c.method === 'PATCH');
    assert.ok(patch, 'expected a PATCH');
    assert.equal((patch.body as { sessionScope?: unknown }).sessionScope, null);
  });
});

test('the created view shows an auto-generated verify token with a copy button', async () => {
  const { screen, fireEvent, within } = rtl;
  renderInstances();

  fireEvent.click(await screen.findByRole('button', { name: 'Create instance' }));
  fireEvent.change(screen.getByLabelText('Instance ID'), { target: { value: 'acct2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  const dialog = await screen.findByRole('dialog', { name: 'Instance created' });
  const token = within(dialog).getByText('auto-verify-token-4567');
  assert.ok(token.closest('.pi-secret')?.querySelector('button'), 'no copy button next to the verify token');
  within(dialog).getByText('Verify token');
  const create = calls.find(c => c.method === 'POST' && c.path === BASE);
  assert.ok(create, 'expected an instance create request');
  assert.equal((create.body as { secret?: string }).secret, undefined);
});

test('invalid instance secrets show the matching localized length guidance', async () => {
  const { default: i18n, supportedLanguages } = await import('../i18n/index.ts');
  const { screen, fireEvent } = rtl;
  const errors = [
    ['ASCII over maximum', 'x'.repeat(513), 'common.fieldTooLong', { max: 512, count: 513 }],
    ['padded astral over maximum', `  ${'\u{1F600}'.repeat(513)}  `, 'common.fieldTooLong', { max: 512, count: 513 }],
    ['presentation over maximum', '\u2764\uFE0F'.repeat(513), 'common.fieldTooLong', { max: 512, count: 513 }],
    ['ASCII below minimum', 'x'.repeat(15), 'plugins.instances.errors.invalidSecret', undefined],
    ['astral below minimum', '\u{1F600}'.repeat(8), 'plugins.instances.errors.invalidSecret', undefined],
  ] as const;

  try {
    for (const language of supportedLanguages) {
      await i18n.changeLanguage(language);
      renderInstances();
      fireEvent.click(await screen.findByRole('button', { name: i18n.t('plugins.instances.create') }));
      fireEvent.change(screen.getByLabelText(i18n.t('plugins.instances.form.instanceId')), {
        target: { value: 'acct2' },
      });
      const secret = screen.getByLabelText(i18n.t('plugins.instances.form.secret'));
      for (const [label, value, key, options] of errors) {
        fireEvent.change(secret, { target: { value } });
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common.create') }));
        const expected = i18n.t(key, options);
        assert.equal(screen.getByText(expected).textContent, expected, `${language}: ${label}`);
        if (key === 'common.fieldTooLong') {
          assert.match(expected, /512/, language);
          assert.match(expected, /513/, language);
          assert.doesNotMatch(expected, /\{\{|\}\}/, language);
        }
        assert.equal(
          calls.some(c => c.method === 'POST' && c.path === BASE),
          false,
          `${language}: ${label}`,
        );
      }
      rtl.cleanup();
      queryClient?.clear();
      calls.length = 0;
    }
  } finally {
    rtl.cleanup();
    queryClient?.clear();
    await i18n.changeLanguage('en');
  }
});
