// Render tests for what the chat page offers beyond its data flow, which Chats.test.ts covers: the session
// switcher, the contact panel, the message search behind its toggle, the quick filters, the new-chat panel, and
// the chat row actions with their dialogs, each with its wire effect. The page is wrapped in the providers
// App.tsx uses and the backend is stubbed at the fetch layer; runs under the bare `node --test` runner.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { Session, Chat } from '../services/api';
import { lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

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

// A second connected account, served when a test turns `listSecond` on. Its routes answer with the first
// session's fixtures, so both list the same chats: the shared chat id a late result must not cross over.
const SECOND_SESSION: Session = { ...SESSION, id: 'session-3', name: 'Second', phone: '15559876543' };
let listSecond = false;
// Served as the list reads them once a test turns them on: the second session dropped, the offline one connected.
let secondDown = false;
let offlineUp = false;

// The first account down at load (every session down, with `listOffline`), and an account created after the page
// read the list, served once a test turns `listCreated` on.
let mainDown = false;
// The first account deleted on the server: the list no longer holds it.
let mainDeleted = false;
const CREATED_SESSION: Session = {
  ...SESSION,
  id: 'session-4',
  name: 'Fresh',
  phone: '15550007777',
  status: 'qr_ready',
};
let listCreated: Session | null = null;

// Responses a test holds back until it releases them, by route name.
const gates = new Map<string, Promise<void>>();
function hold(name: string): () => void {
  let release!: () => void;
  gates.set(name, new Promise<void>(resolve => (release = resolve)));
  return release;
}
// When true, the chat and contact writes answer HTTP 200 with `{ success: false }`, as an engine that
// declined to act does.
let declineWrites = false;
// When true, the mark-as-read answers HTTP 200 with `{ success: false }`, as an engine with nothing to acknowledge does.
let declineReads = false;
// The profile pictures the batch route serves, by chat id; an id with none answers null.
const pictureFor: Record<string, string> = {};

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
// GROUP as the server holds it: the group routes read and write these.
let groupName = GROUP.name;
let groupDescription = 'old description';
let bobIsAdmin = false;
// When true, GROUP also lists a member WhatsApp knows by a privacy id only, which carries no phone number.
let groupHasLidMember = false;
// When true, the group's second member has no name, so the dialog names it by its phone.
let bobUnnamed = false;
// Whether the group's info is locked to admins, which decides what a member who is no admin may edit.
let groupLocked = true;
// When true, the session's own account is listed under an id with a device suffix.
let ownHasDeviceSuffix = false;
// How a membership write is refused. The dialog sends one participant at a time, and the gateway answers 403 when
// a write fails for every participant it was asked about ('all'). A refusal inside a 200 answer ('some') is what
// a batch it turned down in part gets; nothing in this dialog asks for one, but the answer shape is the route's.
let refuseMember: false | 'all' | 'some' = false;

const CONTACT = { id: '15550002222@c.us', name: 'Bob', number: '15550002222', isMyContact: true, isBlocked: false };
const ALICE_CONTACT = { id: CHAT.id, name: 'Alice', number: '15550001111', isMyContact: true, isBlocked: false };

// Served when a test turns `listExtra` on: a contact Baileys knows by push name only, listed as Baileys
// lists it (a bare push name, no `~`, `isMyContact: false`), and a chat keyed by a privacy id.
const PUSH_ONLY_CHAT: Chat = { ...CHAT, id: '628222@s.whatsapp.net', name: 'Bobby', lastMessage: 'hi' };
const PUSH_ONLY_CONTACT = {
  id: PUSH_ONLY_CHAT.id,
  pushName: 'Bobby',
  number: '628222',
  isMyContact: false,
  isBlocked: false,
};
const LID_CHAT: Chat = { ...CHAT, id: '262813461250071@lid', name: 'Lia', lastMessage: 'from a lid' };
// A contact the address book holds as saved under a name that reads like a number.
const NUMBER_NAMED_CHAT: Chat = { ...CHAT, id: '15550003333@c.us', name: '+1 555 000 3333', lastMessage: 'hey' };
const NUMBER_NAMED_CONTACT = {
  id: NUMBER_NAMED_CHAT.id,
  name: NUMBER_NAMED_CHAT.name,
  number: '15550003333',
  isMyContact: true,
  isBlocked: false,
};
let listExtra = false;
// The phone the gateway resolves a privacy id to, by id; an id it knows nothing about answers null.
const lidPhones: Record<string, string> = {};
// When true, resolving a privacy id fails as it does while the engine is busy; `failingLidIds` fails only those.
let failLidPhones = false;
const failingLidIds = new Set<string>();
// When true, it answers a phone that is no string, which nothing in the page expects.
let garbleLidPhones = false;
// When true, the lookups answer 429 once more than ten arrive within a second, as the gateway's short throttle tier
// does for one route and client; `phoneLookupTimes` is when each arrived.
let throttlePhoneLookups = false;
const phoneLookupTimes: number[] = [];
// When true, the number check answers that the number is not on WhatsApp.
let numberNotRegistered = false;
// How many more privacy-id chats the list holds, none of which resolves to a phone.
let extraLidChats = 0;
const extraLidChat = (n: number): Chat => ({
  ...CHAT,
  id: `9000000000${String(n).padStart(3, '0')}@lid`,
  name: `Lid ${n}`,
  timestamp: 1_600_000_000 - n,
  lastMessage: `from lid ${n}`,
});
// Served when a test turns `listDuplicateContact` on: Bob listed twice under one id, as whatsapp-web.js lists a
// contact it holds as both a LID and a phone record. The first copy carries another number than the id's.
const DUPLICATE_CONTACT = { ...CONTACT, number: '262813461250071' };
let listDuplicateContact = false;
// When true, the address book answers 503, as it does while the engine is busy.
let failContacts = false;
// What the chat list reports for Alice, which a test changes to stand for the phone changing her chat.
const aliceNow: Partial<Chat> = {};
// The messages the gateway holds for Alice's chat, oldest first.
let aliceThread: Array<Record<string, unknown>> = [];
const threadRow = (n: number, direction: 'incoming' | 'outgoing' = 'incoming') => ({
  id: `row-${n}`,
  waMessageId: `wamid.${direction === 'incoming' ? 'in' : 'out'}.${n}`,
  chatId: CHAT.id,
  from: direction === 'incoming' ? CHAT.id : 'me',
  to: direction === 'incoming' ? 'me' : CHAT.id,
  body: `message ${n}`,
  type: 'text',
  direction,
  status: 'sent',
  timestamp: 1_700_000_000 + n,
  createdAt: new Date((1_700_000_000 + n) * 1000).toISOString(),
});
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
    const rawPath = url.replace(/^https?:\/\/[^/]+/, '');
    const path = rawPath.replace(`/api/sessions/${SECOND_SESSION.id}/`, `/api/sessions/${SESSION.id}/`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, path: rawPath, body });
    const base = `/api/sessions/${SESSION.id}`;
    const gated = (name: string, response: () => Response) =>
      gates.get(name)?.then(response) ?? Promise.resolve(response());

    if (method === 'GET' && path === '/api/sessions') {
      // Taken when the request is made, so an answer a test holds back is as stale as one still in flight.
      const sessions: Session[] = [
        ...(mainDeleted ? [] : [mainDown ? { ...SESSION, status: 'disconnected' as const } : SESSION]),
        ...(listSecond ? [secondDown ? { ...SECOND_SESSION, status: 'disconnected' as const } : SECOND_SESSION] : []),
        ...(listOffline ? [offlineUp ? { ...OFFLINE_SESSION, status: 'ready' as const } : OFFLINE_SESSION] : []),
        ...(listCreated ? [listCreated] : []),
      ];
      return gated('sessions', () => jsonResponse(sessions));
    }
    if (method === 'GET' && path.startsWith(`${base}/chats?`)) {
      return gated('chats', () =>
        jsonResponse([
          { ...CHAT, ...aliceNow },
          ...(listGroup ? [GROUP] : []),
          ...(listExtra ? [PUSH_ONLY_CHAT, LID_CHAT, NUMBER_NAMED_CHAT] : []),
          ...Array.from({ length: extraLidChats }, (_, n) => extraLidChat(n)),
        ]),
      );
    }
    const groupPath = `${base}/groups/${encodeURIComponent(GROUP.id)}`;
    if (method === 'GET' && path === groupPath) {
      return Promise.resolve(
        jsonResponse({
          id: GROUP.id,
          name: groupName,
          description: groupDescription,
          locked: groupLocked,
          participants: [
            {
              id: ownHasDeviceSuffix ? `${SESSION.phone}:7@c.us` : `${SESSION.phone}@c.us`,
              number: ownHasDeviceSuffix ? `${SESSION.phone}:7` : SESSION.phone,
              isAdmin: groupAdmin,
              isSuperAdmin: false,
            },
            {
              id: '15550002222@c.us',
              number: '15550002222',
              ...(bobUnnamed ? {} : { name: 'Bob' }),
              isAdmin: bobIsAdmin,
              isSuperAdmin: false,
            },
            ...(groupHasLidMember
              ? [{ id: '262813461250071@lid', number: '262813461250071', isAdmin: false, isSuperAdmin: false }]
              : []),
          ],
        }),
      );
    }
    if (method === 'GET' && path === `${base}/contacts/blocked`) return Promise.resolve(jsonResponse(blockedIds));
    // Writes that answer an acknowledgement: chat state changes, clearing and deleting a chat, leaving a group
    // and the contact writes (block, unblock, save). A test can hold each back by its name.
    const writes: Array<[name: string, matches: boolean]> = [
      ['pin', method === 'POST' && path.endsWith('/chats/pin')],
      ['archive', method === 'POST' && path.endsWith('/chats/archive')],
      ['mute', method === 'POST' && path.endsWith('/chats/mute')],
      ['unread', method === 'POST' && path === `${base}/chats/unread`],
      ['deleteChat', method === 'POST' && path === `${base}/chats/delete`],
      ['clearChat', method === 'DELETE' && /\/chats\/[^/]+\/messages$/.test(path)],
      ['leave', method === 'POST' && path === `${groupPath}/leave`],
      ['block', method !== 'GET' && /\/contacts\/[^/]+\/block$/.test(path)],
      ['saveContact', method === 'PUT' && /\/contacts\/[^/]+$/.test(path)],
    ];
    const write = writes.find(([, matches]) => matches);
    if (write) {
      return gated(write[0], () => {
        // Nothing is left of Alice's thread once her chat is cleared or deleted.
        if (!declineWrites && (write[0] === 'clearChat' || write[0] === 'deleteChat')) aliceThread = [];
        return jsonResponse({ success: !declineWrites });
      });
    }
    if (path.startsWith(`${groupPath}/participants`)) {
      const { participants } = body as { participants: string[] };
      if (refuseMember === 'some') {
        return Promise.resolve(
          jsonResponse({
            success: true,
            message: 'ok',
            results: participants.map(id => ({ id, success: false, status: 403, message: 'not-authorized' })),
          }),
        );
      }
      if (refuseMember === 'all') {
        const op =
          path.split('/').pop() === 'participants' ? (method === 'POST' ? 'add' : 'remove') : path.split('/').pop();
        return Promise.resolve(
          jsonResponse(
            {
              statusCode: 403,
              message: `${op}Participants failed for all ${participants.length} participant(s) in group ${GROUP.id}: ${participants[0]} (403)`,
              error: 'Forbidden',
            },
            403,
          ),
        );
      }
      if (path.endsWith('/promote')) bobIsAdmin = true;
      if (path.endsWith('/demote')) bobIsAdmin = false;
      return Promise.resolve(
        jsonResponse({
          success: true,
          message: 'ok',
          results: participants.map(id => ({ id, success: true })),
        }),
      );
    }
    if (path.startsWith(`${groupPath}/`)) {
      if (method === 'PUT' && path.endsWith('/subject')) groupName = (body as { subject: string }).subject;
      if (method === 'PUT' && path.endsWith('/description'))
        groupDescription = (body as { description: string }).description;
      return Promise.resolve(jsonResponse({ success: true, message: 'ok' }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/profile-pictures`)) {
      const ids = decodeURIComponent(path.split('ids=')[1] ?? '')
        .split(',')
        .filter(Boolean);
      return Promise.resolve(
        jsonResponse({ pictures: Object.fromEntries(ids.map(id => [id, pictureFor[id] ?? null])) }),
      );
    }
    if (method === 'GET' && /\/contacts\/([^/]+)\/profile-picture$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/profile-picture')[0]);
      return Promise.resolve(jsonResponse({ url: pictureFor[id] ?? null }));
    }
    if (method === 'GET' && /\/contacts\/[^/]+\/phone$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/phone')[0]);
      if (throttlePhoneLookups) {
        const now = Date.now();
        while (phoneLookupTimes.length > 0 && now - phoneLookupTimes[0] >= 1000) phoneLookupTimes.shift();
        phoneLookupTimes.push(now);
        if (phoneLookupTimes.length > 10) return Promise.resolve(jsonResponse({ message: 'Too Many Requests' }, 429));
      }
      if (failLidPhones || failingLidIds.has(id)) return Promise.resolve(jsonResponse({ message: 'busy' }, 503));
      if (garbleLidPhones) return Promise.resolve(jsonResponse({ contactId: id, phone: 15550009999 }));
      return gated('phone', () => jsonResponse({ contactId: id, phone: lidPhones[id] ?? null }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/check/`)) {
      return gated('check', () =>
        numberNotRegistered
          ? jsonResponse({ number: '15550009999', exists: false, whatsappId: null })
          : jsonResponse({ exists: true, whatsappId: RESOLVED_ID }),
      );
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts?`)) {
      return gated('contacts', () =>
        failContacts
          ? jsonResponse({ message: 'busy' }, 503)
          : jsonResponse([
              ALICE_CONTACT,
              ...(listDuplicateContact ? [DUPLICATE_CONTACT] : []),
              CONTACT,
              ...(listExtra ? [PUSH_ONLY_CONTACT, NUMBER_NAMED_CONTACT] : []),
            ]),
      );
    }
    if (method === 'GET' && path.startsWith(`${base}/messages?`)) {
      // The gateway answers newest first.
      return gated('thread', () => jsonResponse({ messages: [...aliceThread].reverse(), total: aliceThread.length }));
    }
    if (method === 'GET' && /\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(jsonResponse([]));
    if (method === 'POST' && path === `${base}/chats/read`)
      return gated('read', () => jsonResponse({ success: !declineReads }));
    if (method === 'POST' && path === `${base}/groups`) {
      return gated('createGroup', () => jsonResponse({ id: GROUP_ID, name: (body as { name: string }).name }, 201));
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
  listSecond = false;
  secondDown = false;
  offlineUp = false;
  mainDown = false;
  mainDeleted = false;
  listCreated = null;
  listExtra = false;
  listDuplicateContact = false;
  failContacts = false;
  failLidPhones = false;
  failingLidIds.clear();
  garbleLidPhones = false;
  numberNotRegistered = false;
  throttlePhoneLookups = false;
  phoneLookupTimes.length = 0;
  extraLidChats = 0;
  for (const id of Object.keys(lidPhones)) delete lidPhones[id];
  for (const key of Object.keys(aliceNow)) delete aliceNow[key as keyof Chat];
  aliceThread = [];
  declineWrites = false;
  declineReads = false;
  for (const id of Object.keys(pictureFor)) delete pictureFor[id];
  gates.clear();
  listGroup = false;
  groupAdmin = true;
  groupName = GROUP.name;
  groupDescription = 'old description';
  bobIsAdmin = false;
  groupHasLidMember = false;
  bobUnnamed = false;
  groupLocked = true;
  ownHasDeviceSuffix = false;
  refuseMember = false;
  blockedIds = [];
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
});

/** Renders the page; `reactStrictMode` replays effect setup and cleanup as `main.tsx` does in development. */
function renderPage({ reactStrictMode = false } = {}): ReturnType<RTL['render']> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  queryClients.push(queryClient);
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
    { reactStrictMode },
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

test('the page and the open room keep a heading, and closing the panel returns focus to its toggle', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Chats' }), 'the page has no h1');
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(screen.getByRole('heading', { level: 2, name: 'Alice' }), 'the room has no heading'));

  const focusedName = () => document.activeElement?.getAttribute('aria-label');
  fireEvent.click(screen.getByRole('button', { name: 'Contact info' }));
  const panel = await waitFor(() => container.querySelector('.contact-info-panel') as HTMLElement);
  fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
  assert.ok(!container.querySelector('.contact-info-panel'), 'the close button left the panel open');
  assert.equal(focusedName(), 'Contact info', 'closing the panel dropped focus');

  fireEvent.click(screen.getByRole('button', { name: 'Contact info' }));
  await waitFor(() => assert.ok(container.querySelector('.contact-info-panel')));
  (container.querySelector('.contact-info-panel button') as HTMLElement).focus();
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(!container.querySelector('.contact-info-panel'), 'Escape left the panel open');
  assert.equal(focusedName(), 'Contact info', 'Escape dropped focus');
});

test('opening the contact panel takes focus to its close button, from the toggle and from the contact', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  const panel = () => container.querySelector('.contact-info-panel') as HTMLElement;
  // Below 1200px the panel covers the room, so focus left on the toggle would sit under it.
  const onClose = () => panel().contains(document.activeElement) && focusedName() === 'Close';

  const toggle = screen.getByRole('button', { name: 'Contact info' });
  toggle.focus();
  fireEvent.click(toggle);
  await waitFor(() => assert.ok(panel(), 'the panel did not open'));
  assert.equal(onClose(), true, `focus is on "${focusedName()}", not in the panel`);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(focusedName(), 'Contact info', 'Escape did not return focus to the toggle');

  fireEvent.click(container.querySelector('.room-contact') as HTMLElement);
  await waitFor(() => assert.ok(panel(), 'the panel did not open from the contact'));
  assert.equal(onClose(), true, `focus is on "${focusedName()}", not in the panel`);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Close' }));
  assert.equal(focusedName(), 'Contact info', 'closing the panel did not return focus to the toggle');
});

test("a group's panel is its group info, not contact info", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listGroup = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Team'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  assert.ok(!screen.queryByRole('button', { name: 'Contact info' }), 'a group offers contact info');
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));
  assert.ok(await screen.findByRole('complementary', { name: 'Group info' }), 'the group panel is not named for it');
});

test('the contact panel isolates the chat id left to right, so an RTL page keeps "@c.us" at its end', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  fireEvent.click(within(container.querySelector('.room-header') as HTMLElement).getByText('Alice'));
  const panel = await waitFor(() => container.querySelector('.contact-info-panel') as HTMLElement);

  const id = within(panel).getByText(CHAT.id);
  assert.equal(id.tagName, 'BDI');
  assert.equal(id.getAttribute('dir'), 'ltr');
});

test('the contact panel closes with its room: on closing it, on opening another chat and on a session switch', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  listSecond = true;
  const { container } = renderPage();
  const panel = () => container.querySelector('.contact-info-panel');
  const openAliceWithPanel = async () => {
    fireEvent.click(within(container.querySelector('.chats-sidebar') as HTMLElement).getByText('Alice'));
    await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
    fireEvent.click(within(container.querySelector('.room-header') as HTMLElement).getByText('Alice'));
    await waitFor(() => assert.ok(panel(), 'the panel did not open'));
  };
  await screen.findByText('Alice');

  // Closing the room closes the panel, and the chat opened again comes without it.
  await openAliceWithPanel();
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
  await waitFor(() => assert.equal(container.querySelector('.room-header'), null, 'the room stayed open'));
  fireEvent.click(within(container.querySelector('.chats-sidebar') as HTMLElement).getByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open again'));
  assert.equal(panel(), null, 'the chat opened again with the panel of its last visit');

  // Another chat opens without it.
  await openAliceWithPanel();
  fireEvent.click(within(container.querySelector('.chats-sidebar') as HTMLElement).getByText('Team'));
  await waitFor(() => assert.equal(container.querySelector('.room-header .room-contact-name')?.textContent, 'Team'));
  assert.equal(panel(), null, 'the next chat opened with the panel of the last one');

  // A session switch closes it too, and the same chat on the other account opens without it.
  await openAliceWithPanel();
  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  assert.equal(panel(), null, 'the panel stayed open across the session switch');
  fireEvent.click(await within(container.querySelector('.chats-sidebar') as HTMLElement).findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  assert.equal(panel(), null, 'the chat on the other session opened with the panel');
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

test('a contact the engine lists twice under one id is offered once, and found by its phone number', async () => {
  const { screen, fireEvent } = rtl;
  listDuplicateContact = true;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByRole('button', { name: /Bob/ });
  assert.equal(screen.getAllByRole('button', { name: /Bob/ }).length, 1, 'Bob was listed twice');

  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: CONTACT.number },
  });
  assert.equal(screen.getAllByRole('button', { name: /Bob/ }).length, 1, 'Bob was not found by his phone number');
});

test('the New chat search matches a number only for a query that reads as one', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByRole('button', { name: /Bob/ });
  const search = screen.getByLabelText('Search name or number with country code');

  // Bob's number holds a 2, which is no part of the name searched for.
  fireEvent.change(search, { target: { value: 'Alice 2' } });
  assert.equal(screen.queryAllByRole('button', { name: /Bob/ }).length, 0, 'a digit in a name matched a number');
  assert.ok(screen.getByText('No contacts found'));
  fireEvent.change(search, { target: { value: '+1 555-000.2222' } });
  assert.equal(screen.getAllByRole('button', { name: /Bob/ }).length, 1, 'Bob was not found by his number');
  assert.ok(screen.getByRole('button', { name: /^Start chat with/ }), 'the typed number is not offered');
});

for (const reactStrictMode of [false, true]) {
  test(`a typed number is checked with the gateway and opens a chat under the id it resolves to${reactStrictMode ? ' (StrictMode)' : ''}`, async () => {
    const { screen, fireEvent, waitFor, within } = rtl;
    const { container } = renderPage({ reactStrictMode });
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
    await within(container.querySelector('.room-header') as HTMLElement).findByText('+1 555 000 9999');
    assert.ok(!container.querySelector('.new-chat-panel'), 'the panel stayed open over the list');
  });
}

test('the New chat search clear button returns focus to the field it cleared', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  const field = screen.getByLabelText('Search name or number with country code') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'Bo' } });
  const clear = screen.getByRole('button', { name: 'Clear search' });
  // A keyboard user reaches the button with Tab and presses Enter on it; the button then leaves the page.
  clear.focus();
  fireEvent.click(clear);

  assert.equal(field.value, '');
  assert.ok(!screen.queryByRole('button', { name: 'Clear search' }), 'the clear button stayed');
  assert.equal(document.activeElement === field, true, `focus is on "${focusedName()}", not on the field`);
});

test('the chat list search clear button returns focus to the field it cleared', async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  const field = container.querySelector('.chat-search-input input') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'Ali' } });
  const clear = screen.getByRole('button', { name: 'Clear search' });
  clear.focus();
  fireEvent.click(clear);

  assert.equal(field.value, '');
  assert.ok(!screen.queryByRole('button', { name: 'Clear search' }), 'the clear button stayed');
  assert.equal(document.activeElement === field, true, `focus is on "${focusedName()}", not on the field`);
});

// A number in a title is isolated left to right, so a right-to-left page keeps its digit groups in order.
const isolated = (number: string) => `${String.fromCodePoint(0x2066)}${number}${String.fromCodePoint(0x2069)}`;

test('an unnamed chat is titled by its number on its row, in its menu, its dialogs and its reply banner', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceNow.name = '';
  aliceThread = [threadRow(1)];
  const { container } = renderPage();
  const number = isolated('+1 555 000 1111');
  await screen.findByText(number);
  assert.equal(container.querySelector('.chat-item-name')?.textContent, number, 'the row shows the bare digits');

  fireEvent.click(screen.getByRole('button', { name: `Actions for ${number}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog', { name: `Mute "${number}"` })));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  fireEvent.click(screen.getByText(number));
  await screen.findByText('message 1');
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  await waitFor(() =>
    assert.equal(container.querySelector('.replying-to-title')?.textContent, `Replying to ${number}`),
  );
});

