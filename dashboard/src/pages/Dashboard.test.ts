// Render test for the Dashboard stat cards under the bare `node --test` runner, on the Sessions.test.ts
// harness. GET /webhooks and GET /stats/overview both reject a viewer key; each card must then show
// the unavailable placeholder rather than a count the gateway never returned. POST /sessions/:id/stop
// is OPERATOR-only: a viewer is offered no Disconnect, and a failed stop is reported, not swallowed.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let webhooksStatus = 403;
let webhookList: unknown[] = [];
let sessionList: unknown[] = [];
let stopStatus = 200;
let sessionsStatus = 200;
const requested: string[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const READY_SESSION = {
  id: 'sess-ready-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    requested.push(path);
    if (path === '/api/sessions') {
      return Promise.resolve(
        sessionsStatus === 200 ? jsonResponse(sessionList) : jsonResponse({ message: 'Bad Gateway' }, sessionsStatus),
      );
    }
    if (path === `/api/sessions/${READY_SESSION.id}/stop`) {
      return Promise.resolve(
        stopStatus === 200
          ? jsonResponse({ ...READY_SESSION, status: 'disconnected' })
          : jsonResponse({ message: 'Engine not loaded' }, stopStatus),
      );
    }
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
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
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
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Dashboard } = await import('./Dashboard.tsx'));
  // Loaded up front so the lazy chart section resolves at once wherever it is rendered.
  await import('../components/DashboardCharts.tsx');
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  webhookList = [];
  sessionList = [];
  stopStatus = 200;
  sessionsStatus = 200;
  requested.length = 0;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
});

function renderDashboard(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        null,
        createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Dashboard))),
      ),
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

test('a read-only key is offered no Disconnect', async () => {
  webhooksStatus = 403;
  sessionList = [READY_SESSION];
  renderDashboard();
  await rtl.screen.findByText('Main');
  assert.ok(rtl.screen.getByRole('button', { name: 'View' }), 'the row rendered without its actions');
  assert.ok(!rtl.screen.queryByRole('button', { name: 'Disconnect' }), 'a viewer key was offered Disconnect');
});

test('a failed stop is reported, not swallowed', async () => {
  webhooksStatus = 200;
  sessionList = [READY_SESSION];
  stopStatus = 400;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderDashboard();
  const disconnect = await rtl.screen.findByRole('button', { name: 'Disconnect' });
  // The session changed on the server even though the stop answered an error: the list is re-read.
  sessionList = [{ ...READY_SESSION, status: 'disconnected' }];
  rtl.fireEvent.click(disconnect);
  const alert = await rtl.screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Could not disconnect the session/);
  assert.match(alert.textContent ?? '', /Engine not loaded/);
  await rtl.waitFor(() =>
    assert.ok(!rtl.screen.queryByRole('button', { name: 'Disconnect' }), 'the session list was not re-read'),
  );
});

test('a failed background refetch of the sessions keeps the cached page', async () => {
  webhooksStatus = 200;
  sessionList = [READY_SESSION];
  renderDashboard();
  await rtl.screen.findByText('Main');

  sessionsStatus = 502;
  await rtl.act(() => queryClient!.refetchQueries({ queryKey: ['sessions'] }));
  await rtl.waitFor(() => assert.equal(queryClient!.getQueryState(['sessions'])?.status, 'error'));
  assert.ok(rtl.screen.queryByText('Main'), 'a failed refetch replaced the cached sessions with an error');
});

test('a failed first read of the sessions still shows the error', async () => {
  webhooksStatus = 200;
  sessionsStatus = 502;
  renderDashboard();
  await rtl.screen.findByText(/Bad Gateway/);
});

test('a non-admin key never loads the chart section', async () => {
  for (const role of ['viewer', 'operator']) {
    window.sessionStorage.setItem('openwa_user_role', role);
    renderDashboard();
    await rtl.waitFor(() => assert.ok(requested.includes('/api/stats/overview')));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(
      !requested.some(p => p.startsWith('/api/stats/messages')),
      `${role}: the charts asked for /stats/messages`,
    );
    rtl.cleanup();
    requested.length = 0;
  }
});

test('an admin key loads the chart section', async () => {
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  renderDashboard();
  await rtl.waitFor(() => assert.ok(requested.some(p => p.startsWith('/api/stats/messages'))));
});
