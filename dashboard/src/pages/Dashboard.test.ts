// Render test for the Dashboard stat cards under the bare `node --test` runner, on the Sessions.test.ts
// harness. GET /webhooks is OPERATOR-only and GET /stats/overview ADMIN-only: a key without the role
// is not sent them, and a refused or unsent read shows the unavailable placeholder rather than a count
// the gateway never returned. POST /sessions/:id/stop
// is OPERATOR-only: a viewer is offered no Disconnect, and a failed stop is reported, not swallowed.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let webhooksStatus = 403;
let webhookList: unknown[] = [];
let sessionList: unknown[] = [];
let stopStatus = 200;
let sessionsStatus = 200;
let holdWebhooks = false;
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
      if (holdWebhooks) return new Promise<Response>(() => {});
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
  holdWebhooks = false;
  requested.length = 0;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  window.sessionStorage.removeItem('openwa_key_scoped');
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
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  // The overview card is not read for an operator, so its placeholder is the one the webhook card must match.
  await rtl.waitFor(() => assert.equal(statValue('Webhooks Configured'), statValue('Messages Today')));
  assert.notEqual(statValue('Webhooks Configured'), '0');
});

test('a failed background refetch keeps counting the cached webhooks', async () => {
  webhooksStatus = 200;
  webhookList = [{ id: 'w1', url: 'https://example.test/hook', events: [] }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
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
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  await rtl.waitFor(() => assert.equal(queryClient!.getQueryState(['webhooks'])?.status, 'success'));
  assert.equal(statValue('Webhooks Configured'), '0');
});

test('a webhook read still in flight shows the placeholder, not zero webhooks', async () => {
  holdWebhooks = true;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  await rtl.waitFor(() => assert.ok(requested.includes('/api/webhooks')));
  assert.equal(statValue('Webhooks Configured'), statValue('Messages Today'));
  assert.notEqual(statValue('Webhooks Configured'), '0');
});

// A date-only formatter put a session active a few hours ago on a bare date.
test('a session last active a few hours ago reads in hours, not as a date', async () => {
  webhooksStatus = 403;
  sessionList = [{ ...READY_SESSION, lastActive: new Date(Date.now() - 5 * 3_600_000).toISOString() }];
  renderDashboard();
  await rtl.screen.findByText('Main');
  assert.equal(document.querySelector('.last-active')?.textContent, '5 hours ago');
});

// The harness refuses the session statistics, as the gateway does a failed or unsent read: the count of sessions is
// then the list's own, not a total of zero beside the rows on screen.
test('a session list without statistics is counted by its own length', async () => {
  sessionList = [READY_SESSION];
  renderDashboard();
  await rtl.screen.findByText('Main');
  assert.equal(document.querySelector('.section-subtitle')?.textContent, 'Showing 1 of 1 sessions');
});

test('a connected session is counted without statistics, in the card and the header badge', async () => {
  sessionList = [READY_SESSION, { ...READY_SESSION, id: 'sess-2', name: 'Spare', status: 'disconnected' }];
  renderDashboard();
  await rtl.screen.findByText('Main');
  assert.equal(statValue('Connected Sessions'), '1');
  assert.equal(document.querySelector('.status-badge')?.textContent, 'Connected');
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

// Stop needs a live engine, which the gateway reports as engineLoaded: a status cannot tell a session
// reconnecting with its engine from a stopped one.
test('Disconnect is offered exactly where the gateway holds an engine', async () => {
  webhooksStatus = 200;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  sessionList = [{ ...READY_SESSION, status: 'disconnected', engineLoaded: true }];
  renderDashboard();
  await rtl.screen.findByRole('button', { name: 'Disconnect' });

  rtl.cleanup();
  queryClient?.clear();
  sessionList = [{ ...READY_SESSION, status: 'initializing', engineLoaded: false }];
  renderDashboard();
  await rtl.screen.findByText('Main');
  assert.ok(!rtl.screen.queryByRole('button', { name: 'Disconnect' }), 'a session with no engine offered Disconnect');
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
  const alert = await rtl.screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Bad Gateway/);
});

test('a non-admin key never loads the chart section', async () => {
  for (const role of ['viewer', 'operator']) {
    window.sessionStorage.setItem('openwa_user_role', role);
    renderDashboard();
    await rtl.waitFor(() => assert.ok(requested.includes('/api/sessions')));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(!requested.includes('/api/stats/overview'), `${role}: the admin-only overview was requested`);
    if (role === 'viewer')
      assert.ok(!requested.includes('/api/webhooks'), 'viewer: the operator-only webhook list was requested');
    assert.ok(
      !requested.some(p => p.startsWith('/api/stats/messages')),
      `${role}: the charts asked for /stats/messages`,
    );
    rtl.cleanup();
    requested.length = 0;
  }
});

test('a viewer is not sent the webhook read and its card shows the placeholder', async () => {
  webhooksStatus = 200;
  renderDashboard();
  await rtl.screen.findByText('Webhooks Configured');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!requested.includes('/api/webhooks'));
  assert.equal(statValue('Webhooks Configured'), statValue('Messages Today'));
  assert.notEqual(statValue('Webhooks Configured'), '0');
});

test('an admin key loads the chart section', async () => {
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  renderDashboard();
  await rtl.waitFor(() => assert.ok(requested.some(p => p.startsWith('/api/stats/messages'))));
});

test('a session-scoped admin key never loads the cross-session statistics', async () => {
  // GET /stats/overview and /stats/messages refuse a key restricted to selected sessions, whatever its role.
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_key_scoped', 'true');
  renderDashboard();
  await rtl.waitFor(() => assert.ok(requested.includes('/api/sessions')));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!requested.includes('/api/stats/overview'), 'the overview was requested');
  assert.ok(!requested.some(p => p.startsWith('/api/stats/messages')), 'the charts asked for /stats/messages');
});

// The session table renders `status-pill ${session.status}`, so every status needs its own colour.
test('the status pill styles every session status and nothing else', () => {
  const entity = readFileSync(
    new URL('../../../src/modules/session/entities/session.entity.ts', import.meta.url),
    'utf8',
  );
  const block = /export enum SessionStatus \{([^}]*)\}/.exec(entity)?.[1] ?? '';
  const statuses = [...block.matchAll(/= '([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.ok(statuses.length > 0, 'SessionStatus was not found');
  const css = readFileSync(new URL('./Dashboard.css', import.meta.url), 'utf8');
  const styled = [...new Set([...css.matchAll(/\.dashboard \.status-pill\.([a-z_]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(styled, statuses);
});
