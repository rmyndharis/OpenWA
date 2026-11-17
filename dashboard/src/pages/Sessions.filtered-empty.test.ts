// A search or a status filter that hides every session of a list that is not empty is not a gateway with no sessions:
// the empty state says the filter hid them, as the Logs, Templates and Plugins pages do, and never tells the operator to
// create one. A gateway with no session tells only a key that can create one to do so.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let Sessions: typeof import('./Sessions.tsx').Sessions;
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
let ToastProvider: typeof import('../components/Toast.tsx').ToastProvider;
let queryClient: QueryClient | undefined;

const SESSION = {
  id: 'sess-1',
  name: 'new-device',
  status: 'ready',
  engineLoaded: true,
  phone: '15550001111',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
let sessionList: unknown[] = [SESSION];

const TITLE = 'No sessions found';
const CREATE_HINT = 'Create a new session to get started';
const FILTER_HINT = 'No session matches the search or status filter.';

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = path === '/api/sessions' ? sessionList : { message: 'unstubbed' };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: path === '/api/sessions' ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Sessions } = await import('./Sessions.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  window.sessionStorage.clear();
  sessionList = [SESSION];
  queryClient?.clear();
  queryClient = undefined;
});

function renderSessions(role: 'admin' | 'viewer') {
  window.sessionStorage.setItem('openwa_user_role', role);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Sessions))),
    ),
  );
}

const shown = (text: string) => rtl.screen.queryByText(text) !== null;

for (const role of ['admin', 'viewer'] as const) {
  test(`a search that hides the only session says the filter hid it (${role} key)`, async () => {
    const { screen, fireEvent } = rtl;
    renderSessions(role);
    await screen.findByText('new-device');

    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: 'no-such-session' } });
    await screen.findByText(FILTER_HINT);
    assert.equal(shown('new-device'), false);
    assert.equal(shown(TITLE), true);
    assert.equal(shown(CREATE_HINT), false, 'a list holding one session was told to create one');
  });
}

test('a status filter that hides the only session says the filter hid it', async () => {
  const { screen, fireEvent } = rtl;
  renderSessions('admin');
  await screen.findByText('new-device');

  fireEvent.click(screen.getByRole('button', { name: /All Status/ }));
  fireEvent.click(await screen.findByRole('option', { name: 'Inactive' }));
  await screen.findByText(FILTER_HINT);
  assert.equal(shown('new-device'), false);
  assert.equal(shown(CREATE_HINT), false, 'a list holding one session was told to create one');
});

test('a gateway with no session still tells an admin to create one', async () => {
  sessionList = [];
  renderSessions('admin');
  await rtl.screen.findByText(CREATE_HINT);
  assert.equal(shown(TITLE), true);
  assert.equal(shown(FILTER_HINT), false, 'an empty gateway blamed a filter');
});

test('a gateway with no session does not tell a viewer or a session-scoped key to create one', async () => {
  sessionList = [];
  for (const scoped of [false, true]) {
    window.sessionStorage.setItem('openwa_key_scoped', String(scoped));
    renderSessions(scoped ? 'admin' : 'viewer');
    await rtl.screen.findByText(TITLE);
    assert.equal(shown(CREATE_HINT), false, `${scoped ? 'a scoped key' : 'a viewer'} was told to create a session`);
    assert.equal(shown(FILTER_HINT), false, 'an empty gateway blamed a filter');
    rtl.cleanup();
    queryClient?.clear();
  }
});