test('an unnamed privacy-id chat keeps the digits of its id on its row and in its menu, never formatted', async () => {
  const { screen } = rtl;
  Object.assign(aliceNow, { id: '262813461250073@lid', name: '' });
  renderPage();
  await screen.findByText('262813461250073');
  assert.ok(screen.getByRole('button', { name: 'Actions for 262813461250073' }));
});

test('an unnamed chat is titled by its number, formatted and isolated left to right, in the header and the panel', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  aliceNow.name = '';
  const { container } = renderPage();
  fireEvent.click(await screen.findByText(isolated('+1 555 000 1111')));
  const title = await waitFor(() => {
    const name = container.querySelector('.room-header .room-contact-name') as HTMLElement;
    assert.equal(name?.textContent, '+1 555 000 1111');
    return name;
  });
  assert.equal(title.querySelector('bdi')?.getAttribute('dir'), 'ltr', 'the number in the title is not isolated');
  assert.equal(container.querySelector('.room-header .room-contact-phone') === null, true, 'the number is shown twice');
  assert.ok(screen.getByRole('heading', { level: 2, name: '+1 555 000 1111' }), 'the room heading is not the number');

  fireEvent.click(screen.getByRole('button', { name: 'Contact info' }));
  const panel = await waitFor(() => container.querySelector('.contact-info-panel') as HTMLElement);
  const heading = within(panel).getByRole('heading', { level: 3 });
  assert.equal(heading.textContent, '+1 555 000 1111');
  assert.equal(heading.querySelector('bdi')?.getAttribute('dir'), 'ltr', 'the number in the panel is not isolated');
  assert.equal(panel.querySelector('.contact-info-sub') === null, true, 'the panel repeats the number under itself');
});

test('an unnamed privacy-id chat is titled by the number it resolves to, and its own digits are never formatted', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const lid = '262813461250072@lid';
  Object.assign(aliceNow, { id: lid, name: '' });
  const title = () => container.querySelector('.room-header .room-contact-name')?.textContent;

  // Unresolved, it keeps the digits of its id as they are: they are no phone number.
  let { container } = renderPage();
  fireEvent.click(await screen.findByText('262813461250072'));
  await waitFor(() => assert.equal(phoneRequests().length, 1, 'the privacy id was not looked up'));
  await settle();
  assert.equal(title(), '262813461250072');
  rtl.cleanup();

  lidPhones[lid] = '15550006666';
  ({ container } = renderPage());
  fireEvent.click(await screen.findByText('262813461250072'));
  await waitFor(() => assert.equal(title(), '+1 555 000 6666'));
});

// ── The number check answers a phone id, while a contact that moved to privacy-id addressing keeps its conversation
// under its @lid: starting a chat with that number has to find it. ──

const phoneRequests = () =>
  fetchCalls.filter(c => c.method === 'GET' && /\/contacts\/[^/]+\/phone$/.test(c.path)).map(c => c.path);

/** Type the number the new chat tests use into the panel and press Start chat. */
async function startChatWithTypedNumber(): Promise<void> {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  fireEvent.click(await screen.findByRole('button', { name: /^Start chat with/ }));
}

const listedChatCards = (container: HTMLElement) => container.querySelectorAll('.chats-list .chat-item-card').length;

test('a typed number whose chat the list holds under a privacy id opens that chat, not a new one', async () => {
  const { screen, waitFor, within } = rtl;
  listExtra = true;
  lidPhones[LID_CHAT.id] = '15550009999';
  const { container } = renderPage();
  await screen.findByText('Lia');
  const before = listedChatCards(container);
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Lia');
  assert.equal(listedChatCards(container), before, 'a second chat was added beside the one the list holds');
  assert.equal(
    phoneRequests().filter(path => path.includes(encodeURIComponent(LID_CHAT.id))).length,
    1,
    'the engine was asked about the privacy id more than once',
  );
});

test('a privacy-id chat of another phone is not mistaken for the number, which opens a new chat', async () => {
  const { screen, waitFor, within } = rtl;
  listExtra = true;
  lidPhones[LID_CHAT.id] = '15550007777';
  const { container } = renderPage();
  await screen.findByText('Lia');
  const before = listedChatCards(container);
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('+1 555 000 9999');
  assert.equal(listedChatCards(container), before + 1, 'the new chat was not added to the list');
});

test('a privacy id the engine cannot resolve right now does not stop a chat from opening', async () => {
  const { screen, waitFor, within } = rtl;
  listExtra = true;
  failLidPhones = true;
  const { container } = renderPage();
  await screen.findByText('Lia');
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('+1 555 000 9999');
  assert.ok(!screen.queryByText('Could not check the number'), 'a failed lookup was shown as a failed number check');
});

test('one privacy id whose lookup fails does not hide the chat another privacy id holds', async () => {
  const { screen, waitFor } = rtl;
  extraLidChats = 2;
  // The newer chat's lookup answers 503 while the older one resolves to the typed number.
  failingLidIds.add(extraLidChat(0).id);
  lidPhones[extraLidChat(1).id] = '15550009999';
  const { container } = renderPage();
  await screen.findByText('Lid 0');
  const before = listedChatCards(container);
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  assert.equal(container.querySelector('.room-header .room-contact-name')?.textContent, 'Lid 1');
  assert.equal(listedChatCards(container), before, 'a second chat was added beside the one the list holds');
});

test('an answer about a privacy id that the page cannot read does not stop a chat from opening', async () => {
  const { screen, waitFor, within } = rtl;
  listExtra = true;
  garbleLidPhones = true;
  const { container } = renderPage();
  await screen.findByText('Lia');
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('+1 555 000 9999');
  assert.ok(!screen.queryByText('Could not check the number'), 'a failed lookup was shown as a failed number check');
});

// The address book lists a contact under its phone id, as both engines answer it, while the list keeps the
// conversation of a contact that moved to privacy-id addressing under its @lid. Picking the contact opens that
// conversation, as typing its number does, and the replies that arrive under the @lid are in the room on screen.

