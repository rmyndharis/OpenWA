// The New chat panel reads a number typed with its country code. The panel lives under components/chats, so this
// test sits beside the other component tests, on the harness of the page tests (providers and a fetch stub).
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let NewChatPanel: (typeof import('./chats/NewChatPanel.tsx'))['default'];
let RoleProvider: (typeof import('./RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];
let realFetch: typeof fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const CONTACTS = [
  { id: '491701234567@c.us', name: 'Anna', number: '491701234567', isMyContact: true, isBlocked: false },
  { id: '628123456789@c.us', name: 'Ben', number: '628123456789', isMyContact: true, isBlocked: false },
];

const native = (ascii: string, zero: number) => [...ascii].map(d => String.fromCharCode(zero + Number(d))).join('');

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: NewChatPanel } = await import('./chats/NewChatPanel.tsx'));
  ({ RoleProvider } = await import('./RoleProvider.tsx'));
  ({ ToastProvider } = await import('./Toast.tsx'));
  realFetch = globalThis.fetch;
});

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = realFetch;
  sessionStorage.clear();
});

function renderPanel(): { lookups: string[] } {
  const lookups: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/contacts/check/')) {
      const number = path.split('/contacts/check/')[1];
      lookups.push(number);
      return jsonResponse({ number, exists: true, whatsappId: `${number}@c.us` });
    }
    if (path.includes('/contacts?')) return jsonResponse(CONTACTS);
    return jsonResponse([]);
  }) as typeof fetch;
  sessionStorage.setItem('openwa_user_role', 'operator');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        RoleProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(NewChatPanel, { sessionId: 's1', onOpenChat: () => {}, onClose: () => {} }),
        ),
      ),
    ),
  );
  return { lookups };
}

const search = () => rtl.screen.getByPlaceholderText('Search name or number with country code');

for (const [script, zero] of [
  ['Arabic-Indic', 0x0660],
  ['full-width', 0xff10],
] as const) {
  test(`a number typed in ${script} digits is offered and looked up as ASCII digits`, async () => {
    const { lookups } = renderPanel();
    rtl.fireEvent.change(search(), { target: { value: `+${native('491701234567', zero)}` } });
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Start chat with/ }));
    await rtl.waitFor(() => assert.equal(lookups.length, 1));
    assert.deepEqual(lookups, ['491701234567']);
  });

  test(`digits typed in ${script} digits find a contact by its number`, async () => {
    renderPanel();
    await rtl.screen.findByText('Anna');
    rtl.fireEvent.change(search(), { target: { value: native('1701234', zero) } });
    await rtl.waitFor(() => assert.equal(rtl.screen.queryByText('Ben') === null, true));
    assert.ok(rtl.screen.getByText('Anna'));
  });
}

// A query that reads as a number, but is not one that can start a chat, is told to carry the country code: in the
// digits of any script, as it is in ASCII.
for (const [script, zero] of [
  ['ASCII', 0x30],
  ['Arabic-Indic', 0x0660],
  ['full-width', 0xff10],
] as const) {
  test(`a short number typed in ${script} digits gets the country code hint`, async () => {
    renderPanel();
    rtl.fireEvent.change(search(), { target: { value: native('628123', zero) } });
    assert.ok(await rtl.screen.findByText(/with the country code/));
  });
}

// The Enter that commits an input method composition (isComposing, or keyCode 229) is the input method's: the number
// is looked up on the Enter pressed once it is typed, not on the digits composed so far.
test('the Enter that commits an input method composition does not look the number up', async () => {
  const { lookups } = renderPanel();
  await rtl.screen.findByText('Anna');
  const field = search();

  rtl.fireEvent.compositionStart(field);
  rtl.fireEvent.change(field, { target: { value: '+4917012345' } });
  rtl.fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  rtl.fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
  rtl.fireEvent.compositionEnd(field);

  rtl.fireEvent.change(field, { target: { value: '+491701234567' } });
  rtl.fireEvent.keyDown(field, { key: 'Enter' });
  await rtl.waitFor(() => assert.ok(lookups.length > 0));
  assert.deepEqual(lookups, ['491701234567']);
});
