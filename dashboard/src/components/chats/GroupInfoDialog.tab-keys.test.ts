// The Info and Participants tabs of the group dialog are a row of role="tab" buttons: one stop in the Tab order, and an
// arrow key selects the other tab and takes focus there.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, Session } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let GroupInfoDialog: (typeof import('./GroupInfoDialog.tsx'))['default'];
let ToastProvider: (typeof import('../Toast.tsx'))['ToastProvider'];
let RoleContext: (typeof import('../../hooks/useRole.tsx'))['RoleContext'];
let queryClient: QueryClient | undefined;

const session = {
  id: 's1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00Z',
} as Session;
const group = { id: '120363000000000001@g.us', name: 'Team', isGroup: true, kind: 'group' } as Chat;

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../Toast.tsx'));
  ({ RoleContext } = await import('../../hooks/useRole.tsx'));
  ({ default: GroupInfoDialog } = await import('./GroupInfoDialog.tsx'));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
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
  queryClient?.clear();
  queryClient = undefined;
});

async function openDialog() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
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
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleContext.Provider,
        { value: role },
        createElement(
          ToastProvider,
          null,
          createElement(GroupInfoDialog, { session, group, onClose: () => {}, onRenamed: () => {} }),
        ),
      ),
    ),
  );
  // The group read the dialog starts has to land before the test ends.
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching(), 0));
}

const selectedTab = () => rtl.screen.getByRole('tab', { selected: true }).textContent;

test('an arrow key selects the other group tab and takes focus there', async () => {
  await openDialog();
  const [info, participants] = rtl.screen.getAllByRole('tab');
  assert.deepEqual(
    [info, participants].map(tab => tab.textContent),
    ['Info', 'Participants'],
  );
  info.focus();
  rtl.fireEvent.keyDown(info, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent, 'Participants'));
  assert.equal(selectedTab(), 'Participants');

  rtl.fireEvent.keyDown(participants, { key: 'ArrowRight' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent, 'Info'));
  assert.equal(selectedTab(), 'Info');
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching(), 0));
});

test('only the selected group tab is a Tab stop', async () => {
  await openDialog();
  const stops = () =>
    rtl.screen
      .getAllByRole('tab')
      .filter(tab => tab.getAttribute('tabindex') !== '-1')
      .map(tab => tab.textContent);
  assert.deepEqual(stops(), ['Info']);
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'Participants' }));
  assert.deepEqual(stops(), ['Participants']);
});