/** Open the New chat panel and pick a contact by the start of its row's name. */
async function pickContact(container: HTMLElement, name: string): Promise<void> {
  const { screen, fireEvent, within } = rtl;
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  const panel = container.querySelector('.new-chat-panel') as HTMLElement;
  fireEvent.click(await within(panel).findByRole('button', { name: new RegExp(`^${name}`) }));
}

test('a saved contact whose conversation the list holds under a privacy id opens that conversation', async () => {
  const { screen, waitFor, within } = rtl;
  listExtra = true;
  lidPhones[LID_CHAT.id] = CONTACT.number;
  const { container } = renderPage();
  await screen.findByText('Lia');
  const before = listedChatCards(container);
  await pickContact(container, 'Bob');

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Lia');
  assert.equal(listedChatCards(container), before, 'a second chat was added beside the one the list holds');

  // The reply comes under the id the conversation is kept under.
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_002_000_000).toISOString(),
    payload: {
      event: 'message.received',
      sessionId: SESSION.id,
      data: {
        id: 'wamid.lia.reply',
        chatId: LID_CHAT.id,
        from: LID_CHAT.id,
        to: 'me',
        body: 'reply under the lid',
        type: 'text',
        fromMe: false,
        timestamp: 1_700_001_700,
      },
    },
  });
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('reply under the lid');
});

test('a saved contact with no conversation in the list opens its own chat, also when a lookup fails', async () => {
  const { screen, waitFor, within } = rtl;
  listExtra = true;
  failLidPhones = true;
  const { container } = renderPage();
  await screen.findByText('Lia');
  await pickContact(container, 'Bob');

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Bob');
});

test('while a contact is looked up the panel takes no other pick, and the contact picked opens', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listExtra = true;
  lidPhones[LID_CHAT.id] = CONTACT.number;
  const release = hold('phone');
  const { container } = renderPage();
  await screen.findByText('Lia');
  await pickContact(container, 'Bob');

  const panel = container.querySelector('.new-chat-panel') as HTMLElement;
  const bob = within(panel).getByRole('button', { name: /^Bob/ });
  const alice = within(panel).getByRole('button', { name: /^Alice/ });
  await waitFor(() => assert.equal(bob.getAttribute('aria-busy'), 'true', 'the contact being looked up shows no sign'));
  assert.equal(alice.matches(':disabled'), true, 'another contact can be picked during the lookup');
  fireEvent.click(alice);
  assert.ok(!container.querySelector('.room-header'), 'a second pick opened a chat during the lookup');
  // A group form opened now would be thrown away by the chat the lookup opens.
  const newGroup = within(panel).getByRole('button', { name: 'New group' });
  assert.equal(newGroup.matches(':disabled'), true, 'New group can be picked during the lookup');
  fireEvent.click(newGroup);
  assert.equal(
    within(panel).queryByLabelText('Search participants or enter a number') === null,
    true,
    'the group form opened',
  );

  release();
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Lia');
});

// A chat opened once a lookup answers commits outside any user event, so effects that run after its commit can land a
// task later, after the browser drew the room and after a send bound to that render could run. The composer swaps in
// the opened chat's draft before then: the room is never drawn with the text typed in the chat before it.
test('a chat opened after a lookup is drawn with its own draft, not the text typed in the chat before it', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listExtra = true;
  lidPhones[LID_CHAT.id] = CONTACT.number;
  const { container } = renderPage();
  await screen.findByText('Lia');
  fireEvent.click(within(container.querySelector('.chats-sidebar') as HTMLElement).getByText('Alice'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
  const composerSelector = 'input[placeholder="Type a message..."]';
  fireEvent.change(container.querySelector(composerSelector) as HTMLInputElement, { target: { value: 'for alice' } });

  // A mutation callback runs as a microtask, so it reads the page as the commit that drew Lia's room left it.
  let drawnWith: string | null | undefined;
  const observer = new MutationObserver(() => {
    if (drawnWith !== undefined || !container.querySelector('.room-header')?.textContent?.includes('Lia')) return;
    drawnWith = container.querySelector<HTMLInputElement>(composerSelector)?.value ?? null;
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  try {
    await pickContact(container, 'Bob');
    await waitFor(() => assert.notEqual(drawnWith, undefined, 'the chat did not open'));
  } finally {
    observer.disconnect();
  }
  assert.equal(drawnWith, '', 'the room was drawn with the draft of the chat open before it');
});

// ── A phone number inside a sentence is placed in a left-to-right isolate: its plus sign and spaces are neutral to
// the bidi algorithm, so in a right-to-left sentence the digit groups would be shown in reverse order. ──

const LTR_NUMBER = `${String.fromCodePoint(0x2066)}+1 555 000 9999${String.fromCodePoint(0x2069)}`;

test('the typed number keeps its digit groups together in the start chat label', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  const start = await screen.findByRole('button', { name: /^Start chat with/ });
  assert.equal(start.textContent?.includes(LTR_NUMBER), true, `the label is not isolated: "${start.textContent}"`);
});

test('the typed number keeps its digit groups together in the add to group label', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));
  fireEvent.change(screen.getByLabelText('Search participants or enter a number'), { target: { value: TYPED_NUMBER } });
  const add = await screen.findByRole('button', { name: /^Add \S/ });
  assert.equal(add.textContent?.includes(LTR_NUMBER), true, `the label is not isolated: "${add.textContent}"`);
});

test('the number a check finds unregistered is named inside an isolate in the panel toast', async () => {
  const { screen, fireEvent } = rtl;
  numberNotRegistered = true;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  fireEvent.click(await screen.findByRole('button', { name: /^Start chat with/ }));
  const toast = await screen.findByText(/is not registered on WhatsApp/);
  assert.equal(toast.textContent?.includes(LTR_NUMBER), true, `the toast is not isolated: "${toast.textContent}"`);
});

// A member with no name is named by a phone, in the member's own button labels and in the remove confirmation.
const LTR_BOB = `${String.fromCodePoint(0x2066)}+1 555 000 2222${String.fromCodePoint(0x2069)}`;

test('an unnamed member is named inside an isolate in the group dialog button labels', async () => {
  const { fireEvent, within } = rtl;
  listGroup = true;
  bobUnnamed = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  assert.ok(within(dialog).getByRole('button', { name: `Remove: ${LTR_BOB}` }), 'the remove label is not isolated');
  assert.ok(within(dialog).getByRole('button', { name: `Make admin: ${LTR_BOB}` }), 'the admin label is not isolated');
});

test('the remove confirmation names an unnamed member inside an isolate', async () => {
  const { fireEvent, within } = rtl;
  listGroup = true;
  bobUnnamed = true;
  const confirm = window.confirm;
  try {
    renderPage();
    const dialog = await openGroupInfo();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
    let asked = '';
    window.confirm = message => {
      asked = String(message);
      return false;
    };
    fireEvent.click(within(dialog).getByRole('button', { name: /^Remove: / }));
    assert.equal(asked, `Remove ${LTR_BOB} from the group?`);
  } finally {
    window.confirm = confirm;
  }
});

test('the number a check finds unregistered is named inside an isolate when adding to a group', async () => {
  const { screen, fireEvent, within } = rtl;
  listGroup = true;
  numberNotRegistered = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  fireEvent.change(within(dialog).getByLabelText('Add a number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
  const toast = await screen.findByText(/is not registered on WhatsApp/);
  assert.equal(toast.textContent?.includes(LTR_NUMBER), true, `the toast is not isolated: "${toast.textContent}"`);
});

test('only the newest privacy-id chats are asked about, not every one the list holds', async () => {
  const { screen, waitFor } = rtl;
  extraLidChats = 60;
  const { container } = renderPage();
  await screen.findByText('Lid 0');
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'), { timeout: 8000 });
  assert.equal(phoneRequests().length, 30, 'the newest 30 privacy ids, no more and no fewer, were asked about');
});

test('privacy ids are asked about at a pace the gateway accepts, and the search ends at the match', async () => {
  const { screen, waitFor } = rtl;
  extraLidChats = 40;
  throttlePhoneLookups = true;
  // The thirteenth newest holds the number: it is asked about in the third group of five, after ten requests.
  lidPhones[extraLidChat(12).id] = '15550009999';
  const { container } = renderPage();
  await screen.findByText('Lid 0');
  const before = listedChatCards(container);
  await startChatWithTypedNumber();

  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'), { timeout: 8000 });
  assert.equal(container.querySelector('.room-header .room-contact-name')?.textContent, 'Lid 12');
  assert.equal(listedChatCards(container), before, 'a second chat was added beside the one the list holds');
  assert.equal(phoneRequests().length, 15, 'ids after the match were asked about, or a group was asked twice');
});

test('privacy ids the page already holds answers for are kept for a day and neither asked again nor waited for', async () => {
  const { screen, waitFor } = rtl;
  extraLidChats = 10;
  const { container } = renderPage();
  await screen.findByText('Lid 0');
  const { resolvedPhoneQuery } = await import('../hooks/useResolvedPhone.ts');
  const client = queryClients[0];
  for (let n = 0; n < extraLidChats; n++) await client.fetchQuery(resolvedPhoneQuery(SESSION.id, extraLidChat(n).id));
  const held = client.getQueryCache().find({ queryKey: ['resolvedPhone', SESSION.id, extraLidChat(0).id] });
  assert.equal(held?.gcTime, 24 * 60 * 60 * 1000, 'an answer nothing observes would be collected after minutes');
  fetchCalls.length = 0;
  await startChatWithTypedNumber();

  // Two groups of five that reached the gateway would be a second apart.
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open in time'), {
    timeout: 800,
  });
  assert.equal(phoneRequests().length, 0, 'an answer the page holds was asked for again');
});

for (const reactStrictMode of [false, true]) {
  test(`a group is created with the picked contacts on Baileys, and whatsapp-web.js is not offered one${reactStrictMode ? ' (StrictMode)' : ''}`, async () => {
    const { screen, fireEvent, waitFor, within } = rtl;
    const { container } = renderPage({ reactStrictMode });
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
    renderPage({ reactStrictMode });
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await screen.findByText('Bob');
    assert.ok(
      !screen.queryByRole('button', { name: 'New group' }),
      'whatsapp-web.js, which answers 501, offered a group',
    );
  });
}

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

test('the session switcher gives the whole number of each session in its title, for a list column that cuts it', async () => {
  const { screen, fireEvent } = rtl;
  listOffline = true;
  const { container } = renderPage();
  await screen.findByText('Alice');
  const titleIn = (scope: Element | null) => scope?.querySelector('.session-phone-line bdi')?.getAttribute('title');
  assert.equal(titleIn(container.querySelector('.session-switcher-btn')), '+1 555 123 4567');
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  assert.deepEqual(
    screen.getAllByRole('option').map(option => titleIn(option)),
    ['+1 555 123 4567', '+49 174 156 5212'],
  );
});

test('the session switcher matches a number only for a query that reads as one, and a name with a digit by name', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  listOffline = true;
  listCreated = { ...CREATED_SESSION, name: 'Support 2' };
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const search = screen.getByLabelText('Search sessions...');
  const shown = () => screen.queryAllByRole('option').map(option => option.querySelector('.session-name')?.textContent);
  await waitFor(() => assert.equal(shown().length, 4));

  // Main and Marie Haas have a 2 in their number, which is no part of the name searched for.
  fireEvent.change(search, { target: { value: 'Support 2' } });
  assert.deepEqual(shown(), ['Support 2']);
  fireEvent.change(search, { target: { value: '+1 (555) 987-65' } });
  assert.deepEqual(shown(), [SECOND_SESSION.name]);
});

test('the session switcher follows live session status: a session that connects can be picked, one that drops cannot', async () => {
  const { screen, fireEvent, act } = rtl;
  listOffline = true;
  listSecond = true;
  renderPage();
  await screen.findByText('Alice');
  const pushStatus = (sessionId: string, status: string) =>
    act(() => {
      lastSocket()?.receive('message', {
        type: 'event',
        timestamp: new Date(1_700_003_000_000).toISOString(),
        payload: { event: 'session.status', sessionId, data: { status } },
      });
    });
  const disabledOf = (name: string) =>
    (screen.getAllByRole('option').find(option => option.textContent?.includes(name)) as HTMLButtonElement).disabled;

  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  assert.deepEqual([disabledOf('Main'), disabledOf('Second'), disabledOf('Marie Haas')], [false, false, true]);

  pushStatus(OFFLINE_SESSION.id, 'ready');
  pushStatus(SECOND_SESSION.id, 'disconnected');
  assert.equal(disabledOf('Marie Haas'), false, 'a session that connected stayed unpickable');
  assert.equal(disabledOf('Second'), true, 'a session that dropped could still be picked');

  // The open session stays selected when it drops; the switcher shows its state.
  pushStatus(SESSION.id, 'disconnected');
  assert.ok(screen.getByRole('button', { name: /Main/ }), 'the open session left the switcher');
});

/** Pushes a session.status frame over the socket, as the gateway does on the session feed. */
const pushSessionStatus = (sessionId: string, status: string) =>
  rtl.act(() => {
    lastSocket()?.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_003_000_000).toISOString(),
      payload: { event: 'session.status', sessionId, data: { status } },
    });
  });

test('with every session down at load, the first one that connects is selected and its chats load', async () => {
  const { screen, waitFor } = rtl;
  mainDown = true;
  listOffline = true;
  const { container } = renderPage();
  await screen.findByText('No connected sessions');
  assert.ok(!screen.queryByText('Alice'), 'a chat list loaded for a session that is down');

  pushSessionStatus(SESSION.id, 'ready');
  await waitFor(() => assert.equal(selectedSessionName(container), SESSION.name));
  await screen.findByText('Alice');

  // A second session that connects later does not take the selection from the first.
  pushSessionStatus(OFFLINE_SESSION.id, 'ready');
  await settle();
  assert.equal(selectedSessionName(container), SESSION.name, 'the selection moved to the session that connected next');
});

test('a status that lands with the session list, before the list has rendered, is applied to that list', async () => {
  const { screen, waitFor, act } = rtl;
  mainDown = true;
  listOffline = true;
  const release = hold('sessions');
  const { container } = renderPage();
  // The list answer and the status land in one turn, so the status is handled before React renders the list:
  // it must still find Main listed, not take it for an unknown session (whose re-read, still down here, would
  // leave nothing selected).
  await act(async () => {
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    lastSocket()?.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_003_000_000).toISOString(),
      payload: { event: 'session.status', sessionId: SESSION.id, data: { status: 'ready' } },
    });
  });
  await waitFor(() => assert.equal(selectedSessionName(container), SESSION.name));
  await screen.findByText('Alice');
});

