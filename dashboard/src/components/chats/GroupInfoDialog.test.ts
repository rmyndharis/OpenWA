// The member field of the group dialog reads a number the way the other number fields do: in the digits of any
// script, as the ASCII digits the gateway takes.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import type { Chat, Session } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let GroupInfoDialog: (typeof import('./GroupInfoDialog.tsx'))['default'];
let wrap: (children: ReactNode) => ReactNode;
let realFetch: typeof fetch;
let queryClient: import('@tanstack/react-query').QueryClient;

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

const session = {
  id: 's1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00Z',
} as Session;
const group = { id: '120363000000000001@g.us', name: 'Team', isGroup: true, kind: 'group' } as Chat;

// The numbers the gateway was asked to check, and the participants it was asked to add.
const checked: string[] = [];
const added: string[][] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: false,
    isViewer: false,
    canWrite: true,
    engineType: null,
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  };
  wrap = children =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleContext.Provider, { value: role }, createElement(ToastProvider, null, children)),
    );
  ({ default: GroupInfoDialog } = await import('./GroupInfoDialog.tsx'));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
    if (path.includes('/contacts/check/')) {
      const number = decodeURIComponent(path.split('/contacts/check/')[1]);
      checked.push(number);
      return json({ number, exists: true, whatsappId: `${number}@c.us` });
    }
    if (path.endsWith('/participants') && init?.method === 'POST') {
      const { participants } = JSON.parse(String(init.body)) as { participants: string[] };
      added.push(participants);
      return json({ results: participants.map(id => ({ id, success: true })) });
    }
    if (path.includes('/groups/')) {
      return json({
        id: group.id,
        name: 'Team',
        participants: [{ id: '15551234567@c.us', number: '15551234567', isAdmin: true, isSuperAdmin: false }],
      });
    }
    return json({ url: null });
  }) as typeof fetch;
});

afterEach(() => {
  rtl.cleanup();
  checked.length = 0;
  added.length = 0;
});

// The dialog opens on the Info tab: the Participants tab holds the member field.
async function openMemberField(): Promise<HTMLInputElement> {
  rtl.render(wrap(createElement(GroupInfoDialog, { session, group, onClose: () => {}, onRenamed: () => {} })));
  rtl.fireEvent.click(await rtl.screen.findByRole('tab', { name: 'Participants' }));
  return (await rtl.screen.findByPlaceholderText('Add a number with country code')) as HTMLInputElement;
}

const addButton = () => rtl.screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
const native = (ascii: string, zero: number) => [...ascii].map(d => String.fromCharCode(zero + Number(d))).join('');

for (const [script, zero] of [
  ['ASCII', 0x30],
  ['Arabic-Indic', 0x0660],
  ['Persian', 0x06f0],
  ['Devanagari', 0x0966],
  ['Telugu', 0x0c66],
  ['full-width', 0xff10],
] as const) {
  test(`a member typed in ${script} digits is checked and added as ASCII digits`, async () => {
    const field = await openMemberField();
    assert.equal(addButton().disabled, true, 'nothing typed yet');
    rtl.fireEvent.change(field, { target: { value: `+${native('628123456789', zero)}` } });
    assert.equal(addButton().disabled, false, 'a number of 12 digits enables Add');
    rtl.fireEvent.click(addButton());
    await rtl.waitFor(() => assert.equal(added.length, 1));
    assert.deepEqual(checked, ['628123456789']);
    assert.deepEqual(added, [['628123456789@c.us']]);
  });
}

test('the 00 prefix is dropped from a number typed in native digits', async () => {
  const field = await openMemberField();
  rtl.fireEvent.change(field, { target: { value: native('00628123456789', 0x0660) } });
  rtl.fireEvent.click(addButton());
  await rtl.waitFor(() => assert.equal(added.length, 1));
  assert.deepEqual(checked, ['628123456789']);
});

test('a number shorter than seven digits keeps Add disabled in any script', async () => {
  const field = await openMemberField();
  for (const zero of [0x30, 0x0660]) {
    rtl.fireEvent.change(field, { target: { value: native('628123', zero) } });
    assert.equal(addButton().disabled, true);
  }
});

// A number has at most 15 digits (E.164): more is two numbers run together or a typo, refused before any lookup. The
// 00 prefix is not part of the number.
test('a number longer than fifteen digits keeps Add disabled and Enter checks nothing', async () => {
  const field = await openMemberField();
  for (const value of [
    '+6281234567890123',
    `+${native('6281234567890123', 0x0660)}`,
    '+62 812 3456 789 +62 812 3456 790',
  ]) {
    rtl.fireEvent.change(field, { target: { value } });
    assert.equal(addButton().disabled, true, `${value} enables Add`);
    rtl.fireEvent.submit(field.closest('form')!);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(checked, []);
});

test('a 00 prefix does not count toward the fifteen digits', async () => {
  const field = await openMemberField();
  rtl.fireEvent.change(field, { target: { value: '00628123456789012' } });
  assert.equal(addButton().disabled, false, 'fifteen digits after 00 keep Add disabled');
  rtl.fireEvent.click(addButton());
  await rtl.waitFor(() => assert.equal(added.length, 1));
  assert.deepEqual(checked, ['628123456789012']);
});

test('Enter submits a number typed in native digits', async () => {
  const field = await openMemberField();
  rtl.fireEvent.change(field, { target: { value: native('628123456789', 0x0966) } });
  rtl.fireEvent.submit(field.closest('form')!);
  await rtl.waitFor(() => assert.equal(added.length, 1));
  assert.deepEqual(added, [['628123456789@c.us']]);
});

// Clearing the cache drops the garbage-collection timers of the group and picture queries, which would hold the
// process open after the last test.
after(() => {
  queryClient.clear();
  globalThis.fetch = realFetch;
});
