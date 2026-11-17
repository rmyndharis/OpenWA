// The pairing tabs of the QR dialog (QR Code, Link with Phone Number) are a row of role="tab" buttons: one stop in the
// Tab order, and an arrow key selects the other tab and takes focus there.
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
  id: 'sess-qr-1',
  name: 'new-device',
  status: 'qr_ready',
  engineLoaded: true,
  phone: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body =
      path === '/api/sessions'
        ? [SESSION]
        : path === `/api/sessions/${SESSION.id}/qr`
          ? { qrCode: 'data:image/png;base64,FAKE', status: SESSION.status }
          : { message: 'unstubbed' };
    const known = path === '/api/sessions' || path.endsWith('/qr');
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: known ? 200 : 404,
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
  queryClient?.clear();
  queryClient = undefined;
});

async function openPairingDialog() {
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Sessions))),
    ),
  );
  const card = (await rtl.screen.findByText('new-device')).closest('.session-card') as HTMLElement;
  rtl.fireEvent.click(rtl.within(card).getByRole('button', { name: 'Show QR' }));
  // The dialog fetches the QR when it opens; let that answer land before driving the tabs.
  await rtl.screen.findByAltText('QR');
}

const tabNames = () => rtl.screen.getAllByRole('tab').map(tab => tab.textContent);
const selectedTab = () => rtl.screen.getByRole('tab', { selected: true }).textContent;

test('an arrow key selects the other pairing tab and takes focus there', async () => {
  await openPairingDialog();
  assert.deepEqual(tabNames(), ['QR Code', 'Link with Phone Number']);
  const [qr, phone] = rtl.screen.getAllByRole('tab');
  qr.focus();
  rtl.fireEvent.keyDown(qr, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent, 'Link with Phone Number'));
  assert.equal(selectedTab(), 'Link with Phone Number');
  assert.ok(rtl.screen.getByLabelText('Phone Number'), 'the phone form is not showing');

  rtl.fireEvent.keyDown(phone, { key: 'Home' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent, 'QR Code'));
  assert.equal(selectedTab(), 'QR Code');
});

test('only the selected pairing tab is a Tab stop', async () => {
  await openPairingDialog();
  const stops = () =>
    rtl.screen
      .getAllByRole('tab')
      .filter(tab => tab.getAttribute('tabindex') !== '-1')
      .map(tab => tab.textContent);
  assert.deepEqual(stops(), ['QR Code']);
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'Link with Phone Number' }));
  assert.deepEqual(stops(), ['Link with Phone Number']);
});