test('a session created after the page loaded joins the switcher, and can be picked once it connects', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  const sessionReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  assert.equal(sessionReads(), 1);

  // A session still pairing has no number yet.
  listCreated = { ...CREATED_SESSION, phone: null };
  pushSessionStatus(CREATED_SESSION.id, 'qr_ready');
  await waitFor(() => assert.equal(sessionReads(), 2, 'a status for an unknown session did not read the list again'));
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const option = () => screen.getAllByRole('option').find(o => o.textContent?.includes(CREATED_SESSION.name));
  await waitFor(() => assert.ok(option(), 'the new session is not in the switcher'));
  assert.equal((option() as HTMLButtonElement).disabled, true, 'a session still pairing can be picked');
  assert.ok(option()?.textContent?.includes('No phone'));

  // Known now, so a status short of ready is applied from the feed alone.
  pushSessionStatus(CREATED_SESSION.id, 'authenticating');
  await settle();
  assert.equal(sessionReads(), 2, 'a status short of ready for a listed session read the list again');

  // Once it connects it can be picked at once, and the list is read again for the number it now has.
  listCreated = { ...CREATED_SESSION, status: 'ready' };
  pushSessionStatus(CREATED_SESSION.id, 'ready');
  assert.equal((option() as HTMLButtonElement).disabled, false, 'the new session stayed unpickable once it connected');
  await waitFor(() => assert.equal(sessionReads(), 3, 'a session that connected was not read again'));
  await waitFor(() =>
    assert.ok(!option()?.textContent?.includes('No phone'), 'the number it connected with is missing'),
  );
  assert.equal(selectedSessionName(container), SESSION.name, 'the open session changed');
});

test('a socket reconnect reads the session list again, so a session that connected during the gap can be picked', async () => {
  const { screen, fireEvent, waitFor, act } = rtl;
  listOffline = true;
  const { container } = renderPage();
  await screen.findByText('Alice');
  const sessionReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  const reads = sessionReads();

  // Its status frame was sent while the socket was down.
  offlineUp = true;
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await waitFor(() => assert.equal(sessionReads(), reads + 1, 'the reconnect did not read the session list'));

  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const marie = () =>
    screen.getAllByRole('option').find(o => o.textContent?.includes('Marie Haas')) as HTMLButtonElement;
  await waitFor(() =>
    assert.equal(marie().disabled, false, 'the session that connected during the gap stayed unpickable'),
  );
});

test('a status that lands while the session list is being read is not undone by that read', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const { container } = renderPage();
  await screen.findByText('Alice');
  const sessionReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;

  // A new session starts a read, answered with the list as it stood then.
  const release = hold('sessions');
  listCreated = CREATED_SESSION;
  pushSessionStatus(CREATED_SESSION.id, 'qr_ready');
  await waitFor(() => assert.equal(sessionReads(), 2));
  // The second session drops while that answer is out.
  secondDown = true;
  pushSessionStatus(SECOND_SESSION.id, 'disconnected');
  release();

  await waitFor(() => assert.equal(sessionReads(), 3, 'the status that landed during the read did not read again'));
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const second = () => screen.getAllByRole('option').find(o => o.textContent?.includes('Second')) as HTMLButtonElement;
  await waitFor(() => assert.ok(second()));
  await settle();
  assert.equal(second().disabled, true, 'the older answer made the session that dropped pickable again');
});

test('an open session deleted on the server gives way to the first ready one, and its chat goes with it', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  // A status for a session the page does not know reads the list again, which no longer holds the open one.
  mainDeleted = true;
  listCreated = CREATED_SESSION;
  pushSessionStatus(CREATED_SESSION.id, 'qr_ready');
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  assert.equal(container.querySelector('.room-header') === null, true, "the deleted session's chat stayed open");
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Contact info' }));
  await waitFor(() => assert.ok(container.querySelector('.contact-info-panel'), 'the next session is not usable'));
});

test('an open session deleted on the server with no other one ready leaves none selected and closes its dialogs', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog'), 'the mute dialog did not open'));

  mainDeleted = true;
  listCreated = CREATED_SESSION;
  pushSessionStatus(CREATED_SESSION.id, 'qr_ready');
  await screen.findByText('No connected sessions');
  assert.equal(screen.queryByRole('dialog') === null, true, "the deleted session's mute dialog stayed open");
  assert.equal(container.querySelector('.session-switcher') === null, true);
});

test('an open session deleted with no status frame gives way once the page is shown again', async () => {
  const { screen, fireEvent, waitFor, act } = rtl;
  listSecond = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  const sessionReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  const reads = sessionReads();
  const visibilityChanged = () => act(() => void document.dispatchEvent(new window.Event('visibilitychange')));

  // Deleted from another tab while this one was hidden: a session that was not running sends no frame at all.
  setTabHidden(true);
  try {
    visibilityChanged();
    mainDeleted = true;
    assert.equal(sessionReads(), reads, 'a hidden page read the session list');
  } finally {
    setTabHidden(false);
  }
  visibilityChanged();
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  assert.equal(sessionReads(), reads + 1, 'showing the page did not read the session list once');
  assert.equal(container.querySelector('.room-header') === null, true, "the deleted session's chat stayed open");
});

test('the session list read at load does not undo a newer list a status frame read before it answered', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listOffline = true;
  const sessionReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  // The read at load is taken with the second account down, and held back.
  const release = hold('sessions');
  const { container } = renderPage();
  await waitFor(() => assert.equal(sessionReads(), 1));
  gates.delete('sessions');

  // The account connects, which the page does not know yet: the list is read again and answers at once.
  offlineUp = true;
  pushSessionStatus(OFFLINE_SESSION.id, 'ready');
  await waitFor(() => assert.equal(sessionReads(), 2));
  await settle();
  release();

  await screen.findByText('Alice');
  await settle();
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const marie = screen.getAllByRole('option').find(o => o.textContent?.includes('Marie Haas')) as HTMLButtonElement;
  assert.equal(marie.disabled, false, 'the answer from before the status made the connected session unpickable');
});

test('the session switcher links to pairing another number only for a key that may create a session', async () => {
  const { screen, fireEvent } = rtl;
  const { MemoryRouter } = await import('react-router-dom');
  const renderInRouter = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    queryClients.push(queryClient);
    return rtl.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
        ),
      ),
    );
  };

  renderInRouter();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  assert.ok(screen.getByText('Pair another number'), 'an unscoped operator key got no pairing link');
  rtl.cleanup();

  // A session-scoped key is refused on the create route, so the link would end on a page with nothing to do.
  window.sessionStorage.setItem('openwa_key_scoped', 'true');
  try {
    renderInRouter();
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: /Main/ }));
    assert.ok(!screen.queryByText('Pair another number'), 'a session-scoped key got a pairing link');
  } finally {
    window.sessionStorage.removeItem('openwa_key_scoped');
  }
});

test('focus leaving the session switcher closes it, and a blur with no target does not', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: /Main/ }));
  const search = screen.getByLabelText('Search sessions...');

  fireEvent.focusOut(search, { relatedTarget: screen.getAllByRole('option')[0] });
  assert.ok(screen.queryByRole('listbox'), 'moving into the list closed the switcher');
  // What Safari reports for a click on an option, which does not focus it.
  fireEvent.focusOut(search, { relatedTarget: null });
  assert.ok(screen.queryByRole('listbox'), 'a blur with no target closed the switcher under the click');
  fireEvent.focusOut(search, { relatedTarget: screen.getByRole('button', { name: 'Actions for Alice' }) });
  assert.ok(!screen.queryByRole('listbox'), 'focus left the switcher and it stayed open');
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

/** Open Group info for Team and wait until the group has loaded, which the badge naming the account's standing says. */
async function openGroupInfo(badge = `Managed via ${SESSION.name}`): Promise<HTMLElement> {
  const { screen, within } = rtl;
  await screen.findByText('Team');
  pickRowAction('Team', 'Group info');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(badge);
  return dialog;
}

test('unsaved group edits survive a member action that reloads the group', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Typed' } });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await waitFor(() => within(dialog).getByRole('button', { name: 'Remove admin: Bob' }));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Info' }));
  assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Typed');
  assert.equal((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled, false);
  assert.ok(screen.getByRole('dialog'));
});

test('a group field that was not edited follows the group when it is loaded again', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Typed' } });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  groupDescription = 'changed by another admin';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await waitFor(() => within(dialog).getByRole('button', { name: 'Remove admin: Bob' }));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Info' }));
  assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Typed');
  assert.equal((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value, 'changed by another admin');
});

test('Refresh in the group dialog drops the draft and shows the group as it is', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Typed' } });
  groupName = 'Team Renamed Elsewhere';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
  await waitFor(() =>
    assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Renamed Elsewhere'),
  );
});

test('a saved group edit leaves the form reading the saved group, with nothing left to save', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Nord' } });
  fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'new description' } });
  const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
  fireEvent.click(save);
  await waitFor(() => assert.equal(groupName, 'Team Nord'));
  await waitFor(() => assert.equal(save.disabled, true, 'the saved group still reads as changed'));
  assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Nord');
  assert.equal((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value, 'new description');
});

test('a group picture saved in the group dialog replaces the one on the sidebar row', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const objectUrls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => 'blob:picked';
  URL.revokeObjectURL = () => undefined;
  try {
    listGroup = true;
    pictureFor[GROUP.id] = 'https://cdn.example/old.jpg';
    const { container } = renderPage();
    await screen.findByText('Team');
    const rowPicture = () =>
      within(container.querySelector('.chats-list') as HTMLElement)
        .getByText('Team')
        .closest('.chat-item-card')
        ?.querySelector('img')
        ?.getAttribute('src');
    await waitFor(() => assert.equal(rowPicture(), 'https://cdn.example/old.jpg'));

    pickRowAction('Team', 'Group info');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(`Managed via ${SESSION.name}`);
    const file = new (window as unknown as { File: typeof File }).File(['x'], 'team.png', { type: 'image/png' });
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(save.disabled, false, 'the picked picture was not taken'));

    pictureFor[GROUP.id] = 'https://cdn.example/new.jpg';
    fireEvent.click(save);
    await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PUT' && c.path.endsWith('/picture'))));
    await waitFor(() => assert.equal(rowPicture(), 'https://cdn.example/new.jpg', 'the row kept the old picture'));
    // The dialog's own picture follows too, once the draft is gone.
    await waitFor(() =>
      assert.equal(
        dialog.querySelector('.group-info-picture img')?.getAttribute('src'),
        'https://cdn.example/new.jpg',
        'the dialog kept the old picture',
      ),
    );
  } finally {
    URL.createObjectURL = objectUrls.create;
    URL.revokeObjectURL = objectUrls.revoke;
  }
});

test('a member known only by a privacy id is not shown as a phone number', async () => {
  const { fireEvent, within } = rtl;
  listGroup = true;
  groupHasLidMember = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));

  const names = Array.from(dialog.querySelectorAll('.group-info-member .name')).map(name => name.textContent);
  // The digits of a privacy id are no phone number, so they are shown as they are and never grouped like one.
  assert.deepEqual(names, ['You', 'Bob', '262813461250071']);
  assert.ok(!(dialog.textContent ?? '').includes('+262'), 'a privacy id was formatted as an international number');
});

test('a participant the gateway refuses is reported with the reason it gave', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Managed via ${SESSION.name}`);
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));

  const writesTo = (action: string) => fetchCalls.filter(c => c.path.endsWith(`/participants/${action}`)).length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await waitFor(() => assert.equal(writesTo('promote'), 1));
  // The accepted write made Bob an admin, so the row now offers the way back.
  await waitFor(() =>
    assert.ok(!(within(dialog).getByRole('button', { name: 'Remove admin: Bob' }) as HTMLButtonElement).disabled),
  );
  assert.ok(!screen.queryByText('The action failed'), 'an accepted write was reported as failed');

  refuseMember = 'all';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove admin: Bob' }));
  await screen.findByText('The action failed');
  await screen.findByText(
    /^demoteParticipants failed for all 1 participant\(s\) in group .*15550002222@c\.us \(403\)$/,
  );
  assert.equal(writesTo('demote'), 1);
});

test('a participant refused inside a 200 answer is named with the reason it gave', async () => {
  const { screen, fireEvent, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));

  refuseMember = 'some';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await screen.findByText('The action failed');
  await screen.findByText('15550002222: not-authorized');
});

test('a number the gateway refuses to add stays in the box, and an accepted one clears it', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  const box = () => within(dialog).getByLabelText('Add a number with country code') as HTMLInputElement;
  fireEvent.change(box(), { target: { value: TYPED_NUMBER } });

  refuseMember = 'all';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
  await screen.findByText('The action failed');
  assert.equal(box().value, TYPED_NUMBER, 'the number the gateway refused was cleared');

  refuseMember = false;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
  await waitFor(() => assert.equal(box().value, '', 'an accepted number stayed in the box'));
});

const notAdminBadge = `Not an admin via ${SESSION.name}`;

test('an operator who is no admin of a locked group can edit none of its info and manage no member', async () => {
  const { fireEvent, within } = rtl;
  listGroup = true;
  groupAdmin = false;
  renderPage();
  const dialog = await openGroupInfo(notAdminBadge);
  assert.equal(
    (within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).disabled,
    true,
    'the name is editable',
  );
  assert.equal((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).disabled, true);
  assert.equal((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled, true);

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  assert.ok(!within(dialog).queryByRole('button', { name: /^Remove: / }), 'a member was offered member actions');
  assert.ok(!within(dialog).queryByRole('button', { name: 'Add' }), 'a member was offered adding a number');
});

test('an operator who is no admin of an unlocked group can edit its info, and still manages no member', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  groupAdmin = false;
  groupLocked = false;
  renderPage();
  const dialog = await openGroupInfo(notAdminBadge);
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Nord' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => assert.equal(groupName, 'Team Nord', 'the name of an unlocked group was not saved by a member'));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  assert.ok(!within(dialog).queryByRole('button', { name: /^Remove: / }), 'a member was offered member actions');
});

test('a changed description is saved on its own through the description route', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'new description' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.method === 'PUT' && c.path.endsWith('/description'))?.body, {
      description: 'new description',
    }),
  );
  assert.ok(!fetchCalls.some(c => c.path.endsWith('/subject')), 'an unchanged name was saved');
});

test('removing a member asks first, and sends nothing unless it is confirmed', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const confirm = window.confirm;
  try {
    renderPage();
    const dialog = await openGroupInfo();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
    const removals = () => fetchCalls.filter(c => c.method === 'DELETE' && c.path.endsWith('/participants'));

    const asked: Array<string | undefined> = [];
    window.confirm = message => {
      asked.push(message);
      return false;
    };
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove: Bob' }));
    assert.deepEqual(asked, ['Remove Bob from the group?']);
    await settle();
    assert.deepEqual(removals(), [], 'a member was removed without being confirmed');

    window.confirm = () => true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove: Bob' }));
    await waitFor(() =>
      assert.deepEqual(
        removals().map(c => c.body),
        [{ participants: ['15550002222@c.us'] }],
      ),
    );
  } finally {
    window.confirm = confirm;
  }
});

// Both engines hand the number over without a device, so this id only reaches the dialog from a synthetic list;
// the rule it pins is that the account's own entry is found by its id as well.
test('the own account is recognised under an id with a device suffix, and is offered no member actions', async () => {
  const { fireEvent, within } = rtl;
  listGroup = true;
  ownHasDeviceSuffix = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  const names = Array.from(dialog.querySelectorAll('.group-info-member .name')).map(name => name.textContent);
  assert.deepEqual(names, ['You', 'Bob']);
  assert.ok(!within(dialog).queryByRole('button', { name: /: You$/ }), 'the own account was offered member actions');
});

test('a member who is no admin sees the group read-only, and a viewer key gets no write actions', async () => {
  const { screen, fireEvent, within } = rtl;
  listGroup = true;
  groupAdmin = false;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  const { container } = renderPage();
  await screen.findByText('Team');
  // Every entry an open row menu offers, by name.
  const offered = () =>
    within(container.querySelector('.chat-row-menu-popover') as HTMLElement)
      .getAllByRole('button')
      .map(button => button.textContent?.trim());
  // A viewer may look at a 1:1 contact, and nothing else.
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.deepEqual(offered(), ['Contact info'], 'a viewer was offered a write action on a 1:1 chat');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  assert.deepEqual(offered(), ['Group info'], 'a viewer was offered a write action on a group');
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));

  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Not an admin via ${SESSION.name}`);
  assert.ok((within(dialog).getByDisplayValue('Team') as HTMLInputElement).disabled, 'the name is editable');
  assert.ok((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled);
});

