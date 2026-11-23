import './test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { AUTH_SYNC_STORAGE_KEY } from './utils/authLifecycle.ts';

let rtl: typeof import('@testing-library/react');
let App: (typeof import('./App.tsx'))['default'];
const realFetch = globalThis.fetch;

before(async () => {
  const { installJsdomGlobals } = await import('./test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = new Date(0).toISOString();
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
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
  window.sessionStorage.clear();
});

after(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('cross-tab login event clears previous session and enters hydrating spinner until session resolves', async () => {
  let actorKeyId = 'key-admin-1';
  let actorRole: 'admin' | 'viewer' = 'admin';
  let holdSession: (() => void) | null = null;
  let sessionGate: Promise<void> | null = null;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/auth/session') {
      const reply = () =>
        json({ valid: true, role: actorRole, scoped: false, apiKeyId: actorKeyId, engineType: 'baileys' });
      return sessionGate ? sessionGate.then(reply) : Promise.resolve(reply());
    }
    if (path.startsWith('/api/audit')) return Promise.resolve(json({ data: [], total: 0 }));
    if (path.startsWith('/api/sessions')) return Promise.resolve(json([]));
    if (path.startsWith('/api/webhooks')) return Promise.resolve(json([]));
    if (path.startsWith('/api/infra/update-check')) return Promise.resolve(json({ updateAvailable: false }));
    if (path.startsWith('/api/app-info')) return Promise.resolve(json({ version: '0.26.0' }));
    return Promise.resolve(json([]));
  }) as typeof fetch;

  window.sessionStorage.setItem('openwa_api_key_id', 'key-admin-1');
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.history.replaceState(null, '', '/logs');
  rtl.render(createElement(App));
  await rtl.screen.findByRole('link', { name: 'API Keys' });

  actorKeyId = 'key-viewer-2';
  actorRole = 'viewer';
  sessionGate = new Promise<void>(resolve => {
    holdSession = resolve;
  });

  rtl.act(() => {
    window.dispatchEvent(
      new window.StorageEvent('storage', {
        key: AUTH_SYNC_STORAGE_KEY,
        newValue: JSON.stringify({ type: 'login', apiKeyId: 'key-viewer-2', at: Date.now() }),
      }),
    );
  });

  await rtl.waitFor(() => {
    assert.equal(rtl.screen.queryByRole('link', { name: 'API Keys' }) === null, true);
    assert.ok(document.querySelector('.animate-spin'));
  });

  await rtl.act(async () => {
    holdSession?.();
    await sessionGate;
    sessionGate = null;
  });

  await rtl.waitFor(() => {
    assert.ok(rtl.screen.getByRole('link', { name: 'Sessions' }));
    assert.equal(rtl.screen.queryByRole('link', { name: 'API Keys' }) === null, true);
  });
});

test('hydrateFromServer clears cached actor state when re-authenticating as another actor without a broadcast', async () => {
  let actorKeyId = 'key-admin-1';
  let actorRole: 'admin' | 'viewer' = 'admin';
  let sessionList = [{ id: 's-actor-1', name: 'Secret Actor One Session', status: 'ready', phone: '1' }];

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/auth/session') {
      return Promise.resolve(json({ valid: true, role: actorRole, scoped: false, apiKeyId: actorKeyId }));
    }
    if (path === '/api/sessions') return Promise.resolve(json(sessionList));
    if (path.startsWith('/api/webhooks')) return Promise.resolve(json([]));
    if (path.startsWith('/api/infra/update-check')) return Promise.resolve(json({ updateAvailable: false }));
    if (path.startsWith('/api/app-info')) return Promise.resolve(json({ version: '0.26.0' }));
    return Promise.resolve(json([]));
  }) as typeof fetch;

  window.sessionStorage.setItem('openwa_api_key_id', 'key-admin-1');
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.history.replaceState(null, '', '/sessions');
  const firstView = rtl.render(createElement(App));
  await rtl.screen.findByText('Secret Actor One Session');
  firstView.unmount();

  actorKeyId = 'key-viewer-2';
  actorRole = 'viewer';
  sessionList = [{ id: 's-actor-2', name: 'Public Actor Two Session', status: 'ready', phone: '2' }];

  // Restore sessionStorage stale key metadata as if the cookie changed before reload without a login event.
  window.sessionStorage.setItem('openwa_api_key_id', 'key-admin-1');
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.history.replaceState(null, '', '/sessions');
  rtl.render(createElement(App));

  await rtl.screen.findByText('Public Actor Two Session');
  assert.equal(rtl.screen.queryByText('Secret Actor One Session') === null, true);
});
