// Render test for the Dashboard stat cards under the bare `node --test` runner, on the Sessions.test.ts
// harness. GET /webhooks and GET /stats/overview both reject a viewer key; each card must then show
// the unavailable placeholder rather than a count the gateway never returned.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let webhooksStatus = 403;
let webhookList: unknown[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse([]));
    if (path === '/api/webhooks') {
      return webhooksStatus === 200
        ? Promise.resolve(jsonResponse(webhookList))
        : Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: operator' }, webhooksStatus));
    }
    // Everything else, the admin-only overview included, is refused.
    return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: admin' }, 403));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Dashboard: (typeof import('./Dashboard.tsx'))['Dashboard'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // recharts' ResponsiveContainer observes its box; jsdom ships no ResizeObserver.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Dashboard } = await import('./Dashboard.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  webhookList = [];
});

function renderDashboard(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, null, createElement(Dashboard)),
    ),
  );
}

function statValue(label: string): string {
  const card = rtl.screen.getByText(label).closest('.stat-card');
  return card?.querySelector('.stat-value')?.textContent ?? '';
}

test('a refused webhook read shows the unavailable placeholder, not zero webhooks', async () => {
  webhooksStatus = 403;
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  // The overview card is refused too, so its placeholder is the one the webhook card must match.
  await rtl.waitFor(() => assert.equal(statValue('Webhooks Configured'), statValue('Messages Today')));
  assert.notEqual(statValue('Webhooks Configured'), '0');
});

test('a failed background refetch keeps counting the cached webhooks', async () => {
  webhooksStatus = 200;
  webhookList = [{ id: 'w1', url: 'https://example.test/hook', events: [] }];
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  await rtl.waitFor(() => assert.equal(statValue('Webhooks Configured'), '1'));

  webhooksStatus = 502;
  await rtl.act(() => queryClient!.refetchQueries({ queryKey: ['webhooks'] }));
  await rtl.waitFor(() => assert.equal(queryClient!.getQueryState(['webhooks'])?.status, 'error'));
  assert.equal(statValue('Webhooks Configured'), '1');
});

test('a successful empty webhook read still counts zero', async () => {
  webhooksStatus = 200;
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  await rtl.waitFor(() => assert.equal(statValue('Webhooks Configured'), '0'));
});
