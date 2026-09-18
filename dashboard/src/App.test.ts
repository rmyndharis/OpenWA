// Role gating of the Logs page under the bare `node --test` runner, rendered through the real App so
// both halves are covered: the sidebar entry (Layout) and the route itself (App). GET /audit is
// ADMIN-only, so an operator or viewer reaching /logs only ever saw a load error over an empty table.
import './test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let role = 'operator';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/auth/validate') return Promise.resolve(jsonResponse({ valid: true, role }));
    if (path === '/api/audit' || path.startsWith('/api/audit?'))
      return Promise.resolve(jsonResponse({ data: [], total: 0 }));
    if (path === '/api/sessions' || path === '/api/webhooks') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let App: (typeof import('./App.tsx'))['default'];

before(async () => {
  const { installJsdomGlobals } = await import('./test-helpers/jsdom.ts');
  await installJsdomGlobals('http://localhost/logs');
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  // jsdom has no matchMedia; the theme hook reads it for the system preference.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  installFetchStub();
  // App owns a module-level QueryClient this file cannot clear, and its five-minute gcTime timers would
  // hold the test process open after the last case. Unref them so they never keep the runner alive.
  const { timeoutManager } = await import('@tanstack/react-query');
  const unref = (id: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => id.unref();
  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
    clearTimeout: id => clearTimeout(id),
    setInterval: (callback, delay) => unref(setInterval(callback, delay)),
    clearInterval: id => clearInterval(id),
  });
  const { i18nReady } = await import('./i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: App } = await import('./App.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

function renderAt(path: string, as: string): void {
  role = as;
  window.history.replaceState(null, '', path);
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  window.localStorage.setItem('openwa_user_role', as);
  rtl.render(createElement(App));
}

const logsLink = (): Element | null => document.querySelector('a[href="/logs"]');

test('an operator gets no Logs entry and /logs sends them home', async () => {
  renderAt('/logs', 'operator');
  // The sidebar renders once the lazy route resolves; wait for a nav entry every role has.
  await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/sessions"]')));
  assert.equal(logsLink() === null, true, 'the Logs nav entry is shown to an operator');
  await rtl.waitFor(() => assert.equal(window.location.pathname, '/'));
});

test('an admin keeps the Logs entry and the route', async () => {
  renderAt('/logs', 'admin');
  await rtl.waitFor(() => assert.ok(logsLink(), 'the Logs nav entry is missing for an admin'));
  // Give the router a chance to redirect before asserting that it did not.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(window.location.pathname, '/logs');
});
