// Render test for the Templates page under the bare `node --test` runner, on the Sessions.test.ts
// harness. The template list route is OPERATOR-only, so a viewer key always gets 403 there; a failed
// read must say so instead of rendering the "no templates saved" empty state.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let templatesStatus = 200;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') {
      return Promise.resolve(
        jsonResponse([
          {
            id: 'sess-1',
            name: 'billing-bot',
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      );
    }
    if (path === '/api/sessions/sess-1/templates') {
      if (templatesStatus === 403) {
        return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: operator' }, 403));
      }
      if (templatesStatus !== 200)
        return Promise.resolve(jsonResponse({ message: 'database offline' }, templatesStatus));
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Templates: (typeof import('./Templates.tsx'))['Templates'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.localStorage.setItem('openwa_user_role', 'viewer');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Templates } = await import('./Templates.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderTemplates(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Templates))),
    ),
  );
}

test('a 403 on the template list shows a permission state, not an empty library', async () => {
  templatesStatus = 403;
  renderTemplates();
  await rtl.screen.findByText('No access to templates');
  assert.equal(rtl.screen.queryByText('No templates saved') === null, true);
});

test('any other failed read shows the error, not an empty library', async () => {
  templatesStatus = 500;
  renderTemplates();
  await rtl.screen.findByText('Could not load templates');
  rtl.screen.getByText('database offline');
  assert.equal(rtl.screen.queryByText('No templates saved') === null, true);
});

test('a successful empty read still shows the empty state', async () => {
  templatesStatus = 200;
  renderTemplates();
  await rtl.screen.findByText('No templates saved');
});