test('a 1:1 row clears its chat and deletes it on whatsapp-web.js, each only after its own confirmation', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
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

/** Like pickRowAction, for an entry named by the address book, which the first menu to open has to read. */
async function pickRowActionOnceLoaded(name: string, action: string): Promise<void> {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('button', { name: action }));
}

test("a row's menu sits fixed above the list, and scrolling the list closes it", async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  const popover = container.querySelector('.chat-row-menu-popover') as HTMLElement;
  assert.equal(popover.style.position, 'fixed', 'the menu can be clipped by the scrolling list');
  fireEvent.scroll(popover.closest('.chat-item-wrap')?.parentElement as HTMLElement);
  assert.equal(
    container.querySelectorAll('.chat-row-menu-popover').length,
    0,
    'the menu stayed open, adrift from its row',
  );
});

/** The accessible name of the element that has focus: DOM nodes are compared by name, as a failed deepEqual on them hangs. */
const focusedName = () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName;

test("dismissing a dialog a row's menu opened returns focus to the row's menu button", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  const trigger = screen.getByRole('button', { name: 'Actions for Alice' });
  trigger.focus();
  fireEvent.click(trigger);
  const item = screen.getByRole('button', { name: 'Block contact' });
  item.focus();
  fireEvent.click(item);
  await screen.findByRole('dialog');

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.equal(focusedName(), 'Actions for Alice', 'focus fell to the page');
});

test("the contact dialog opens on its first name field, and closing it returns focus to the row's menu button", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  const trigger = screen.getByRole('button', { name: 'Actions for Alice' });
  trigger.focus();
  fireEvent.click(trigger);
  const item = await screen.findByRole('button', { name: 'Rename contact' });
  item.focus();
  fireEvent.click(item);
  const dialog = await screen.findByRole('dialog');
  const first = within(dialog).getByLabelText('First name');
  assert.equal(document.activeElement === first, true, `focus is on "${focusedName()}", not on the first name field`);

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.equal(focusedName(), 'Actions for Alice', 'focus fell to the page');
});

test('the contact dialog opened from the room menu returns focus to the room menu button', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  const trigger = container.querySelector('.room-menu-trigger') as HTMLButtonElement;
  trigger.focus();
  fireEvent.click(trigger);
  const item = await within(container.querySelector('.room-menu-popover') as HTMLElement).findByRole('button', {
    name: 'Rename contact',
  });
  item.focus();
  fireEvent.click(item);
  const dialog = await screen.findByRole('dialog');
  assert.equal(
    document.activeElement === within(dialog).getByLabelText('First name'),
    true,
    'the dialog did not open on its first name field',
  );

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.equal(focusedName(), 'More actions', 'focus fell to the page after the contact dialog');
});

test("dismissing a dialog the room's menu opened, or the menu itself, returns focus to its button", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  const trigger = container.querySelector('.room-menu-trigger') as HTMLButtonElement;

  trigger.focus();
  fireEvent.click(trigger);
  const item = within(container.querySelector('.room-menu-popover') as HTMLElement).getByRole('button', {
    name: 'Block contact',
  });
  item.focus();
  fireEvent.click(item);
  await screen.findByRole('dialog');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.equal(focusedName(), 'More actions', 'focus fell to the page after the dialog');

  fireEvent.click(trigger);
  within(container.querySelector('.room-menu-popover') as HTMLElement)
    .getByRole('button', { name: 'Copy chat ID' })
    .focus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!container.querySelector('.room-menu-popover')));
  assert.equal(focusedName(), 'More actions', 'focus fell to the page after Escape');
});

test('a row menu stays open while the open thread scrolls, which does not move its row', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-messages'), 'the thread did not open'));
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.ok(container.querySelector('.chat-row-menu-popover'), 'the menu did not open');

  // A message that arrives makes the open thread scroll to its end.
  fireEvent.scroll(container.querySelector('.room-messages') as HTMLElement);
  assert.ok(container.querySelector('.chat-row-menu-popover'), 'a scroll of the thread closed the menu');

  // The list the row sits in does move it.
  fireEvent.scroll(container.querySelector('.chats-list') as HTMLElement);
  assert.equal(
    container.querySelectorAll('.chat-row-menu-popover').length,
    0,
    'the menu stayed open, adrift from its row',
  );
});

test("a row's menu is placed by physical edges, so a right-to-left page keeps the position it computed", async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  const popover = container.querySelector('.chat-row-menu-popover') as HTMLElement;
  assert.notEqual(popover.style.left, '', 'no horizontal position was set');
  // The stylesheet pins the end edge with inset-inline-end. Releasing it with that same logical property would,
  // right-to-left, release the left edge that was just set; the physical right edge is the one to release.
  assert.equal(popover.style.right, 'auto', 'the stylesheet still pins the popover by its end edge');
  assert.ok(!/inset-inline/.test(popover.getAttribute('style') ?? ''), 'a logical edge can undo the physical one');
});

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
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
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

// ── Review regressions: late results stay with their session, declined writes change nothing, and the
// address book decides what is saved and what can be. ──

/** Switch to another session through the session switcher. */
/** The name the session switcher shows for the selected session. */
const selectedSessionName = (container: HTMLElement) =>
  container.querySelector('.session-switcher-btn .session-name')?.textContent;

function switchSession(container: HTMLElement, name: string): void {
  const { fireEvent, within } = rtl;
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const list = container.querySelector('[role="listbox"]') as HTMLElement;
  fireEvent.click(within(list).getByRole('option', { name: new RegExp(name) }));
}

const settle = async () => {
  await rtl.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/** A dialog's confirming button, which loses its label to a spinner while its request is out. */
const confirmButton = (dialog: HTMLElement) =>
  dialog.querySelector('.modal-footer button:last-child') as HTMLButtonElement;

test('a number lookup that answers after the panel closed and the session changed opens nothing', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const release = hold('check');
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Start chat with/ }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.path.includes('/contacts/check/')),
      'no lookup was made',
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  release();
  await settle();

  assert.equal(container.querySelectorAll('.room-header').length, 0, "A's lookup opened a chat on B");
  assert.ok(!screen.queryByText('15550009999'), "A's lookup added a row to B's list");
});

test('a group created after the session changed is not opened on the new session', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const release = hold('createGroup');
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Late team' } });
  fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'POST' && c.path.endsWith('/groups'))));

  // Back to the new-chat view, Back again out of the panel, then to the other session.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => assert.equal(container.querySelector('.new-chat-panel'), null, 'the panel stayed open'));
  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  release();
  await settle();

  assert.equal(container.querySelectorAll('.room-header').length, 0, 'the new group opened on the other session');
  assert.ok(!screen.queryByText('Late team'), "the group was added to the other session's list");
});

test("a pin that answers after a switch does not pin the other session's chat with the same id", async () => {
  const { screen, waitFor } = rtl;
  listSecond = true;
  const release = hold('pin');
  const { container } = renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Pin chat');
  await waitFor(() => assert.ok(fetchCalls.some(c => c.path === `/api/sessions/${SESSION.id}/chats/pin`)));

  // Both sessions list Alice under the same chat id.
  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  await screen.findByText('Alice');
  release();
  await settle();

  assert.ok(!screen.queryByRole('img', { name: 'Pinned' }), "B's row was pinned by A's late answer");
});

test("a dismissed block's late answer leaves the next confirmation open and enabled", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const release = hold('block');
  renderPage();
  await screen.findByText('Team');
  pickRowAction('Alice', 'Block contact');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Block contact' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'POST' && c.path.endsWith('/block'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  pickRowAction('Team', 'Leave group');
  const dialog = await screen.findByRole('dialog');
  assert.equal(confirmButton(dialog).disabled, false, "the block's busy state showed on the next dialog");
  release();
  await settle();
  assert.ok(screen.queryByRole('dialog'), "the block's answer closed the Leave dialog");
  assert.ok(!fetchCalls.some(c => c.path.endsWith('/leave')), 'the Leave dialog sent a request nobody asked for');
});

test("a dismissed mute's late answer leaves the next mute dialog open and enabled", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const release = hold('mute');
  renderPage();
  await screen.findByText('Team');
  pickRowAction('Alice', 'Mute notifications');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'POST' && c.path.endsWith('/chats/mute'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  pickRowAction('Team', 'Mute notifications');
  const dialog = await screen.findByRole('dialog');
  assert.equal(confirmButton(dialog).disabled, false, "the first mute's busy state showed on the next dialog");
  release();
  await settle();
  assert.ok(screen.queryByRole('dialog'), "the first mute's answer closed the next dialog");
});

test("a dismissed contact save's late answer leaves the next save dialog open and enabled", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listExtra = true;
  const release = hold('saveContact');
  renderPage();
  await screen.findByText('Bobby');
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PUT' && c.path.includes('/contacts/'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  pickRowAction('Bobby', 'Save contact');
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Robert' } });
  assert.equal(confirmButton(dialog).disabled, false, "the first save's busy state showed on the next dialog");
  release();
  await settle();
  assert.ok(screen.queryByRole('dialog'), "the first save's answer closed the next dialog");
});

test("a dismissed block's late answer leaves the Leave dialog that is out busy, so it is not sent twice", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const releaseBlock = hold('block');
  renderPage();
  await screen.findByText('Team');
  pickRowAction('Alice', 'Block contact');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Block contact' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.path.endsWith('/block'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  const releaseLeave = hold('leave');
  pickRowAction('Team', 'Leave group');
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.path.endsWith('/leave'))));
  assert.equal(confirmButton(dialog).disabled, true, 'the Leave dialog is not busy while its request is out');

  releaseBlock();
  await settle();
  await settle();
  assert.equal(confirmButton(dialog).disabled, true, "the earlier block's answer made the Leave dialog sendable again");
  fireEvent.click(confirmButton(dialog));
  await settle();
  assert.equal(fetchCalls.filter(c => c.path.endsWith('/leave')).length, 1, 'Leave was sent twice');
  releaseLeave();
  await settle();
});

test("a dismissed mute's late answer leaves the mute dialog that is out busy", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const releaseFirst = hold('mute');
  renderPage();
  await screen.findByText('Team');
  pickRowAction('Alice', 'Mute notifications');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() => assert.equal(fetchCalls.filter(c => c.path.endsWith('/chats/mute')).length, 1));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  // The second mute gets a gate of its own, so the first can answer while the second is still out.
  gates.delete('mute');
  const releaseSecond = hold('mute');
  pickRowAction('Team', 'Mute notifications');
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() => assert.equal(fetchCalls.filter(c => c.path.endsWith('/chats/mute')).length, 2));
  assert.equal(confirmButton(dialog).disabled, true, 'the second mute dialog is not busy while its request is out');

  releaseFirst();
  await settle();
  await settle();
  assert.equal(confirmButton(dialog).disabled, true, "the first mute's answer made the second dialog sendable again");
  releaseSecond();
  await settle();
});

// Baileys declines a clear or delete with no message to key it to (a chat whose history the gateway never saw).
for (const engine of ['whatsapp-web.js', 'baileys']) {
  test(`a clear or delete the engine declines keeps the chat and its dialog, and says it failed (${engine})`, async () => {
    const { screen, fireEvent, within } = rtl;
    declineWrites = true;
    window.sessionStorage.setItem('openwa_engine_type', engine);
    renderPage();
    await screen.findByText('Alice');

    pickRowAction('Alice', 'Clear chat');
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }));
    await screen.findByText('Could not clear the chat');
    assert.ok(screen.getByRole('dialog'), 'the dialog closed on a declined clear');
    assert.ok(screen.getAllByText('hello from alice').length > 0, 'the preview was cleared although nothing was');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    pickRowAction('Alice', 'Delete chat');
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));
    await screen.findByText('Could not delete the chat');
    assert.ok(screen.getByRole('dialog'), 'the dialog closed on a declined delete');
    assert.ok(screen.getAllByText('Alice').length > 0, 'the row was removed although the chat was not');
  });
}

test('a mark-as-unread the engine declines leaves the row read', async () => {
  const { screen } = rtl;
  declineWrites = true;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Mark as unread');
  await screen.findByText('Could not mark the chat as unread');
  assert.ok(!screen.queryByLabelText('Marked as unread'), 'the row was badged although the chat was not marked');
});

// ── A write the engine declines (HTTP 200 with { success: false }) is a failure: nothing changes, and the page
// says so. Pin and archive are the routes of this set that can decline today; the others always answer success,
// and the page holds them to the same rule. ──

interface DeclinedCase {
  title: string;
  /** What the gateway holds before the page opens. */
  setup?: () => void;
  failure: string;
  /** The success message that must not appear. */
  success: string;
  act: () => Promise<void>;
  unchanged: () => void;
}

/** Click the confirming button of the dialog that is open. */
const confirmDialog = async (name: string) => {
  const { screen, fireEvent, within } = rtl;
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name }));
};

const DECLINED_CASES: DeclinedCase[] = [
  {
    title: 'pin',
    failure: 'Could not pin the chat. WhatsApp keeps at most three chats pinned.',
    success: 'Pinned',
    act: async () => pickRowAction('Alice', 'Pin chat'),
    unchanged: () => assert.ok(!rtl.screen.queryByRole('img', { name: 'Pinned' }), 'the row was pinned'),
  },
  {
    title: 'archive',
    failure: 'Could not change the archive',
    success: 'Chat archived',
    act: async () => pickRowAction('Alice', 'Archive chat'),
    unchanged: () => assert.ok(rtl.screen.getByText('Alice'), 'the chat left the main list'),
  },
  {
    title: 'mute',
    failure: 'Could not change the notifications',
    success: 'Muted',
    act: async () => {
      pickRowAction('Alice', 'Mute notifications');
      await confirmDialog('Mute notifications');
    },
    unchanged: () => {
      assert.ok(!rtl.screen.queryByRole('img', { name: 'Muted' }), 'the row was muted');
      assert.ok(rtl.screen.getByRole('dialog'), 'the dialog closed on a declined mute');
    },
  },
  {
    title: 'contact save',
    failure: 'Could not save the contact',
    success: 'Contact saved',
    act: async () => {
      await pickRowActionOnceLoaded('Alice', 'Rename contact');
      const dialog = await rtl.screen.findByRole('dialog');
      rtl.fireEvent.change(rtl.within(dialog).getByLabelText('First name'), { target: { value: 'Alicia' } });
      rtl.fireEvent.click(rtl.within(dialog).getByRole('button', { name: 'Save' }));
    },
    unchanged: () => {
      assert.ok(rtl.screen.getByText('Alice'), 'the row was renamed');
      assert.ok(rtl.screen.getByRole('dialog'), 'the dialog closed on a declined save');
    },
  },
  {
    title: 'block',
    failure: 'Could not change the block',
    success: 'Alice blocked',
    act: async () => {
      pickRowAction('Alice', 'Block contact');
      await confirmDialog('Block contact');
    },
    unchanged: () => assert.ok(rtl.screen.getByRole('dialog'), 'the dialog closed on a declined block'),
  },
  {
    title: 'unblock',
    setup: () => {
      blockedIds = [CHAT.id];
    },
    failure: 'Could not change the block',
    success: 'Alice unblocked',
    act: async () => pickRowAction('Alice', 'Unblock contact'),
    unchanged: () => undefined,
  },
  {
    title: 'leave',
    failure: 'Could not leave the group',
    success: 'Left "Team"',
    act: async () => {
      pickRowAction('Team', 'Leave group');
      await confirmDialog('Leave group');
    },
    unchanged: () => assert.ok(rtl.screen.getByRole('dialog'), 'the dialog closed on a declined leave'),
  },
];

