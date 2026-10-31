// Role gating of the Logs page under the bare `node --test` runner, rendered through the real App so
// both halves are covered: the sidebar entry (Layout) and the route itself (App). GET /audit is
// ADMIN-only, so an operator or viewer reaching /logs only ever saw a load error over an empty table.
import './test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let role = 'operator';
let scoped = false;
const requested: string[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    requested.push(path);
    if (path === '/api/auth/validate') return Promise.resolve(jsonResponse({ valid: true, role, scoped }));
    if (path === '/api/audit' || path.startsWith('/api/audit?'))
      return Promise.resolve(jsonResponse({ data: [], total: 0 }));
    // One ready session: the Number Checker runs below need one, and the app's query cache keeps the first answer.
    if (path === '/api/sessions')
      return Promise.resolve(jsonResponse([{ id: 's1', name: 'Primary', status: 'ready', phone: '1' }]));
    if (path === '/api/webhooks') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let App: (typeof import('./App.tsx'))['default'];

before(async () => {
  const { installJsdomGlobals } = await import('./test-helpers/jsdom.ts');
  await installJsdomGlobals('http://localhost/logs');
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = new Date(0).toISOString();
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
  scoped = false;
  window.sessionStorage.removeItem('openwa_key_scoped');
});

function renderAt(path: string, as: string): void {
  role = as;
  requested.length = 0;
  window.history.replaceState(null, '', path);
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  window.sessionStorage.setItem('openwa_user_role', as);
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

test('an operator opening /number-checker gets the Number Checker page', async () => {
  renderAt('/number-checker', 'operator');
  await rtl.waitFor(() => assert.ok(document.querySelector('.number-checker'), 'the page did not render'), {
    timeout: 10_000,
  });
  assert.equal(window.location.pathname, '/number-checker');
});

// API keys, Infrastructure and Plugins read routes that refuse any session-scoped key, so a scoped
// admin opening one by URL or reload must be sent home rather than mount a page whose reads all 403.
for (const page of ['api-keys', 'infrastructure', 'plugins']) {
  test(`a session-scoped admin opening /${page} is sent home without calling its routes`, async () => {
    scoped = true;
    window.sessionStorage.setItem('openwa_key_scoped', 'true');
    renderAt(`/${page}`, 'admin');
    await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/sessions"]')));
    await rtl.waitFor(() => assert.equal(window.location.pathname, '/'));
    await new Promise(resolve => setTimeout(resolve, 50));
    const refused = requested.filter(path => /^\/api\/(auth\/api-keys|infra|plugins)/.test(path));
    assert.deepEqual(refused, [], 'the page sent reads a session-scoped key is refused on');
  });
}

// The startup /auth/validate for a saved key is not cancelled by a logout. If it lands after the user
// has signed back in with another key, its answer is about a key no longer in use and must not touch
// the new session's role.
test('a startup validation that lands after a sign-in with another key is ignored', async () => {
  const previous = globalThis.fetch;
  let answerStale: ((res: Response) => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/auth/validate')) {
      if (new Headers(init?.headers).get('X-API-Key') === 'old-admin-key')
        return new Promise<Response>(resolve => (answerStale = resolve));
      return Promise.resolve(jsonResponse({ valid: true, role: 'viewer' }));
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.setItem('openwa_api_key', 'old-admin-key');
    window.sessionStorage.setItem('openwa_user_role', 'admin');
    rtl.render(createElement(App));

    const logout = await rtl.waitFor(() => {
      const button = document.querySelector('.logout-btn');
      assert.ok(button);
      return button;
    });
    rtl.fireEvent.click(logout);
    const input = await rtl.waitFor(() => {
      const field = document.getElementById('apiKey');
      assert.ok(field);
      return field;
    });
    rtl.fireEvent.change(input, { target: { value: 'new-viewer-key' } });
    rtl.fireEvent.submit(input.closest('form')!);
    await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/sessions"]')));
    assert.equal(logsLink() === null, true, 'the Logs nav entry is shown to a viewer');

    assert.ok(answerStale, 'the startup validation was never sent');
    await rtl.act(async () => {
      answerStale!(jsonResponse({ valid: true, role: 'admin' }));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(logsLink() === null, true, "the old key's admin role was applied to the new viewer session");
    assert.equal(window.sessionStorage.getItem('openwa_api_key'), 'new-viewer-key');
  } finally {
    globalThis.fetch = previous;
  }
});

// The Number Checker page is a lazy route, so a bulk run held by the page itself ends with the page. These go
// through the real App: the run has to survive a move to another route, and end with a logout.
const THREE_NUMBERS = '911111111111\n912222222222\n913333333333';

async function startBulkRun(role = 'operator'): Promise<{ lookups: string[]; restore: () => void }> {
  const previous = globalThis.fetch;
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/contacts/check/')) {
      const number = url.split('/contacts/check/')[1];
      lookups.push(number);
      return Promise.resolve(jsonResponse({ number, exists: true, whatsappId: `${number}@c.us` }));
    }
    return previous(input, init);
  }) as typeof fetch;
  renderAt('/number-checker', role);
  rtl.fireEvent.click(await rtl.screen.findByRole('tab', { name: /Bulk/i }, { timeout: 10_000 }));
  await rtl.screen.findByRole('option', { name: /Primary/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: THREE_NUMBERS } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.waitFor(() => assert.equal(lookups.length, 1));
  return { lookups, restore: () => (globalThis.fetch = previous) };
}

test('a bulk Number Checker run goes on while another page is open and is there when the page is opened again', async () => {
  const { lookups, restore } = await startBulkRun();
  try {
    rtl.fireEvent.click(document.querySelector('a[href="/webhooks"]')!);
    // Compared as a boolean: a failed assert.equal on a DOM node formats the whole jsdom tree and stalls the runner.
    await rtl.waitFor(() => assert.equal(document.querySelector('.number-checker') === null, true));
    assert.equal(window.location.pathname, '/webhooks');
    await rtl.waitFor(() => assert.equal(lookups.length, 3), { timeout: 5_000 });

    rtl.fireEvent.click(document.querySelector('a[href="/number-checker"]')!);
    await rtl.waitFor(() => assert.ok(document.querySelector('.number-checker')), { timeout: 10_000 });
    const rows = () => document.querySelectorAll('.nc-history-table tbody tr').length;
    await rtl.waitFor(() => assert.equal(rows(), 3));
    assert.deepEqual(lookups, ['911111111111', '912222222222', '913333333333']);
  } finally {
    restore();
  }
});

test('signing out ends a bulk Number Checker run, and the next sign-in starts with no rows', async () => {
  const { lookups, restore } = await startBulkRun();
  try {
    rtl.fireEvent.click(document.querySelector('.logout-btn')!);
    await rtl.waitFor(() => assert.ok(document.getElementById('apiKey')));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.deepEqual(lookups, ['911111111111']);

    const input = document.getElementById('apiKey')!;
    rtl.fireEvent.change(input, { target: { value: 'next-key' } });
    rtl.fireEvent.submit(input.closest('form')!);
    await rtl.waitFor(() => assert.ok(document.querySelector('a[href="/number-checker"]')));
    window.history.replaceState(null, '', '/number-checker');
    rtl.fireEvent.click(document.querySelector('a[href="/number-checker"]')!);
    await rtl.waitFor(() => assert.ok(document.querySelector('.number-checker')), { timeout: 10_000 });
    assert.equal(document.querySelectorAll('.nc-history-table tbody tr').length, 0);
  } finally {
    restore();
  }
});
