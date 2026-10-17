// Render tests for what the chat page offers beyond its data flow, which Chats.test.ts covers: the session
// switcher, the contact panel, the message search behind its toggle, the quick filters, the new-chat panel, and
// the chat row actions with their dialogs, each with its wire effect. The page is wrapped in the providers
// App.tsx uses and the backend is stubbed at the fetch layer; runs under the bare `node --test` runner.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, Chat } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A second account the gateway lists but that is not connected: the switcher shows it, and does not open it.
const OFFLINE_SESSION: Session = {
  ...SESSION,
  id: 'session-2',
  name: 'Marie Haas',
  phone: '491741565212',
  status: 'disconnected',
};
let listOffline = false;

const CHAT: Chat = {
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

// A group the account administers, served only when a test turns `listGroup` on.
const GROUP: Chat = {
  ...({} as Chat),
  id: '120363000000000001@g.us',
  name: 'Team',
  isGroup: true,
  kind: 'group',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage: 'hello team',
  archived: false,
  pinned: false,
  muted: false,
};
let listGroup = false;
// The contacts the session's blocklist holds.
let blockedIds: string[] = [];
// Whether the session's own number administers GROUP.
let groupAdmin = true;

const CONTACT = { id: '15550002222@c.us', name: 'Bob', number: '15550002222', isMyContact: true, isBlocked: false };
// The number the new-chat tests type, and the id the gateway resolves it to.
const TYPED_NUMBER = '+1 555 000 9999';
const RESOLVED_ID = '15550009999@c.us';
const GROUP_ID = '120363000000000000@g.us';

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, path, body });
    const base = `/api/sessions/${SESSION.id}`;

    if (method === 'GET' && path === '/api/sessions') {
      return Promise.resolve(jsonResponse(listOffline ? [SESSION, OFFLINE_SESSION] : [SESSION]));
    }
    if (method === 'GET' && path === `${base}/chats`) {
      return Promise.resolve(jsonResponse(listGroup ? [CHAT, GROUP] : [CHAT]));
    }
    const groupPath = `${base}/groups/${encodeURIComponent(GROUP.id)}`;
    if (method === 'GET' && path === groupPath) {
      return Promise.resolve(
        jsonResponse({
          id: GROUP.id,
          name: GROUP.name,
          description: 'old description',
          locked: true,
          participants: [
            { id: `${SESSION.phone}@c.us`, number: SESSION.phone, isAdmin: groupAdmin, isSuperAdmin: false },
            { id: '15550002222@c.us', number: '15550002222', name: 'Bob', isAdmin: false, isSuperAdmin: false },
          ],
        }),
      );
    }
    if (method === 'GET' && path === `${base}/contacts/blocked`) return Promise.resolve(jsonResponse(blockedIds));
    // Writes that answer an acknowledgement: group edits, chat state changes, clearing and deleting a chat,
    // and the contact writes (block, unblock, save).
    if (
      (method === 'POST' && /\/chats\/(archive|pin|mute)$/.test(path)) ||
      (/\/contacts\/[^/]+\/block$/.test(path) && method !== 'GET') ||
      (method === 'PUT' && /\/contacts\/[^/]+$/.test(path))
    ) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    if (
      path.startsWith(`${groupPath}/`) ||
      (method === 'POST' && (path === `${base}/chats/unread` || path === `${base}/chats/delete`)) ||
      (method === 'DELETE' && /\/chats\/[^/]+\/messages$/.test(path))
    ) {
      return Promise.resolve(jsonResponse({ success: true, message: 'ok' }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    if (method === 'GET' && /\/contacts\/[^/]+\/profile-picture$/.test(path)) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/check/`)) {
      return Promise.resolve(jsonResponse({ exists: true, whatsappId: RESOLVED_ID }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts?`)) return Promise.resolve(jsonResponse([CONTACT]));
    if (method === 'GET' && path.startsWith(`${base}/messages?`)) {
      return Promise.resolve(jsonResponse({ messages: [], total: 0 }));
    }
    if (method === 'GET' && /\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(jsonResponse([]));
    if (method === 'POST' && path === `${base}/chats/read`) return Promise.resolve(jsonResponse({ success: true }));
    if (method === 'POST' && path === `${base}/groups`) {
      return Promise.resolve(jsonResponse({ id: GROUP_ID, name: (body as { name: string }).name }, 201));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
// Every client a test rendered with: a test that renders twice must not leave the first one's gc timers behind,
// which hold the process open.
const queryClients: QueryClient[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  resetSocketDouble();
  for (const client of queryClients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  fetchCalls.length = 0;
  listOffline = false;
  listGroup = false;
  groupAdmin = true;
  blockedIds = [];
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
});

function renderPage(): ReturnType<RTL['render']> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  queryClients.push(queryClient);
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
}

test('the contact panel opens from the room header and Escape closes it before the room', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  fireEvent.click(within(container.querySelector('.room-header') as HTMLElement).getByText('Alice'));
  const panel = await waitFor(() => container.querySelector('.contact-info-panel') as HTMLElement);
  assert.ok(within(panel).getByText(CHAT.id), 'the panel shows the raw chat id');

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.equal(container.querySelector('.contact-info-panel'), null, 'the panel stayed open'));
  assert.ok(container.querySelector('.room-header'), 'Escape closed the room along with the panel');
});