for (const declined of DECLINED_CASES) {
  test(`a declined ${declined.title} is reported as a failure and changes nothing`, async () => {
    const { screen } = rtl;
    listGroup = true;
    declineWrites = true;
    declined.setup?.();
    renderPage();
    await screen.findByText('Team');
    await declined.act();
    await screen.findByText(declined.failure);
    assert.ok(screen.getByText('WhatsApp declined the change.'), 'the reason was not shown');
    assert.ok(!screen.queryByText(declined.success), 'a declined change was announced as done');
    declined.unchanged();
  });
}

// ── A request that answers after the session was switched changes nothing on the session now selected, which
// can list a chat under the same id. ──

test("a contact save that answers after a switch renames nothing on the other session's row", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listSecond = true;
  const release = hold('saveContact');
  const { container } = renderPage();
  await screen.findByText('Alice');
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Alicia' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PUT' && c.path.includes('/contacts/'))));

  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  await screen.findByText('Alice');
  release();
  await settle();
  await settle();
  assert.ok(screen.getByText('Alice'), "the other session's row lost its name");
  assert.ok(!screen.queryByText('Alicia'), "A's save renamed B's row");
});

test("a mute that answers after a switch mutes nothing on the other session's row", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const release = hold('mute');
  const { container } = renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Mute notifications');
  await confirmDialog('Mute notifications');
  await waitFor(() => assert.ok(fetchCalls.some(c => c.path.endsWith('/chats/mute'))));

  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  await screen.findByText('Alice');
  release();
  await settle();
  await settle();
  assert.ok(!screen.queryByRole('img', { name: 'Muted' }), "B's row was muted by A's late answer");
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.ok(screen.getByRole('button', { name: 'Mute notifications' }), "B's menu offers Unmute");
});

for (const kind of ['clear', 'delete'] as const) {
  test(`a ${kind} that answers after a switch leaves the other session's chat of the same id as it was`, async () => {
    const { screen, waitFor } = rtl;
    window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
    listSecond = true;
    const release = hold(kind === 'clear' ? 'clearChat' : 'deleteChat');
    const { container } = renderPage();
    await screen.findByText('Alice');
    pickRowAction('Alice', kind === 'clear' ? 'Clear chat' : 'Delete chat');
    await confirmDialog(kind === 'clear' ? 'Clear chat' : 'Delete chat');
    await waitFor(() =>
      assert.ok(fetchCalls.some(c => c.path.endsWith(kind === 'clear' ? '/messages' : '/chats/delete'))),
    );

    switchSession(container, SECOND_SESSION.name);
    await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
    await screen.findByText('Alice');
    release();
    await settle();
    await settle();
    assert.ok(screen.getByText('Alice'), "A's answer removed B's chat");
    assert.ok(screen.getAllByText('hello from alice').length > 0, "A's answer emptied B's preview");
  });
}

// ── A chat list asked for before one of the page's own changes answers with the flags from before it, and must
// not undo that change. ──

const chatListReads = () =>
  fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(`/api/sessions/${SESSION.id}/chats?`)).length;

const RELOAD_RACES: Array<{ title: string; engine?: string; act: () => Promise<void>; shows: () => void }> = [
  {
    title: 'an archive',
    act: async () => pickRowAction('Alice', 'Archive chat'),
    shows: () => assert.ok(!rtl.screen.queryByText('Alice'), 'the archived chat is back in the main list'),
  },
  {
    title: 'a pin',
    act: async () => pickRowAction('Alice', 'Pin chat'),
    shows: () => assert.ok(rtl.screen.getByRole('img', { name: 'Pinned' }), 'the pinned chat lost its pin'),
  },
  {
    title: 'a mute',
    act: async () => {
      pickRowAction('Alice', 'Mute notifications');
      await confirmDialog('Mute notifications');
    },
    shows: () => assert.ok(rtl.screen.getByRole('img', { name: 'Muted' }), 'the muted chat lost its mute'),
  },
  {
    title: 'a mark as unread',
    act: async () => pickRowAction('Alice', 'Mark as unread'),
    shows: () => assert.ok(rtl.screen.getByLabelText('Marked as unread'), 'the chat marked unread reads as read'),
  },
  {
    title: 'a rename',
    act: async () => {
      await pickRowActionOnceLoaded('Alice', 'Rename contact');
      const dialog = await rtl.screen.findByRole('dialog');
      rtl.fireEvent.change(rtl.within(dialog).getByLabelText('First name'), { target: { value: 'Alicia' } });
      rtl.fireEvent.click(rtl.within(dialog).getByRole('button', { name: 'Save' }));
    },
    shows: () => assert.ok(rtl.screen.getByText('Alicia'), 'the renamed chat has its old name back'),
  },
  {
    title: 'a delete',
    engine: 'whatsapp-web.js',
    act: async () => {
      pickRowAction('Alice', 'Delete chat');
      await confirmDialog('Delete chat');
    },
    shows: () => assert.ok(!rtl.screen.queryByText('Alice'), 'the deleted chat is back in the sidebar'),
  },
];

for (const race of RELOAD_RACES) {
  test(`a chat list asked for before ${race.title} does not undo it when it answers`, async () => {
    const { screen, waitFor } = rtl;
    if (race.engine) window.sessionStorage.setItem('openwa_engine_type', race.engine);
    renderPage();
    await screen.findByText('Alice');
    const release = hold('chats');
    // An edit in a chat that was never opened asks for the list again, and the answer is held back.
    receiveEvent('message.edited', {
      messageId: 'wamid.edit.1',
      chatId: CHAT.id,
      body: 'edited',
      timestamp: 1_700_001_000,
    });
    await waitFor(() => assert.equal(chatListReads(), 2, 'the edit did not ask for the list'));

    await race.act();
    await waitFor(race.shows);
    // The list was asked for before the change, so it still holds the flags from before it.
    release();
    await settle();
    await settle();
    race.shows();
  });
}

test('a chat that writes again after its delete is listed by the list that message asks for', async () => {
  const { screen, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  renderPage();
  await screen.findByText('Alice');
  const release = hold('chats');
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.2',
    chatId: CHAT.id,
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.equal(chatListReads(), 2, 'the edit did not ask for the list'));

  pickRowAction('Alice', 'Delete chat');
  await confirmDialog('Delete chat');
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the chat was not deleted'));
  // The conversation is gone, so its next message finds no row and asks for the list again.
  receiveFromAlice('wamid.after.delete', 'hello again');

  release();
  await waitFor(() => assert.equal(chatListReads(), 3, 'the message did not ask for the list'));
  await screen.findByText('Alice');
});

test('a chat list asked for before Mark as unread does not mark a chat that was opened and read since', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  const release = hold('chats');
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.unread',
    chatId: CHAT.id,
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.equal(chatListReads(), 2, 'the edit did not ask for the list'));

  pickRowAction('Alice', 'Mark as unread');
  await screen.findByLabelText('Marked as unread');
  // Opening the chat is what reads it again, and clears the mark.
  fireEvent.click(screen.getByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.ok(!screen.queryByLabelText('Marked as unread'), 'opening the chat kept its mark'));

  release();
  await settle();
  await settle();
  assert.ok(!screen.queryByLabelText('Marked as unread'), 'the earlier list put the unread mark back on the open chat');
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Mark as unread' }), 'the room menu lost Mark as unread');
});

test('a chat list asked for before a chat was opened does not bring its old unread count back', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceNow.unreadCount = 2;
  const { container } = renderPage();
  await screen.findByLabelText('2 unread messages');
  const release = hold('chats');
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.count',
    chatId: '15550002222@c.us',
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.equal(chatListReads(), 2, 'the edit did not ask for the list'));

  fireEvent.click(screen.getByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.ok(!screen.queryByLabelText('2 unread messages'), 'opening the chat kept its badge'));
  release();
  await settle();
  await settle();
  assert.ok(!screen.queryByLabelText('2 unread messages'), 'the earlier list put the old unread count back');
});

test('a chat list asked for after a change is taken as it comes, so a later change elsewhere shows', async () => {
  const { screen, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Archive chat');
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the chat was not archived'));

  // The phone takes the chat out of the archive, and the next list is asked for after the change here.
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.2',
    chatId: CHAT.id,
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.equal(chatListReads(), 2, 'the edit did not ask for the list'));
  await waitFor(() => assert.ok(screen.getByText('Alice'), 'the list asked for later did not bring the chat back'));
});

test('a message that reaches a chat after a change keeps its row when an earlier list answers', async () => {
  const { screen, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  const release = hold('chats');
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.3',
    chatId: CHAT.id,
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.equal(chatListReads(), 2, 'the edit did not ask for the list'));
  pickRowAction('Alice', 'Mark as unread');
  await screen.findByLabelText('Marked as unread');

  // The first message into a chat marked unread counts as one, which the earlier list's flags must not undo.
  receiveFromAlice('wamid.live.after', 'after the mark');
  await screen.findByLabelText('1 unread message');
  release();
  await settle();
  await settle();
  assert.ok(screen.getByLabelText('1 unread message'), 'the earlier list put the old unread state over the frame');
  assert.ok(screen.getByText('after the mark'), 'the earlier list rolled the preview back');
});

// ── The live history read of an opened chat. ──

// Baileys answers 501 to it, so every chat opened there logged a failed call in the browser console. An engine
// the page does not know is still asked: skipping it would drop the backfill on an engine that has it.
for (const [engine, asked] of [
  ['baileys', false],
  ['whatsapp-web.js', true],
  [null, true],
] as const) {
  test(`opening a chat ${asked ? 'asks' : 'does not ask'} ${engine ?? 'an unknown engine'} for live history`, async () => {
    const { screen, fireEvent, waitFor } = rtl;
    if (engine) window.sessionStorage.setItem('openwa_engine_type', engine);
    else window.sessionStorage.removeItem('openwa_engine_type');
    aliceThread = [threadRow(1)];
    renderPage();
    fireEvent.click(await screen.findByText('Alice'));
    await screen.findByText('message 1');
    const history = () => fetchCalls.filter(c => c.method === 'GET' && /\/messages\/[^/]+\/history/.test(c.path));
    if (asked) await waitFor(() => assert.equal(history().length, 1, 'the live history was not read once'));
    else assert.equal(history().length, 0, 'the engine that answers 501 was asked for live history');
  });
}

// ── What clearing and deleting a chat leave behind on the page. ──

test('clearing a chat empties its preview and refreshes the thread that is open', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  aliceThread = [threadRow(1)];
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await screen.findByText('message 1');

  pickRowAction('Alice', 'Clear chat');
  await confirmDialog('Clear chat');
  await waitFor(() =>
    assert.ok(!screen.queryByText('message 1'), 'the open thread kept the messages that were cleared'),
  );
  assert.ok(!screen.queryByText('hello from alice'), 'the row kept the preview of a cleared chat');
  const sidebar = container.querySelector('.chats-sidebar') as HTMLElement;
  assert.ok(within(sidebar).getByText('Alice'), 'clearing removed the chat from the list');
});

test('deleting a chat drops its cached thread along with the row', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  aliceThread = [threadRow(1)];
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await screen.findByText('message 1');
  // The room is closed first: removing a query an open room still observes leaves a gc timer on the removed
  // query that nothing can clear, which holds the test process open for minutes.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => assert.ok(!container.querySelector('.room-header'), 'the room did not close'));
  const thread = () => queryClients[0].getQueryData(['messages', SESSION.id, CHAT.id]);
  assert.ok(thread(), 'the thread was not cached');

  pickRowAction('Alice', 'Delete chat');
  await confirmDialog('Delete chat');
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the deleted chat stayed in the list'));
  assert.equal(thread(), undefined, 'the deleted chat kept its thread in the cache');
});

// ── Switching session leaves nothing of the session that was left open: the dialogs and the archive view belong
// to it (the new chat panel too, which hides the session selector: see Chats.test.ts). ──

const LEFT_OPEN: Array<{ title: string; open: () => Promise<void>; gone: (container: HTMLElement) => boolean }> = [
  {
    title: 'group info dialog',
    open: async () => {
      pickRowAction('Team', 'Group info');
      await rtl.screen.findByRole('dialog');
    },
    gone: () => !rtl.screen.queryByRole('dialog'),
  },
  {
    title: 'confirmation dialog',
    open: async () => {
      pickRowAction('Alice', 'Block contact');
      await rtl.screen.findByRole('dialog');
    },
    gone: () => !rtl.screen.queryByRole('dialog'),
  },
  {
    title: 'mute dialog',
    open: async () => {
      pickRowAction('Alice', 'Mute notifications');
      await rtl.screen.findByRole('dialog');
    },
    gone: () => !rtl.screen.queryByRole('dialog'),
  },
  {
    title: 'contact dialog',
    open: async () => {
      await pickRowActionOnceLoaded('Alice', 'Rename contact');
      await rtl.screen.findByRole('dialog');
    },
    gone: () => !rtl.screen.queryByRole('dialog'),
  },
  {
    title: 'archive view',
    open: async () => {
      pickRowAction('Alice', 'Archive chat');
      await rtl.waitFor(() => assert.ok(!rtl.screen.queryByText('Alice')));
      rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /^Archived/ }));
      await rtl.screen.findByText('Alice');
    },
    // The other session holds no archived chat, so its list is the main one, with Alice in it.
    gone: () => !rtl.screen.queryByText('Archived chats') && Boolean(rtl.screen.queryByText('Alice')),
  },
];

for (const left of LEFT_OPEN) {
  test(`switching session closes the ${left.title} of the session that was left`, async () => {
    const { screen, waitFor } = rtl;
    listSecond = true;
    listGroup = true;
    const { container } = renderPage();
    await screen.findByText('Team');
    await left.open();

    switchSession(container, SECOND_SESSION.name);
    await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
    await screen.findByText('Alice');
    await waitFor(() => assert.ok(left.gone(container), `the ${left.title} stayed open on the other session`));
  });
}

