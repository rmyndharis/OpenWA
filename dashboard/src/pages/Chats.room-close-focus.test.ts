// Closing the open chat removes the room, and with it the control that held keyboard focus (its Back button, the
// composer, the room menu's Close chat). The page already keeps focus when it removes a control it owns (the contact
// panel hands it back to its toggle, the room menu to its button); closing the room must not drop it to the page
// either, or a keyboard or screen reader user starts again from the top of the document.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import type { Chat, ChatMessage, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const ALICE: Chat = {
  id: '15550001111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage: 'hello from alice',
  archived: false,
  pinned: false,
  muted: false,
};
const CAROL: Chat = { ...ALICE, id: '15550002222@c.us', name: 'Carol', lastMessage: 'hello from carol' };
const SECOND_SESSION: Session = { ...SESSION, id: 'session-2', name: 'Second', phone: '15550003333' };
let deleted = false;
const MESSAGE: ChatMessage = {
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: ALICE.id,
  from: ALICE.id,
  to: 'me',
  body: 'hello from alice',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let client: QueryClient | undefined;
const queries = new Set<Query>();

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : matches.call(this, selector);
  } as typeof matches;
  Element.prototype.scrollIntoView = function () {};
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(json([SESSION, SECOND_SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json(deleted ? [CAROL] : [ALICE, CAROL]));
    if (path.endsWith('/chats/delete')) {
      deleted = true;
      return Promise.resolve(json({ success: true }));
    }
    if (path.endsWith('/chats/unread')) return Promise.resolve(json({ success: true }));
    if (path.endsWith('/channels')) return Promise.resolve(json([{ id: '123@newsletter', name: 'News' }]));
    if (path.includes('/channels/') && path.includes('/messages')) return Promise.resolve(json([]));
    if (path.endsWith('/status'))
      return Promise.resolve(
        json({
          statuses: [
            {
              id: 'status-1',
              contact: { id: CAROL.id, name: 'Carol' },
              type: 'text',
              body: 'status text',
              timestamp: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          ],
        }),
      );
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (/\/profile-picture$/.test(path)) return Promise.resolve(json({ url: null }));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    if (path.includes('/messages?')) {
      const chatId = new URL(input.toString(), 'http://localhost').searchParams.get('chatId');
      const message = chatId === CAROL.id ? { ...MESSAGE, chatId: CAROL.id, body: 'hello from carol' } : MESSAGE;
      return Promise.resolve(json({ messages: [message], total: 1 }));
    }
    if (/\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(json([]));
    if (path.endsWith('/chats/read')) return Promise.resolve(json({ success: true }));
    return Promise.resolve(json({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(client?.isFetching() ?? 0, 0));
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
  // Deleting an open chat removes its query before the observer detaches and schedules its final GC timer.
  for (const query of queries) query.destroy();
  queries.clear();
  client = undefined;
  deleted = false;
});

after(() => {
  window.sessionStorage.clear();
});

async function openAlice(): Promise<HTMLElement> {
  const { screen, fireEvent, within } = rtl;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  client.getQueryCache().subscribe(event => {
    if (event.type === 'added') queries.add(event.query);
  });
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  const row = (await screen.findByText('Alice', { selector: '.chat-item-name' })).closest('[role="button"]');
  fireEvent.click(row as HTMLElement);
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  return container;
}

/** What holds focus, by role and name: never two DOM nodes compared. */
function focused(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return 'the page';
  return `${active.getAttribute('role') ?? active.tagName.toLowerCase()} "${(active.getAttribute('aria-label') ?? active.textContent ?? '').trim().slice(0, 40)}"`;
}

function focusedRow(): string | undefined {
  const active = document.activeElement;
  return active?.classList.contains('chat-item-card')
    ? (active.querySelector('.chat-item-name')?.textContent ?? undefined)
    : undefined;
}

test('closing the open chat with its Back button keeps keyboard focus on the page content', async () => {
  const { screen, fireEvent } = rtl;
  await openAlice();
  const back = screen.getByRole('button', { name: 'Back' });
  back.focus();
  fireEvent.click(back);
  await rtl.waitFor(() => assert.equal(document.querySelector('.room-container') === null, true));
  assert.equal(focusedRow(), 'Alice');
});

test('closing the open chat with Escape from the composer keeps keyboard focus on the page content', async () => {
  const { screen, fireEvent } = rtl;
  await openAlice();
  const field = screen.getByPlaceholderText('Type a message...');
  field.focus();
  fireEvent.keyDown(field, { key: 'Escape' });
  await rtl.waitFor(() => assert.equal(document.querySelector('.room-container') === null, true));
  assert.equal(focusedRow(), 'Alice');
});

test('Close chat in the room menu returns focus to its list row', async () => {
  await openAlice();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'More actions' }));
  const close = rtl.screen.getByRole('button', { name: 'Close chat' });
  close.focus();
  rtl.fireEvent.click(close);
  assert.equal(focusedRow(), 'Alice');
});

test('marking the open chat unread returns focus to its list row', async () => {
  const container = await openAlice();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'More actions' }));
  const unread = rtl
    .within(container.querySelector('.room-menu-popover') as HTMLElement)
    .getByRole('button', { name: 'Mark as unread' });
  unread.focus();
  rtl.fireEvent.click(unread);
  await rtl.waitFor(() => assert.equal(container.querySelector('.room-container') === null, true));
  assert.equal(focusedRow(), 'Alice');
});

