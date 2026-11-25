import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
import { clearActorState, isKeyUnusable, isUserRole, resolveStartupValidation } from './authLifecycle.ts';

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
    scoped: false,
  });
});

test('startup validation: ok + role also carries the engine the server reports', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'operator', engineType: 'baileys' }), {
    action: 'role',
    role: 'operator',
    scoped: false,
    engineType: 'baileys',
  });
});

test('startup validation: ok + role carries whether the key is session-scoped', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'admin', scoped: true }), {
    action: 'role',
    role: 'admin',
    scoped: true,
  });
  // Anything but a literal true is unscoped.
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'admin', scoped: 'yes' }), {
    action: 'role',
    role: 'admin',
    scoped: false,
  });
});

test('startup validation: ok without a usable role keeps the cached role', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: false }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'superuser' }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, null), { action: 'keep' });
});

test('isUserRole accepts exactly the three known roles', () => {
  assert.deepEqual(['admin', 'operator', 'viewer'].filter(isUserRole), ['admin', 'operator', 'viewer']);
  for (const value of ['superuser', '', undefined, null, 42, 'ADMIN']) {
    assert.equal(isUserRole(value), false, `expected ${String(value)} to be rejected`);
  }
});

// ── App-level auth flow: exactly one /auth/validate per sign-in ──────────────
// Render smoke tests of the full App for the two entry paths (fresh sign-in, page reload with a
// saved key). Harness mirrors Infrastructure.test.ts: jsdom globals, a fetch stub recording every
// call, i18n catalogues awaited before render. App brings its own providers, so no wrapper here.

const LEGACY_KEY = 'openwa_api_key';
const ACTOR_ID_KEY = 'openwa_api_key_id';
const ROLE_KEY = 'openwa_user_role';
const ENGINE_KEY = 'openwa_engine_type';
const SCOPED_KEY = 'openwa_key_scoped';

interface FetchCall {
  method: string;
  path: string;
  credentials?: RequestCredentials;
}

const fetchCalls: FetchCall[] = [];

// Per-test session state returned by POST /auth/session and GET /auth/session.
let sessionBody: { valid?: boolean; role?: string; engineType?: string; scoped?: boolean; apiKeyId?: string } = {
  valid: true,
  role: 'operator',
  engineType: 'whatsapp-web.js',
  apiKeyId: 'key-op-1',
};
let hasServerCookie = false;
// False models a browser that drops the Set-Cookie of the exchange (an API on another site, blocked cookies).
let browserKeepsCookie = true;

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    fetchCalls.push({ method, path, credentials: init?.credentials });

    let status = 200;
    let body: unknown = [];
    if (method === 'POST' && path === '/api/auth/session') {
      hasServerCookie = browserKeepsCookie;
      body = sessionBody;
    } else if (method === 'GET' && path === '/api/auth/session') {
      if (!hasServerCookie) {
        status = 401;
        body = { message: 'Session is required' };
      } else {
        body = sessionBody;
      }
    } else if (method === 'DELETE' && path === '/api/auth/session') {
      hasServerCookie = false;
      body = { ok: true };
    } else if (path === '/api/stats/overview') {
      body = {
        sessions: { active: 0, total: 0, byStatus: {} },
        messages: { sent: 0, received: 0, failed: 0, today: { sent: 0, received: 0 } },
      };
    } else if (path.startsWith('/api/stats/messages')) {
      body = { timeSeries: [], byType: {}, bySession: [], topChats: [] };
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  };
}

function sessionCreateCallCount(): number {
  return fetchCalls.filter(c => c.method === 'POST' && c.path === '/api/auth/session').length;
}

function sessionGetCallCount(): number {
  return fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/auth/session').length;
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
  hasServerCookie = false;
  browserKeepsCookie = true;
  sessionBody = { valid: true, role: 'operator', engineType: 'whatsapp-web.js', apiKeyId: 'key-op-1' };
});