test('opening a chat from the new chat panel clears the filter and the search, so the chat is listed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Groups' }));
  fireEvent.change(screen.getByPlaceholderText('Search chats...'), { target: { value: 'zzz' } });
  assert.ok(!screen.queryByText('Alice'), 'the filter and the search hid nothing');

  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the chat did not open'));
  const list = container.querySelector('.chats-list') as HTMLElement;
  await waitFor(() => assert.ok(list.textContent?.includes('Bob'), 'the opened chat is not in the list'));
  assert.equal(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed'), 'true');
  assert.equal((screen.getByPlaceholderText('Search chats...') as HTMLInputElement).value, '');
});

test('a search finds an archived chat, which the list itself keeps in the archive view', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Archive chat');
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the archived chat stayed in the main list'));

  fireEvent.change(screen.getByPlaceholderText('Search chats...'), { target: { value: 'Alice' } });
  await screen.findByText('Alice');
});

// ── Menus close on a press outside them and on Escape; Escape leaves the open chat alone. ──

test("a row's menu closes on a press outside it and stays open for a press inside it", async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  fireEvent.mouseDown(container.querySelector('.chat-row-menu-popover') as HTMLElement);
  assert.ok(container.querySelector('.chat-row-menu-popover'), 'a press inside closed the menu');
  fireEvent.mouseDown(document.body);
  assert.ok(!container.querySelector('.chat-row-menu-popover'), 'a press outside left the menu open');
});

test("a row's menu leaves an Escape the input method processed alone and closes on a plain Escape", async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 });
  assert.ok(container.querySelector('.chat-row-menu-popover'), 'an Escape the input method processed closed the menu');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(!container.querySelector('.chat-row-menu-popover'), 'Escape left the menu open');
});

test("the room's menu closes on a press outside it and on Escape, and Escape leaves the room open", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  const trigger = container.querySelector('.room-menu-trigger') as HTMLElement;
  const menuOpen = () => Boolean(container.querySelector('.room-menu-popover'));

  fireEvent.click(trigger);
  fireEvent.mouseDown(container.querySelector('.room-menu-popover') as HTMLElement);
  assert.ok(menuOpen(), 'a press inside closed the menu');
  fireEvent.mouseDown(document.body);
  assert.ok(!menuOpen(), 'a press outside left the menu open');

  fireEvent.click(trigger);
  assert.ok(menuOpen());
  fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 });
  assert.ok(menuOpen(), 'an Escape the input method processed closed the menu');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(!menuOpen(), 'Escape left the menu open');
  assert.ok(container.querySelector('.room-header'), 'Escape closed the room along with the menu');
});

test('a read-only key does not read the blocklist, which only an operator can act on', async () => {
  const { screen } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderPage();
  await screen.findByText('Alice');
  await settle();
  assert.ok(!fetchCalls.some(c => c.path.endsWith('/contacts/blocked')), 'a viewer key read the blocklist');
});

test('a contact Baileys knows by push name only is unsaved: Unknown lists it, and its menu offers Save', async () => {
  const { screen, fireEvent } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Bobby');

  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  await screen.findByText('Bobby');
  assert.ok(!screen.queryByText('Alice'), 'a saved contact is listed as unknown');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Bobby' }));
  assert.ok(screen.getByRole('button', { name: /^Save contact/ }));
  assert.ok(!screen.queryByRole('button', { name: /^Rename contact/ }), 'an unsaved contact is offered Rename');
});

test("the contact dialog follows the address book the menu read, not the chat's name", async () => {
  const { screen, fireEvent, within } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Bobby');

  // Known to Baileys by a bare push name: unsaved, so Save, and the push name is no name to start from.
  pickRowAction('Bobby', 'Save contact');
  let dialog = await screen.findByRole('dialog');
  assert.equal(dialog.querySelector('h2')?.textContent, 'Save contact');
  assert.equal((within(dialog).getByLabelText('First name') as HTMLInputElement).value, '');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  // Saved under a name that reads like a number: Rename, with nothing to start from.
  await pickRowActionOnceLoaded('+1 555 000 3333', 'Rename contact');
  dialog = await screen.findByRole('dialog');
  assert.equal(dialog.querySelector('h2')?.textContent, 'Rename contact');
  assert.equal((within(dialog).getByLabelText('First name') as HTMLInputElement).value, '');
});

test('a contact dialog opened before the address book lands starts from the saved name once it does', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const release = hold('contacts');
  aliceNow.name = 'Alice Smith';
  renderPage();
  await screen.findByText('Alice Smith');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice Smith' }));
  // Until the book lands the entry reads the default.
  fireEvent.click(screen.getByRole('button', { name: /^Save contact/ }));
  const dialog = await screen.findByRole('dialog');
  const value = (label: string) => (within(dialog).getByLabelText(label) as HTMLInputElement).value;
  assert.equal(dialog.querySelector('h2')?.textContent, 'Save contact');
  assert.equal(value('First name'), '');

  release();
  await waitFor(() => assert.equal(dialog.querySelector('h2')?.textContent, 'Rename contact'));
  assert.equal(value('First name'), 'Alice', 'the Rename dialog opened with an empty name');
  assert.equal(value('Last name (optional)'), 'Smith');
});

for (const [field, other] of [
  ['First name', 'Last name (optional)'],
  ['Last name (optional)', 'First name'],
]) {
  test(`a ${field.toLowerCase()} typed before the address book lands is kept when it does`, async () => {
    const { screen, fireEvent, waitFor, within } = rtl;
    const release = hold('contacts');
    aliceNow.name = 'Alice Smith';
    renderPage();
    await screen.findByText('Alice Smith');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice Smith' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save contact/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(field), { target: { value: 'Zed' } });

    release();
    await waitFor(() => assert.equal(dialog.querySelector('h2')?.textContent, 'Rename contact'));
    const value = (label: string) => (within(dialog).getByLabelText(label) as HTMLInputElement).value;
    assert.equal(value(field), 'Zed', 'what was typed was lost');
    // The other field keeps what it showed, so the typed and the saved name never mix.
    assert.equal(value(other), '');
  });
}

test("the contact dialog's Save button submits its form, so Enter in a name field saves", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
  const dialog = await screen.findByRole('dialog');
  const form = dialog.querySelector('form') as HTMLFormElement;
  const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  // A browser submits a form on Enter through its submit button, which has to belong to that form. The Save
  // button sits in the dialog's footer, outside the form element.
  assert.ok(save.type === 'submit' && save.form === form, 'Enter in a name field has no submit button to press');

  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Alicia' } });
  fireEvent.click(save);
  await waitFor(() =>
    assert.deepEqual(
      fetchCalls.filter(c => c.method === 'PUT' && c.path.includes('/contacts/')).map(c => c.body),
      [{ firstName: 'Alicia' }],
      'a click on Save did not send the name exactly once',
    ),
  );
});

// ── The address book is read when a surface needs it, not when the page opens. ──

const contactReads = () =>
  fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(`/api/sessions/${SESSION.id}/contacts?`));

test('opening the page reads no address book', async () => {
  const { screen } = rtl;
  renderPage();
  await screen.findByText('Alice');
  await settle();
  assert.equal(contactReads().length, 0, 'the page walked the address book on mount');
});

test('the first menu to open reads the address book once, and its Save entry then follows it', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(contactReads().length, 1);

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await settle();
  assert.equal(contactReads().length, 1, 'a second menu read the address book again');
});

test('switching session after a menu opened reads no address book for the new session', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  fireEvent.keyDown(document, { key: 'Escape' });
  const readsOn = (id: string) =>
    fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(`/api/sessions/${id}/contacts?`)).length;
  assert.equal(readsOn(SESSION.id), 1);

  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  await screen.findByText('Alice');
  await settle();
  await settle();
  assert.equal(readsOn(SECOND_SESSION.id), 0, 'the new session paid for an address book nobody asked for');

  // A menu on the new session asks for its own.
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(readsOn(SECOND_SESSION.id), 1);
});

test('coming back to a session whose menu opened on an earlier visit reads no address book', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  fireEvent.keyDown(document, { key: 'Escape' });
  const readsOn = (id: string) =>
    fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(`/api/sessions/${id}/contacts?`)).length;
  assert.equal(readsOn(SESSION.id), 1);

  switchSession(container, SECOND_SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SECOND_SESSION.name));
  await screen.findByText('Alice');
  // Past the cache's hold on the session left (these tests keep a query one second once nothing watches it).
  await new Promise(resolve => setTimeout(resolve, 1_500));

  switchSession(container, SESSION.name);
  await waitFor(() => assert.equal(selectedSessionName(container), SESSION.name));
  await screen.findByText('Alice');
  await settle();
  await settle();
  assert.equal(readsOn(SESSION.id), 1, 'coming back read an address book no menu asked for');

  // A menu on this visit asks again.
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(readsOn(SESSION.id), 2);
});

test("a group's menu has no use for the address book and does not read it", async () => {
  const { screen, fireEvent } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  await screen.findByRole('button', { name: 'Group info' });
  await settle();
  assert.equal(contactReads().length, 0, "a group's menu read the address book");
});

test("a read-only key's room menu has no entry that reads the address book, so it does not read it", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  await screen.findByRole('button', { name: 'Copy chat ID' });
  await settle();
  assert.equal(contactReads().length, 0, 'a viewer key walked the address book to open a menu that cannot use it');
});

test("the room's menu asks for the address book as well", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  assert.equal(contactReads().length, 0);
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(contactReads().length, 1);
});

test('the Unknown filter waits for the address book instead of listing nothing', async () => {
  const { screen, fireEvent } = rtl;
  listExtra = true;
  const release = hold('contacts');
  renderPage();
  await screen.findByText('Bobby');
  assert.equal(contactReads().length, 0);

  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  assert.ok(screen.getByText('Loading chats...'), 'the filter did not wait for the address book');
  assert.ok(!screen.queryByText('No chats match this filter'), 'the filter claimed no chat matches');
  release();
  await screen.findByText('Bobby');
  assert.ok(!screen.queryByText('Alice'), 'a saved contact is listed as unknown');
});

test('the Unknown filter says the address book could not be read, and Retry reads it again', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listExtra = true;
  failContacts = true;
  renderPage();
  await screen.findByText('Bobby');
  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));

  await screen.findByText('Could not load contacts');
  assert.ok(!screen.queryByText('No chats match this filter'), 'a failed read was reported as no matching chat');
  assert.equal(contactReads().length, 1);
  assert.equal(screen.getByRole('button', { name: 'Retry' }).querySelector('.animate-spin'), null);

  // The retry keeps the keyboard where it was while the read runs, and says it is busy.
  failContacts = false;
  const release = hold('contacts');
  const retry = screen.getByRole('button', { name: 'Retry' });
  retry.focus();
  fireEvent.click(retry);
  await waitFor(() => assert.equal(contactReads().length, 2));
  assert.equal(document.activeElement === retry, true, `focus is on "${focusedName()}", not on Retry`);
  assert.equal(retry.getAttribute('aria-disabled'), 'true');
  // A sighted operator sees it too: a spinner beside the label, and nothing like it before the press.
  assert.equal(retry.getAttribute('aria-busy'), 'true');
  assert.ok(retry.querySelector('.animate-spin'), 'the running retry shows no spinner');

  release();
  await screen.findByText('Bobby');
  assert.ok(!screen.queryByText('Could not load contacts'), 'the failed state stayed after the read succeeded');
  assert.ok(!screen.queryByText('Alice'), 'a saved contact is listed as unknown');
});

test('a later address book read that fails keeps the Unknown list it already has', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Bobby');
  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  await screen.findByText('Bobby');

  failContacts = true;
  await queryClients[0].invalidateQueries({ queryKey: ['contacts', SESSION.id] });
  await waitFor(() => assert.equal(contactReads().length, 2));
  await settle();
  assert.ok(screen.getByText('Bobby'), 'the list it had was dropped');
  assert.ok(!screen.queryByText('Could not load contacts'), 'a failed refresh hid a list that was still good');
});

test('the address book is not read again when the window regains focus, unless the last read failed', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  const regainFocus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

  // Stale, as it is five minutes on, yet not worth another walk of every contact.
  await queryClients[0].invalidateQueries({ queryKey: ['contacts', SESSION.id], refetchType: 'none' });
  regainFocus();
  await settle();
  assert.equal(contactReads().length, 1, 'focus walked the address book again');

  // A read that failed is tried again on the next focus.
  rtl.cleanup();
  failContacts = true;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await waitFor(() => assert.equal(contactReads().length, 2));
  failContacts = false;
  regainFocus();
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(contactReads().length, 3);
});

test('Save contact is offered again for the open privacy-id chat once the engine knows its phone, with no reload', async t => {
  const { screen, fireEvent, act, waitFor, within } = rtl;
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  listExtra = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Lia'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  // The route answers null for an id it found no phone for and for a lookup that failed alike.
  await waitFor(() => assert.ok(phoneRequests().length >= 1, 'the phone was not asked for'));
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const saveEntry = () =>
    within(container.querySelector('.room-menu-popover') as HTMLElement).getByRole('button', {
      name: /^Save contact/,
    }) as HTMLButtonElement;
  assert.equal(saveEntry().disabled, true, 'Save contact is offered without a phone to save under');

  // The engine answers a minute later, and the open menu follows once the window is focused again.
  lidPhones[LID_CHAT.id] = '15550004444';
  clock += 61_000;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  // The check reads the page and changes nothing: a callback that touched the DOM would re-run itself forever.
  await waitFor(() =>
    assert.equal(saveEntry().disabled, false, 'Save contact stayed disabled after the engine answered'),
  );
});

test('a chat keyed by a privacy id offers Save contact disabled, with the reason, and sends nothing', async () => {
  const { screen, fireEvent } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Lia');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Lia' }));
  const save = screen.getByRole('button', { name: /^Save contact/ }) as HTMLButtonElement;
  assert.equal(save.disabled, true, 'Save is offered for a @lid chat');
  assert.match(save.textContent ?? '', /privacy id \(@lid\)/);
  fireEvent.click(save);
  assert.ok(!screen.queryByRole('dialog'), 'the save dialog opened for a @lid chat');
  assert.ok(!fetchCalls.some(c => c.method === 'PUT' && c.path.includes('/contacts/')), 'a @lid id was sent');
});

// ── Mark as unread against the automatic read the open room queues (MARK_READ_DEBOUNCE_MS later). ──

const readsOf = (chatId: string) =>
  fetchCalls.filter(
    c => c.path === `/api/sessions/${SESSION.id}/chats/read` && (c.body as { chatId?: string })?.chatId === chatId,
  );
const unreadIndex = (chatId: string) =>
  fetchCalls.findIndex(
    c => c.path === `/api/sessions/${SESSION.id}/chats/unread` && (c.body as { chatId?: string })?.chatId === chatId,
  );

test("Mark as unread drops the chat's queued automatic read, and another chat's queued read still goes out", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listGroup = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Team'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the group did not open'));
  // Both reads are now queued: the group's from its opening, Alice's from hers.
  fireEvent.click(screen.getByText('Alice'));
  pickRowAction('Alice', 'Mark as unread');

  await waitFor(() => assert.equal(readsOf(GROUP.id).length, 1, "the other chat's queued read was dropped"), {
    timeout: 3_000,
  });
  await waitFor(() => assert.ok(unreadIndex(CHAT.id) >= 0, 'the unread mark was not sent'));
  await settle();
  assert.deepEqual(readsOf(CHAT.id), [], 'the queued read went out and undid the unread mark');
});

