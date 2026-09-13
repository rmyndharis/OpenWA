import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

type AuthLifecycleModule = typeof import('./authLifecycle.ts');
let clearActorState: AuthLifecycleModule['clearActorState'];
let clearLocalSession: AuthLifecycleModule['clearLocalSession'];
let isUserRole: AuthLifecycleModule['isUserRole'];
let resolveStartupValidation: AuthLifecycleModule['resolveStartupValidation'];

before(async () => {
  ({ clearActorState, clearLocalSession, isUserRole, resolveStartupValidation } = await import('./authLifecycle.ts'));
});

test('logout cleanup wipes the React Query cache (no cross-actor residue)', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['sessions'], [{ id: 's1' }]);
  queryClient.setQueryData(['apiKeys'], [{ id: 'k1' }]);
  queryClient.setQueryData(['logs', { page: 1 }], [{ id: 'a1' }]);

  clearActorState(queryClient);

  assert.equal(queryClient.getQueryData(['sessions']), undefined);
  assert.equal(queryClient.getQueryData(['apiKeys']), undefined);
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
});

test('logout cleanup calls clear() on every provided cache', () => {
  const calls: string[] = [];
  const cache = (name: string) => ({ clear: () => calls.push(name) });
  clearActorState(cache('a'), cache('b'));
  assert.deepEqual(calls, ['a', 'b']);
});