// Types a key into the login form and submits it, then waits until App has applied the role from
// the POST /auth/session response.
async function signIn(apiKey: string): Promise<void> {
  const { screen, waitFor, fireEvent } = rtl;
  const input = await screen.findByLabelText('API Key');
  fireEvent.change(input, { target: { value: apiKey } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.ok(sessionStorage.getItem(ROLE_KEY), 'expected a role to be stored after sign-in'));
  // Give the post-login render and its effects a macrotask to fire before counting requests.
  await new Promise(resolve => setTimeout(resolve, 50));
}

test('a fresh sign-in exchanges the key at POST /auth/session without storing raw keys and clears legacy storage', async () => {
  sessionStorage.setItem(LEGACY_KEY, 'legacy-plaintext-key');
  rtl.render(createElement(App));

  await signIn('fresh-key');

  assert.equal(sessionCreateCallCount(), 1);
  assert.equal(sessionStorage.getItem(ROLE_KEY), 'operator');
  assert.equal(sessionStorage.getItem(ACTOR_ID_KEY), 'key-op-1');
  assert.equal(sessionStorage.getItem(LEGACY_KEY), null);
  assert.equal(localStorage.getItem(LEGACY_KEY), null);
  // The engine comes from the same response: a non-admin key cannot read /infra/engines/current.
  assert.equal(sessionStorage.getItem(ENGINE_KEY), 'whatsapp-web.js');
});

// The exchange answers 200 even when the browser drops its cookie, and every request after it answers 401: signing in
// on that answer alone showed the dashboard for a moment and then the login form again, with no message.
test('a sign-in whose session cookie the browser did not keep stays on the login form and says why', async () => {
  browserKeepsCookie = false;
  rtl.render(createElement(App));
  const input = await rtl.screen.findByLabelText('API Key');
  rtl.fireEvent.change(input, { target: { value: 'fresh-key' } });
  rtl.fireEvent.submit(input.closest('form')!);

  const alert = await rtl.screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /did not keep the session cookie/);
  assert.ok(rtl.screen.getByLabelText('API Key'));
  assert.equal(sessionStorage.getItem(ROLE_KEY), null);
  assert.equal(sessionStorage.getItem(ACTOR_ID_KEY), null);
  // The startup check, the exchange and its confirmation: no dashboard request, no second attempt.
  assert.deepEqual(
    fetchCalls.map(c => `${c.method} ${c.path}`),
    ['GET /api/auth/session', 'POST /api/auth/session', 'GET /api/auth/session'],
  );
});

test('a fresh sign-in with a role-less session response still degrades to viewer', async () => {
  sessionBody = { valid: true, apiKeyId: 'key-viewer-1' };
  rtl.render(createElement(App));

  await signIn('fresh-key');

  assert.equal(sessionCreateCallCount(), 1);
  assert.equal(sessionStorage.getItem(ROLE_KEY), 'viewer');
});

test('a page reload with an active browser session hydrates via GET /auth/session and refreshes the cached role', async () => {
  hasServerCookie = true;
  sessionStorage.setItem(ACTOR_ID_KEY, 'key-admin-1');
  sessionStorage.setItem(ROLE_KEY, 'viewer'); // stale cached role
  sessionBody = { valid: true, role: 'admin', engineType: 'baileys', apiKeyId: 'key-admin-1' };
  rtl.render(createElement(App));

  await rtl.waitFor(() => assert.equal(sessionStorage.getItem(ROLE_KEY), 'admin'));
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(sessionGetCallCount(), 1);
  assert.equal(fetchCalls.find(c => c.method === 'GET' && c.path === '/api/auth/session')?.credentials, 'include');
  assert.equal(sessionStorage.getItem(ENGINE_KEY), 'baileys');
});

test('a 401, or a 403 from allowedIps refusing this client, makes the key unusable', () => {
  assert.equal(isKeyUnusable(401, undefined), true);
  assert.equal(isKeyUnusable(401, 'Invalid API key'), true);
  assert.equal(isKeyUnusable(403, 'IP address not allowed'), true);
  assert.equal(isKeyUnusable(403, 'Client IP could not be determined'), true);
});

test('a role or scope 403 and other failures keep the key', () => {
  assert.equal(isKeyUnusable(403, 'Insufficient permissions'), false);
  assert.equal(isKeyUnusable(403, undefined), false);
  assert.equal(isKeyUnusable(403, ['IP address not allowed']), false);
  assert.equal(isKeyUnusable(400, 'IP address not allowed'), false);
  assert.equal(isKeyUnusable(429, undefined), false);
  assert.equal(isKeyUnusable(500, undefined), false);
});

test('a fresh sign-in with a session-scoped admin key keeps the scope from the session response', async () => {
  sessionBody = { valid: true, role: 'admin', engineType: 'baileys', scoped: true, apiKeyId: 'key-scoped-admin' };
  rtl.render(createElement(App));

  await signIn('scoped-key');

  assert.equal(sessionStorage.getItem(ROLE_KEY), 'admin');
  assert.equal(sessionStorage.getItem(SCOPED_KEY), 'true');
});