test('Mark as unread waits for an automatic read already sent, so the unread mark is the last request', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const release = hold('read');
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'the automatic read was not sent'), {
    timeout: 3_000,
  });

  pickRowAction('Alice', 'Mark as unread');
  await settle();
  assert.equal(unreadIndex(CHAT.id), -1, 'the unread mark went out while the read was still in flight');

  release();
  await waitFor(() => assert.ok(unreadIndex(CHAT.id) >= 0, 'the unread mark was not sent'));
  const readIndex = fetchCalls.indexOf(readsOf(CHAT.id)[0]);
  assert.ok(readIndex < unreadIndex(CHAT.id), 'the read was not ordered before the unread mark');
  assert.equal(readsOf(CHAT.id).length, 1, 'another automatic read followed the unread mark');
});

// ── Baileys acknowledges the messages a read names, so the page names them. ──

const readBodies = (chatId: string) => readsOf(chatId).map(c => c.body);

test('on Baileys the automatic read names the incoming messages of the thread, newest included', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceThread = [threadRow(1), threadRow(2, 'outgoing'), threadRow(3), threadRow(4)];
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(readsOf(CHAT.id).length >= 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });
  await screen.findByText('message 4');
  await waitFor(() => assert.ok(readBodies(CHAT.id).at(-1) !== undefined), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id).at(-1), {
    chatId: CHAT.id,
    messageIds: ['wamid.in.1', 'wamid.in.3', 'wamid.in.4'],
  });
});

test('a message that arrives later is the only one the next read names', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceThread = [threadRow(1), threadRow(2)];
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await screen.findByText('message 2');
  await waitFor(
    () => assert.deepEqual(readBodies(CHAT.id).at(-1), { chatId: CHAT.id, messageIds: ['wamid.in.1', 'wamid.in.2'] }),
    {
      timeout: 3_000,
    },
  );
  fetchCalls.length = 0;

  receiveFromAlice('wamid.live.1', 'a live one');
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id), [{ chatId: CHAT.id, messageIds: ['wamid.live.1'] }]);
});

test('a thread that loads after the opening read is read again with its ids', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceThread = [threadRow(1), threadRow(2)];
  const release = hold('thread');
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  // The opening read is due before the thread has come, so it names nothing.
  await waitFor(() => assert.deepEqual(readBodies(CHAT.id), [{ chatId: CHAT.id }]), { timeout: 3_000 });

  release();
  await screen.findByText('message 2');
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 2), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id).at(-1), { chatId: CHAT.id, messageIds: ['wamid.in.1', 'wamid.in.2'] });
});

test('on whatsapp-web.js the read names no message, since the engine reads the whole chat', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  aliceThread = [threadRow(1), threadRow(2)];
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await screen.findByText('message 2');
  await waitFor(() => assert.ok(readsOf(CHAT.id).length >= 1), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id), [{ chatId: CHAT.id }]);
});

/** Make the document read as hidden (a background tab) or visible again, as the browser does before `visibilitychange`. */
function setTabHidden(hidden: boolean): void {
  if (hidden) {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    delete (document as unknown as Record<string, unknown>).hidden;
  }
}

/** A frame the gateway's socket delivers, as the page's realtime handlers receive it. */
function receiveEvent(event: string, data: Record<string, unknown>): void {
  rtl.act(() =>
    lastSocket()?.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_002_000_000).toISOString(),
      payload: { event, sessionId: SESSION.id, data },
    }),
  );
}

/** A message from Alice, delivered the way the gateway's socket delivers one. */
function receiveFromAlice(id: string, body: string): void {
  receiveEvent('message.received', {
    id,
    chatId: CHAT.id,
    from: CHAT.id,
    to: 'me',
    body,
    type: 'text',
    fromMe: false,
    timestamp: 1_700_001_900,
  });
}

test('a message that reaches the open chat while the tab is hidden is marked read once the tab is visible', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });
  fetchCalls.length = 0;

  setTabHidden(true);
  try {
    receiveFromAlice('wamid.hidden.1', 'are you there?');
    await screen.findAllByText('are you there?');
    // Past the quiet window the read would have gone out.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepEqual(readsOf(CHAT.id), [], 'a hidden tab sent a read receipt');
  } finally {
    setTabHidden(false);
  }
  rtl.act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'the withheld read did not follow'), { timeout: 3_000 });
  assert.ok(!screen.queryByLabelText(/unread message/), 'the open chat was badged');
});

test('a list asked for before the open chat read went out leaves no badge on it once the read did', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });

  // What the gateway reports for Alice: one unread message from the moment it arrived until a read reaches it.
  const readsAtArrival = readsOf(CHAT.id).length;
  Object.defineProperty(aliceNow, 'unreadCount', {
    enumerable: true,
    configurable: true,
    get: () => (readsOf(CHAT.id).length > readsAtArrival ? 0 : 1),
  });
  const listReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path.includes('/chats?')).length;
  // The tab is visible: the read is due a debounce after the message, and a list asked for inside it still counts it.
  receiveFromAlice('wamid.visible.badge', 'are you there?');
  const before = listReads();
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.visible',
    chatId: '15550002222@c.us',
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.ok(listReads() > before, 'the edit did not reload the list'), { timeout: 3_000 });
  await settle();
  assert.equal(readsOf(CHAT.id).length, readsAtArrival, 'the read went out before the list was asked for');

  await waitFor(() => assert.equal(readsOf(CHAT.id).length, readsAtArrival + 1, 'the read did not go out'), {
    timeout: 3_000,
  });
  await settle();
  await settle();
  assert.ok(!screen.queryByLabelText('1 unread message'), 'the open chat keeps a badge after its read went out');
});

test('a read the engine declines leaves the open chat showing what the gateway still counts', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });

  declineReads = true;
  const readsAtArrival = readsOf(CHAT.id).length;
  aliceNow.unreadCount = 1;
  const listReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path.includes('/chats?')).length;
  receiveFromAlice('wamid.declined', 'are you there?');
  const before = listReads();
  receiveEvent('message.edited', {
    messageId: 'wamid.edit.declined',
    chatId: '15550002222@c.us',
    body: 'edited',
    timestamp: 1_700_001_000,
  });
  await waitFor(() => assert.ok(listReads() > before, 'the edit did not reload the list'), { timeout: 3_000 });
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, readsAtArrival + 1, 'the read did not go out'), {
    timeout: 3_000,
  });
  await settle();
  await settle();
  assert.ok(screen.queryByLabelText('1 unread message'), 'a read nothing acknowledged hid the count the gateway keeps');
});

test('a chat left before its read is acknowledged keeps the unread count it gathered meanwhile', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listExtra = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });

  // A message into the open chat queues its read; the chat is left, and another message arrives before the read.
  const readsAtArrival = readsOf(CHAT.id).length;
  receiveFromAlice('wamid.first', 'are you there?');
  fireEvent.click(screen.getByText('Bobby'));
  await waitFor(() => assert.equal(container.querySelector('.room-header .room-contact-name')?.textContent, 'Bobby'));
  receiveFromAlice('wamid.second', 'hello?');
  await waitFor(() => assert.ok(screen.queryByLabelText('1 unread message'), 'the chat left did not gather a count'));

  await waitFor(() => assert.equal(readsOf(CHAT.id).length, readsAtArrival + 1, 'the queued read did not go out'), {
    timeout: 3_000,
  });
  await settle();
  await settle();
  assert.ok(screen.queryByLabelText('1 unread message'), 'the read of a chat left hid the count it gathered since');
});

test('a tab that comes back a second time with nothing new owes no second read', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });
  fetchCalls.length = 0;
  const visibilityChanged = () =>
    rtl.act(() => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });

  try {
    setTabHidden(true);
    receiveFromAlice('wamid.hidden.twice', 'are you there?');
    await screen.findAllByText('are you there?');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepEqual(readsOf(CHAT.id), [], 'a hidden tab sent a read receipt');
    setTabHidden(false);
    visibilityChanged();
    await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'the withheld read did not follow'), {
      timeout: 3_000,
    });
    // Let anything the first return queued go out before counting the second.
    await new Promise(resolve => setTimeout(resolve, 300));

    fetchCalls.length = 0;
    setTabHidden(true);
    visibilityChanged();
    setTabHidden(false);
    visibilityChanged();
    await new Promise(resolve => setTimeout(resolve, 1_800));
    assert.deepEqual(readsOf(CHAT.id), [], 'a tab that saw nothing new sent a read when it came back');
  } finally {
    setTabHidden(false);
  }
});

test('a list reload while the tab is hidden badges nothing on the open chat once the tab is visible and the read went out', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });

  // What the gateway reports for Alice: one unread message from the moment it arrived until a read reaches it.
  let readsAtArrival = Number.POSITIVE_INFINITY;
  Object.defineProperty(aliceNow, 'unreadCount', {
    enumerable: true,
    configurable: true,
    get: () => (readsOf(CHAT.id).length > readsAtArrival ? 0 : 1),
  });
  const listReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path.includes('/chats?')).length;
  setTabHidden(true);
  try {
    readsAtArrival = readsOf(CHAT.id).length;
    receiveFromAlice('wamid.hidden.badge', 'are you there?');
    await screen.findAllByText('are you there?');
    // Past the quiet window: the read is withheld, so the gateway still counts the message.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal(readsOf(CHAT.id).length, readsAtArrival, 'a hidden tab sent a read receipt');

    // An edit in a chat that was never opened asks for the list, which now reports the unread message. A badge on
    // the chat nobody is looking at is accepted while the tab is hidden.
    const before = listReads();
    receiveEvent('message.edited', {
      messageId: 'wamid.edit.badge',
      chatId: '15550002222@c.us',
      body: 'edited',
      timestamp: 1_700_001_000,
    });
    await waitFor(() => assert.ok(listReads() > before, 'the edit did not reload the list'), { timeout: 3_000 });
    await settle();
  } finally {
    setTabHidden(false);
  }
  rtl.act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, readsAtArrival + 1, 'the withheld read did not follow'), {
    timeout: 3_000,
  });
  await settle();
  assert.ok(!screen.queryByLabelText('1 unread message'), 'the open chat still shows an unread badge after its read');
  assert.equal(readsOf(CHAT.id).length, readsAtArrival + 1, 'more than one read went out');
});

test('a tab that was hidden but sees no message owes no read when it is visible again', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1), { timeout: 3_000 });
  fetchCalls.length = 0;

  setTabHidden(true);
  setTabHidden(false);
  rtl.act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.deepEqual(readsOf(CHAT.id), []);
});

test("the open room's menu offers Mark as unread for a chat that was opened with unread messages", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  aliceNow.unreadCount = 2;
  const { container } = renderPage();
  await screen.findByLabelText('2 unread messages');
  fireEvent.click(screen.getByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.ok(!screen.queryByLabelText('2 unread messages'), 'opening the chat kept its badge'));

  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Mark as unread' }), 'the room menu lacks Mark as unread');
});

test("the open room's menu follows the chat list when a reload brings a change made elsewhere", async () => {
  const { screen, fireEvent, act, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  // The phone pins the chat, and a reconnect reloads the list.
  aliceNow.pinned = true;
  const socket = lastSocket();
  assert.ok(socket, 'the page opened no socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await screen.findByRole('img', { name: 'Pinned' });

  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Unpin chat' }), 'the room menu kept offering Pin chat');
});

// The Clipboard API is missing over plain HTTP on a LAN address (and in jsdom); the house helper falls back to a
// hidden textarea and execCommand.
async function copyChatIdWith(t: TestContext, copied: boolean): Promise<ReturnType<typeof t.mock.fn>> {
  const { screen, fireEvent, waitFor } = rtl;
  const copy = t.mock.fn(() => copied);
  const hadExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  Object.defineProperty(document, 'execCommand', { value: copy, configurable: true, writable: true });
  t.after(() => {
    if (hadExecCommand) Object.defineProperty(document, 'execCommand', hadExecCommand);
    else delete (document as unknown as Record<string, unknown>).execCommand;
  });
  assert.equal(navigator.clipboard, undefined);

  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  fireEvent.click(screen.getByRole('button', { name: 'Copy chat ID' }));
  return copy;
}

test('Copy chat ID works where navigator.clipboard does not exist', async t => {
  const copy = await copyChatIdWith(t, true);
  await rtl.screen.findByText('Chat ID copied');
  assert.equal(copy.mock.callCount(), 1);
  assert.ok(!rtl.screen.queryByText('Could not copy to clipboard'));
});

test('Copy chat ID leaves keyboard focus on the room menu button when the fallback copy runs', async t => {
  // A browser puts focus in the textarea that select() acts on; jsdom does not.
  t.mock.method(window.HTMLTextAreaElement.prototype, 'select', function (this: HTMLTextAreaElement) {
    this.focus();
  });
  await copyChatIdWith(t, true);
  await rtl.screen.findByText('Chat ID copied');
  assert.equal(focusedName(), 'More actions', 'focus fell to the page');
});

test('Copy chat ID says so when the copy did not happen', async t => {
  const copy = await copyChatIdWith(t, false);
  await rtl.screen.findByText('Could not copy to clipboard');
  assert.equal(copy.mock.callCount(), 1);
  assert.ok(!rtl.screen.queryByText('Chat ID copied'));
});

test('a chat marked unread is read again once it is opened', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Mark as unread');
  await screen.findByLabelText('Marked as unread');
  fetchCalls.length = 0;

  fireEvent.click(screen.getByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not read it again'), {
    timeout: 3_000,
  });
  assert.ok(!screen.queryByLabelText('Marked as unread'), 'the badge stayed after the chat was opened');
});

test('a message that reaches the open chat while Mark as unread is out is not read automatically', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const release = hold('unread');
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });

  pickRowAction('Alice', 'Mark as unread');
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.path.endsWith('/chats/unread')),
      'the mark was not sent',
    ),
  );
  fetchCalls.length = 0;
  receiveFromAlice('wamid.during.1', 'while the mark is out');
  await screen.findAllByText('while the mark is out');
  // Past the quiet window, so a read queued by that message would have gone out.
  await new Promise(resolve => setTimeout(resolve, 1_000));
  release();
  await settle();
  assert.deepEqual(readsOf(CHAT.id), [], 'the message was read automatically and undid the mark');
});

test('on Baileys the row and the room menu offer Clear chat and Delete chat, as on whatsapp-web.js (#1891)', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.ok(screen.getByRole('button', { name: 'Clear chat' }), 'the row menu offered no Clear chat');
  assert.ok(screen.getByRole('button', { name: 'Delete chat' }), 'the row menu offered no Delete chat');
  fireEvent.keyDown(document, { key: 'Escape' });

  fireEvent.click(container.querySelector('.room-menu > button') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Clear chat' }), 'the room menu offered no Clear chat');
  assert.ok(within(menu).getByRole('button', { name: 'Delete chat' }), 'the room menu offered no Delete chat');
});