test('deleting the open chat returns focus to sidebar search when its row is removed', async () => {
  const container = await openAlice();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'More actions' }));
  rtl.fireEvent.click(
    rtl
      .within(container.querySelector('.room-menu-popover') as HTMLElement)
      .getByRole('button', { name: 'Delete chat' }),
  );
  const dialog = await rtl.screen.findByRole('dialog');
  const confirm = rtl.within(dialog).getByRole('button', { name: 'Delete chat' });
  confirm.focus();
  rtl.fireEvent.click(confirm);
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('dialog') === null, true));
  assert.equal(document.activeElement?.parentElement?.className, 'chat-search-input');
});

test('switching tabs while a room is open preserves focus on the chosen tab', async () => {
  await openAlice();
  const tab = rtl.screen.getByRole('tab', { name: 'Channels' });
  tab.focus();
  rtl.fireEvent.click(tab);
  await rtl.screen.findByText('News');
  assert.equal(focused(), 'tab "Channels"');
});

test('switching sessions while a room is open preserves focus on the picker', async () => {
  const container = await openAlice();
  const picker = container.querySelector<HTMLButtonElement>('.session-switcher-btn')!;
  rtl.fireEvent.click(picker);
  const option = rtl.screen.getByRole('option', { name: /Second/ });
  rtl.act(() => option.focus());
  rtl.fireEvent.click(option);
  await rtl.waitFor(() => assert.equal(container.querySelector('.room-container') === null, true));
  assert.equal(document.activeElement?.classList.contains('session-switcher-btn'), true);
  assert.match(picker.textContent ?? '', /Second/);
});

test('opening another row preserves focus on that row', async () => {
  await openAlice();
  const row = rtl.screen.getByText('Carol', { selector: '.chat-item-name' }).closest<HTMLElement>('[role="button"]')!;
  row.focus();
  rtl.fireEvent.click(row);
  await rtl.screen.findByRole('heading', { name: 'Carol' });
  assert.equal(focusedRow(), 'Carol');
});

for (const visible of [true, false]) {
  test(`closing a room ${visible ? 'keeps a visible list row in place' : 'reveals an off-screen list row'}`, async () => {
    const container = await openAlice();
    const row = rtl.screen.getByText('Alice', { selector: '.chat-item-name' }).closest<HTMLElement>('[role="button"]')!;
    const list = container.querySelector<HTMLElement>('.chats-list')!;
    list.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, right: 300 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({ top: visible ? 150 : 500, bottom: visible ? 200 : 550, left: 0, right: 300 }) as DOMRect;
    let scrollBlock: ScrollLogicalPosition | undefined;
    let preventScroll: boolean | undefined;
    const calls: string[] = [];
    const focus = row.focus.bind(row);
    row.focus = options => {
      calls.push('focus');
      preventScroll = options?.preventScroll;
      focus(options);
    };
    row.scrollIntoView = options => {
      calls.push('scrollIntoView');
      if (typeof options === 'object') scrollBlock = options.block;
    };
    const back = rtl.screen.getByRole('button', { name: 'Back' });
    back.focus();
    rtl.fireEvent.click(back);
    assert.equal(focusedRow(), 'Alice');
    assert.equal(preventScroll, visible);
    assert.equal(scrollBlock, visible ? undefined : 'nearest');
    // Focusing an off-screen row scrolls it to the middle of the list, so it has to be aligned to the edge first.
    assert.deepEqual(calls, visible ? ['focus'] : ['scrollIntoView', 'focus']);
  });
}

for (const tabName of ['Channels', 'Status']) {
  test(`${tabName} Back returns focus to the selected list row`, async () => {
    const container = await openAlice();
    rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: tabName }));
    const row = (
      await rtl
        .within(container.querySelector('.chats-sidebar') as HTMLElement)
        .findByText(tabName === 'Channels' ? 'News' : 'Carol')
    ).closest<HTMLElement>('[role="button"]')!;
    rtl.fireEvent.click(row);
    const back = rtl.screen.getByRole('button', { name: 'Back' });
    back.focus();
    rtl.fireEvent.click(back);
    assert.equal(focusedRow(), tabName === 'Channels' ? 'News' : 'Carol');
  });
}

test('closing the new-chat panel returns focus to New chat', async () => {
  await openAlice();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'New chat' }));
  const back = rtl.screen.getAllByRole('button', { name: 'Back' }).find(el => el.closest('.chats-sidebar'))!;
  back.focus();
  rtl.fireEvent.click(back);
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'New chat');
});