test('a page reload refreshes the cached scope from the server', async () => {
  hasServerCookie = true;
  sessionStorage.setItem(ACTOR_ID_KEY, 'key-admin-1');
  sessionStorage.setItem(ROLE_KEY, 'admin');
  sessionStorage.setItem(SCOPED_KEY, 'true'); // stale: the key has since been unscoped
  sessionBody = { valid: true, role: 'admin', engineType: 'baileys', scoped: false, apiKeyId: 'key-admin-1' };
  rtl.render(createElement(App));

  await rtl.waitFor(() => assert.equal(sessionStorage.getItem(SCOPED_KEY), null));
});

test('a startup 401 drops the cached scope, role, and actor id', async () => {
  hasServerCookie = false;
  sessionStorage.setItem(ACTOR_ID_KEY, 'key-revoked');
  sessionStorage.setItem(ROLE_KEY, 'admin');
  sessionStorage.setItem(SCOPED_KEY, 'true');
  rtl.render(createElement(App));
  await rtl.waitFor(() => assert.equal(sessionStorage.getItem(ROLE_KEY), null));
  assert.equal(sessionStorage.getItem(SCOPED_KEY), null);
  assert.equal(sessionStorage.getItem(ACTOR_ID_KEY), null);
});

test('logout calls DELETE /auth/session with cookie credentials and clears session metadata', async () => {
  hasServerCookie = true;
  sessionStorage.setItem(ACTOR_ID_KEY, 'key-op-1');
  sessionStorage.setItem(ROLE_KEY, 'operator');
  rtl.render(createElement(App));

  const logoutBtn = await rtl.waitFor(() => {
    const btn = document.querySelector('.logout-btn');
    assert.ok(btn);
    return btn;
  });
  rtl.fireEvent.click(logoutBtn);

  await rtl.waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'DELETE' && c.path === '/api/auth/session' && c.credentials === 'include'),
    ),
  );
  assert.equal(sessionStorage.getItem(ACTOR_ID_KEY), null);
  assert.equal(sessionStorage.getItem(ROLE_KEY), null);
});

test('cross-tab auth sync clears a sibling tab on logout without sending a second DELETE and re-hydrates on actor login', async () => {
  hasServerCookie = true;
  sessionStorage.setItem(ACTOR_ID_KEY, 'key-op-1');
  sessionStorage.setItem(ROLE_KEY, 'operator');
  rtl.render(createElement(App));

  await rtl.waitFor(() => assert.ok(document.querySelector('.logout-btn')));
  fetchCalls.length = 0;

  // Simulate another tab broadcasting a secret-free logout sync event via storage event.
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'openwa_auth_sync',
      newValue: JSON.stringify({ type: 'logout', at: Date.now() }),
    }),
  );

  await rtl.waitFor(() => assert.ok(document.getElementById('apiKey')));
  assert.equal(sessionStorage.getItem(ACTOR_ID_KEY), null);
  assert.equal(
    fetchCalls.some(c => c.method === 'DELETE' && c.path === '/api/auth/session'),
    false,
    'sibling tab must not re-send DELETE /auth/session',
  );

  // Simulate another tab signing in as an admin key: sibling tab re-hydrates via GET /auth/session.
  hasServerCookie = true;
  sessionBody = { valid: true, role: 'admin', engineType: 'baileys', apiKeyId: 'key-admin-2' };
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'openwa_auth_sync',
      newValue: JSON.stringify({ type: 'login', apiKeyId: 'key-admin-2', at: Date.now() + 1 }),
    }),
  );

  await rtl.waitFor(() => assert.equal(sessionStorage.getItem(ACTOR_ID_KEY), 'key-admin-2'));
  assert.equal(sessionStorage.getItem(ROLE_KEY), 'admin');
  assert.equal(sessionStorage.getItem(LEGACY_KEY), null);

  // Even when a sibling tab re-logs in with the SAME apiKeyId (rotating the cookie session),
  // this tab must still re-hydrate via GET /auth/session so roles/sockets stay synchronized.
  fetchCalls.length = 0;
  sessionBody = { valid: true, role: 'viewer', engineType: 'baileys', apiKeyId: 'key-admin-2' };
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'openwa_auth_sync',
      newValue: JSON.stringify({ type: 'login', apiKeyId: 'key-admin-2', at: Date.now() + 2 }),
    }),
  );

  await rtl.waitFor(() => assert.equal(sessionStorage.getItem(ROLE_KEY), 'viewer'));
  assert.equal(
    fetchCalls.some(c => c.method === 'GET' && c.path === '/api/auth/session'),
    true,
    'expected GET /auth/session re-hydration on same-apiKeyId cross-tab login',
  );
});