test('the message search sits behind its toggle, and a read-only key is offered neither it nor a new chat', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  assert.ok(!screen.queryByLabelText('Search messages…'), 'the search was open before its toggle was pressed');
  fireEvent.click(screen.getByRole('button', { name: 'Search messages' }));
  assert.ok(screen.getByLabelText('Search messages…'), 'the toggle did not open the search');
  rtl.cleanup();

  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderPage();
  await screen.findByText('Alice');
  assert.ok(!screen.queryByRole('button', { name: 'Search messages' }), 'a viewer key was offered message search');
  assert.ok(!screen.queryByRole('button', { name: 'New chat' }), 'a viewer key was offered a new chat');
});

test('a quick filter that matches no chat says so instead of claiming the account has none', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Groups' }));
  assert.ok(screen.getByText('No chats match this filter'));
  assert.ok(!screen.queryByText('Alice'), 'the filter left a 1:1 chat in the groups list');
});

test('a typed number is checked with the gateway and opens a chat under the id it resolves to', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Start chat with/ }));

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the new chat did not open'));
  assert.ok(
    fetchCalls.some(c => c.method === 'GET' && c.path === `/api/sessions/${SESSION.id}/contacts/check/15550009999`),
    'the number was not checked with the gateway',
  );
  await within(container.querySelector('.room-header') as HTMLElement).findByText('15550009999');
  assert.ok(!container.querySelector('.new-chat-panel'), 'the panel stayed open over the list');
});

test('a group is created with the picked contacts on Baileys, and whatsapp-web.js is not offered one', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Team' } });
  fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the new group did not open'));
  const create = fetchCalls.find(c => c.method === 'POST' && c.path === `/api/sessions/${SESSION.id}/groups`);
  assert.deepEqual(create?.body, { name: 'Team', participants: [CONTACT.id] });
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Team');
  rtl.cleanup();

  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByText('Bob');
  assert.ok(
    !screen.queryByRole('button', { name: 'New group' }),
    'whatsapp-web.js, which answers 501, offered a group',
  );
});

test('the session switcher lists every session with its state, and only a connected one can be picked', async () => {
  const { screen, fireEvent } = rtl;
  listOffline = true;
  renderPage();
  await screen.findByText('Alice');

  const trigger = screen.getByRole('button', { name: /Main/ });
  fireEvent.click(trigger);
  const options = screen.getAllByRole('option');
  assert.deepEqual(
    options.map(option => [
      option.textContent?.includes('Main'),
      option.getAttribute('aria-selected'),
      option.matches(':disabled'),
    ]),
    [
      [true, 'true', false],
      [false, 'false', true],
    ],
  );
  assert.ok(
    screen.getByRole('img', { name: 'Disconnected' }),
    'the offline session does not say why it cannot be opened',
  );

  fireEvent.change(screen.getByLabelText('Search sessions...'), { target: { value: 'marie' } });
  assert.equal(screen.getAllByRole('option').length, 1, 'the search did not narrow the list');
});

test('Escape closes the session switcher, not the open chat', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  assert.ok(screen.getByRole('listbox'));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(!screen.queryByRole('listbox'), 'Escape left the switcher open');
  assert.ok(container.querySelector('.room-header'), 'Escape closed the chat behind the switcher');
});