test('logout cleanup DELETEs the Bull Board session cookie (best-effort)', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; path: string }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push({ method: init?.method ?? 'GET', path });
      return new Response(null, { status: 204 });
    };
    clearActorState({ clear: () => {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(
      calls.some(c => c.method === 'DELETE' && c.path === '/api/admin/queues-board-session'),
      `expected DELETE /api/admin/queues-board-session, got ${JSON.stringify(calls)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('logout cleanup still clears caches when Bull Board DELETE fails', async () => {
  const originalFetch = globalThis.fetch;
  const cacheClears: string[] = [];
  try {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    clearActorState({ clear: () => cacheClears.push('cleared') });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(cacheClears, ['cleared']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clearLocalSession DELETEs board session with X-API-Key before dropping the stored key', async () => {
  const originalFetch = globalThis.fetch;
  const deleteHeaders: HeadersInit[] = [];
  try {
    sessionStorage.setItem('openwa_api_key', 'logout-key');
    globalThis.fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        deleteHeaders.push(init?.headers ?? {});
      }
      return new Response(null, { status: 204 });
    };
    clearLocalSession({ clear: () => {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(deleteHeaders.length, 1, 'expected one board DELETE');
    const headers = new Headers(deleteHeaders[0]);
    assert.equal(headers.get('X-API-Key'), 'logout-key');
    assert.equal(sessionStorage.getItem('openwa_api_key'), null);
  } finally {
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
  }
});

test('clearLocalSession still drops the API key when Bull Board DELETE fails', async () => {
  const originalFetch = globalThis.fetch;
  try {
    sessionStorage.setItem('openwa_api_key', 'logout-key');
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    clearLocalSession({ clear: () => {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sessionStorage.getItem('openwa_api_key'), null);
  } finally {
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
  }
});

test('startup validation: 401/403 (revoked/demoted/restricted key) → logout', () => {
  assert.deepEqual(resolveStartupValidation(401, null), { action: 'logout' });
  assert.deepEqual(resolveStartupValidation(401, { valid: true, role: 'admin' }), { action: 'logout' });
  assert.deepEqual(resolveStartupValidation(403, null), { action: 'logout' });
});

test('startup validation: 429/5xx keeps the cached role (transient failure, not a revoked key)', () => {
  for (const status of [429, 500, 502, 503]) {
    assert.deepEqual(resolveStartupValidation(status, null), { action: 'keep' }, `status ${status}`);
    // Even a stray valid-looking body cannot upgrade a non-ok answer to a role refresh.
    assert.deepEqual(resolveStartupValidation(status, { valid: true, role: 'admin' }), { action: 'keep' });
  }
});

test('startup validation: ok + role refreshes the cached role from the server', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'viewer' }), {
    action: 'role',
    role: 'viewer',
  });
});

test('startup validation: ok without a usable role keeps the cached role', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: false }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'superuser' }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, null), { action: 'keep' });
});

test('isUserRole accepts exactly the four known roles', () => {
  assert.deepEqual(
    ['admin', 'operator', 'companion_operator', 'viewer'].filter(isUserRole),
    ['admin', 'operator', 'companion_operator', 'viewer'],
  );
  for (const value of ['superuser', '', undefined, null, 42, 'ADMIN']) {
    assert.equal(isUserRole(value), false, `expected ${String(value)} to be rejected`);
  }
});

test('startup validation: ok + companion_operator refreshes the cached role from the server', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'companion_operator' }), {
    action: 'role',
    role: 'companion_operator',
  });
});

// ── App-level auth flow: exactly one /auth/validate per sign-in ──────────────
// Render smoke tests of the full App for the two entry paths (fresh sign-in, page reload with a
// saved key). Harness mirrors Infrastructure.test.ts: jsdom globals, a fetch stub recording every
// call, i18n catalogues awaited before render. App brings its own providers, so no wrapper here.

const LOGIN_KEY = 'openwa_api_key';
const ROLE_KEY = 'openwa_user_role';

interface FetchCall {
  method: string;
  path: string;
  apiKey: string | null;
}

const fetchCalls: FetchCall[] = [];

// Per-test body for POST /auth/validate. The home page's stats endpoints need their object shapes
// ([] would crash Dashboard's overview render); every other request gets an empty list, which the
// post-login pages' React Query hooks tolerate.
let validateBody: { valid?: boolean; role?: string } = { valid: true, role: 'operator' };

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers = new Headers(init?.headers);
    fetchCalls.push({ method, path, apiKey: headers.get('X-API-Key') });

    let body: unknown = [];
    if (method === 'POST' && path === '/api/auth/validate') body = validateBody;
    else if (path === '/api/stats/overview')
      body = {
        sessions: { active: 0, total: 0, byStatus: {} },
        messages: { sent: 0, received: 0, failed: 0, today: { sent: 0, received: 0 } },
      };
    else if (path.startsWith('/api/stats/messages')) body = { timeSeries: [], byType: {}, bySession: [], topChats: [] };
    else if (method === 'DELETE' && path === '/api/admin/queues-board-session') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };
}

function validateCallCount(): number {
  return fetchCalls.filter(c => c.method === 'POST' && c.path === '/api/auth/validate').length;
}

type RTL = typeof import('@testing-library/react');
type AppModule = typeof import('../App.tsx');

let rtl: RTL;
let App: AppModule['default'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // jsdom gaps the authenticated shell hits: useTheme (Layout) reads window.matchMedia, and the
  // lazily-mounted analytics charts construct a ResizeObserver.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  // Login.tsx reads these Vite compile-time defines at render time; Node has no define step.
  Object.defineProperty(globalThis, '__APP_VERSION__', { value: '0.0.0-test', configurable: true });
  Object.defineProperty(globalThis, '__BUILD_TIME__', { value: new Date(0).toISOString(), configurable: true });
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: App } = await import('../App.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  localStorage.clear();
  sessionStorage.clear();
  fetchCalls.length = 0;
  validateBody = { valid: true, role: 'operator' };
});

// Types a key into the login form and submits it, then waits until App has applied the role from
// the validate response (the synchronous tail of handleLogin).
async function signIn(apiKey: string): Promise<void> {
  const { screen, waitFor, fireEvent } = rtl;
  const input = await screen.findByLabelText('API Key');
  fireEvent.change(input, { target: { value: apiKey } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.ok(localStorage.getItem(ROLE_KEY), 'expected a role to be stored after sign-in'));
  // Give the post-login render and its effects a macrotask to fire before counting requests.
  await new Promise(resolve => setTimeout(resolve, 50));
}

test('a fresh sign-in makes exactly one /auth/validate request, feeding the role from its response', async () => {
  rtl.render(createElement(App));

  await signIn('fresh-key');

  // The login page's own validate is the one request; the startup re-validation effect must not
  // re-fire on the null→key transition that storing the fresh key causes.
  assert.equal(validateCallCount(), 1);
  assert.equal(localStorage.getItem(ROLE_KEY), 'operator');
  assert.equal(sessionStorage.getItem(LOGIN_KEY), 'fresh-key');
});

test('a fresh sign-in with a role-less validate response still degrades to viewer', async () => {
  validateBody = { valid: true };
  rtl.render(createElement(App));

  await signIn('fresh-key');

  assert.equal(validateCallCount(), 1);
  assert.equal(localStorage.getItem(ROLE_KEY), 'viewer');
});

test('a page reload with a saved key re-validates once at startup and refreshes the cached role', async () => {
  sessionStorage.setItem(LOGIN_KEY, 'saved-key');
  localStorage.setItem(ROLE_KEY, 'viewer'); // stale cached role
  validateBody = { valid: true, role: 'admin' };
  rtl.render(createElement(App));

  await rtl.waitFor(() => assert.equal(localStorage.getItem(ROLE_KEY), 'admin'));
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(validateCallCount(), 1);
});

test('App logout DELETEs Bull Board session with the API key still present (then drops the key)', async () => {
  rtl.render(createElement(App));
  await signIn('logout-order-key');

  const { screen, waitFor, fireEvent } = rtl;
  const logoutBtn = await screen.findByRole('button', { name: /logout/i });
  fireEvent.click(logoutBtn);

  await waitFor(() => assert.equal(sessionStorage.getItem(LOGIN_KEY), null));
  await new Promise(resolve => setTimeout(resolve, 0));

  const boardDeletes = fetchCalls.filter(
    c => c.method === 'DELETE' && c.path === '/api/admin/queues-board-session',
  );
  assert.equal(boardDeletes.length, 1, `expected one board DELETE, got ${JSON.stringify(fetchCalls)}`);
  assert.equal(boardDeletes[0].apiKey, 'logout-order-key');
});