test('a group row offers its actions, and marking it unread badges the row', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  // Group and 1:1 rows both carry the chevron.
  assert.equal(screen.getAllByRole('button', { name: /^Actions for/ }).length, 2);
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark as unread' }));

  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'POST' && c.path === `/api/sessions/${SESSION.id}/chats/unread`),
      'the gateway was not asked to mark the chat unread',
    ),
  );
  assert.deepEqual(fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/chats/unread`)?.body, {
    chatId: GROUP.id,
  });
  await screen.findByLabelText('Marked as unread');
});

test('leaving a group asks in a dialog first, and only its confirm button tells the gateway', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  const leavePath = `/api/sessions/${SESSION.id}/groups/${encodeURIComponent(GROUP.id)}/leave`;

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
  let dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Leave the group "Team"?'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  assert.ok(!screen.queryByRole('dialog'), 'Cancel left the dialog open');
  assert.ok(!fetchCalls.some(c => c.path === leavePath), 'Cancel left the group');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'POST' && c.path === leavePath),
      'not left',
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByRole('dialog'), 'the dialog stayed open after leaving'));
});

test('the group dialog saves a new name through the subject route and renames the row', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));

  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Managed via ${SESSION.name}`);
  fireEvent.change(within(dialog).getByDisplayValue('Team'), { target: { value: 'Team Nord' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

  await waitFor(() =>
    assert.deepEqual(
      fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/groups/${encodeURIComponent(GROUP.id)}/subject`)
        ?.body,
      { subject: 'Team Nord' },
    ),
  );
  // The description was not touched, so its route is not called.
  assert.ok(!fetchCalls.some(c => c.path.endsWith('/description')), 'an unchanged description was saved');
  await waitFor(() => assert.ok(screen.getAllByText('Team Nord').length > 0, 'the row kept the old name'));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  assert.ok(within(dialog).getByText('Bob'));
  assert.ok(within(dialog).getByRole('button', { name: 'Remove: Bob' }), 'an admin was offered no member actions');
});

test('a member who is no admin sees the group read-only, and a viewer key gets no write actions', async () => {
  const { screen, fireEvent, within } = rtl;
  listGroup = true;
  groupAdmin = false;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderPage();
  await screen.findByText('Team');
  // A viewer may look at a 1:1 contact, and nothing else.
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.ok(screen.getByRole('button', { name: 'Contact info' }));
  assert.ok(!screen.queryByRole('button', { name: 'Block contact' }), 'a viewer was offered blocking');
  assert.ok(!screen.queryByRole('button', { name: 'Pin chat' }), 'a viewer was offered pinning');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  assert.ok(!screen.queryByRole('button', { name: 'Mark as unread' }), 'a viewer was offered mark-as-unread');
  assert.ok(!screen.queryByRole('button', { name: 'Leave group' }), 'a viewer was offered leaving the group');
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));

  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Not an admin via ${SESSION.name}`);
  assert.ok((within(dialog).getByDisplayValue('Team') as HTMLInputElement).disabled, 'the name is editable');
  assert.ok((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled);
});

test('a 1:1 row clears its chat and deletes it, each only after its own confirmation', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  const chatPath = `/api/sessions/${SESSION.id}/chats`;

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  // A 1:1 row has no group actions.
  assert.ok(!screen.queryByRole('button', { name: 'Group info' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }));
  let dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Delete every message in the chat with Alice?'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'DELETE' && c.path === `${chatPath}/${encodeURIComponent(CHAT.id)}/messages`),
      'the chat was not cleared',
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.ok(screen.getByText('Alice'), 'clearing removed the chat from the list');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.method === 'POST' && c.path === `${chatPath}/delete`)?.body, {
      chatId: CHAT.id,
    }),
  );
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the deleted chat stayed in the list'));
});

/** Open a row's chevron menu and pick one of its actions. */
function pickRowAction(name: string, action: string): void {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(screen.getByRole('button', { name: action }));
}

test('archiving a chat moves it into the archive view, and unarchiving brings it back', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Archive chat');
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/chats/archive`)?.body, {
      chatId: CHAT.id,
      archive: true,
    }),
  );
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the archived chat stayed in the main list'));

  fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Unarchive chat');
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the unarchived chat stayed in the archive view'));
  fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
  await screen.findByText('Alice');
});

test('a pinned chat leads the list with a pin, and a muted one carries the mute it was given', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const { container } = renderPage();
  await screen.findByText('Team');

  pickRowAction('Team', 'Pin chat');
  await waitFor(() =>
    assert.equal(container.querySelector('.chats-list .chat-item-name')?.textContent, 'Team', 'not pinned first'),
  );
  assert.ok(screen.getByRole('img', { name: 'Pinned' }));

  pickRowAction('Alice', 'Mute notifications');
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByLabelText('Always'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/chats/mute`)?.body, {
      chatId: CHAT.id,
      muteUntil: Date.UTC(2100, 0, 1),
    }),
  );
  await screen.findByRole('img', { name: 'Muted' });
});

test('blocking a contact asks first, and the menu then offers to unblock it', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Block contact');
  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Block Alice?'));
  blockedIds = [CHAT.id];
  fireEvent.click(within(dialog).getByRole('button', { name: 'Block contact' }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(
        c =>
          c.method === 'POST' && c.path === `/api/sessions/${SESSION.id}/contacts/${encodeURIComponent(CHAT.id)}/block`,
      ),
      'the contact was not blocked',
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Unblock contact' });
});

test('saving a contact sends its name to the address book and renames the row', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Rename contact');
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Alice' } });
  fireEvent.change(within(dialog).getByLabelText('Last name (optional)'), { target: { value: 'Smith' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    assert.deepEqual(
      fetchCalls.find(
        c => c.method === 'PUT' && c.path === `/api/sessions/${SESSION.id}/contacts/${encodeURIComponent(CHAT.id)}`,
      )?.body,
      { firstName: 'Alice', lastName: 'Smith' },
    ),
  );
  await screen.findByText('Alice Smith');
});
