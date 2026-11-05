import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, SearchHit, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const OTHER: Session = { ...SESSION, id: 'session-2', name: 'Second', phone: '15559876543' };
const THIRD: Session = { ...SESSION, id: 'session-3', name: 'Third', status: 'disconnected', phone: '15555550000' };
const OTHER_CHAT: Chat = {
  id: '15550009999@c.us',
  name: 'Elsewhere',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
};

// Seven chats listed only under a privacy id: a search hit for the phone id of one contact asks the first five for
// their phone at once and the other two after the gap between batches.
const LID_CHATS: Chat[] = Array.from({ length: 7 }, (_, i) => ({
  id: `${1000000000001 + i}@lid`,
  name: `Lid ${i}`,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000 - i,
  archived: false,
  pinned: false,
  muted: false,
}));
const SECOND_BATCH = LID_CHATS.slice(5).map(chat => chat.id.split('@')[0]);

let hitSession = SESSION.id;
// While set, every read of the session list waits for it: the page asks again for the session of a hit it does not list as
// ready, and the user can leave before the answer comes.
let sessionsGate: Promise<void> | null = null;
let releaseSessions: (() => void) | null = null;
let sessionsStatus = 200;
const holdSessions = (): void => {
  sessionsGate = new Promise(resolve => {
    releaseSessions = resolve;
  });
};
const HIT: SearchHit = {
  messageId: 'db-1',
  waMessageId: 'wa-1',
  sessionId: SESSION.id,
  chatId: '15550001111@c.us',
  body: 'sample 1',
  snippet: 'sample result 1',
  timestamp: 1_700_000_000,
  type: 'text',
  direction: 'incoming',
  from: '15550001111@c.us',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const calls: string[] = [];
const lookups = (): string[] => calls.filter(path => /\/contacts\/[^/]+\/phone$/.test(path));

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let client: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push(path);
    if (path === '/api/sessions') {
      const answer = () =>
        sessionsStatus === 200
          ? json(hitSession === THIRD.id ? [SESSION, OTHER, THIRD] : [SESSION, OTHER])
          : json({ statusCode: sessionsStatus, message: 'unavailable' }, sessionsStatus);
      return sessionsGate ? sessionsGate.then(answer) : Promise.resolve(answer());
    }
    if (path.startsWith('/api/search?')) {
      return Promise.resolve(json({ hits: [{ ...HIT, sessionId: hitSession }], total: 1 }));
    }
    // The second session is the one whose chats are all privacy ids; the first lists a single phone chat.
    if (path.startsWith(`/api/sessions/${OTHER.id}/chats?`)) return Promise.resolve(json(LID_CHATS));
    if (path.startsWith(`/api/sessions/${SESSION.id}/chats?`)) {
      return Promise.resolve(json(hitSession === SESSION.id ? LID_CHATS : [OTHER_CHAT]));
    }
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/profile-picture')) return Promise.resolve(json({ url: null }));
    if (/\/contacts\/[^/]+\/phone$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/phone')[0]);
      return Promise.resolve(json({ contactId: id, phone: null }));
    }
    if (path.includes('/messages?')) return Promise.resolve(json({ messages: [], total: 0 }));
    return Promise.resolve(json([]));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

beforeEach(() => {
  calls.length = 0;
  hitSession = SESSION.id;
  sessionsGate = null;
  releaseSessions = null;
  sessionsStatus = 200;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
});

afterEach(async () => {
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

/** The page under a toast provider that outlives it, as in the app, where the toasts sit above the routes. */
const page = (showChats: boolean): ReactElement =>
  createElement(
    QueryClientProvider,
    { client: client! },
    createElement(
      RoleProvider,
      null,
      createElement(ToastProvider, null, showChats ? createElement(Chats) : createElement('p', null, 'another page')),
    ),
  );

async function searchAndClickFirstHit(container: HTMLElement): Promise<void> {
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Search messages' }));
  const input = container.querySelector('.global-search-input') as HTMLInputElement;
  rtl.fireEvent.change(input, { target: { value: 'sample' } });
  const result = await rtl.waitFor(() => {
    const found = container.querySelector('.global-search-hit');
    assert.ok(found, 'the result is listed');
    return found;
  });
  rtl.fireEvent.click(result);
}

async function clickFirstHit(container: HTMLElement): Promise<void> {
  await searchAndClickFirstHit(container);
  // The first batch of five goes out at once; the other two wait for the gap between batches.
  await rtl.waitFor(() => assert.equal(lookups().length, 5));
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A search hit for a contact the list holds only under privacy ids asks for their phones, five at a time, one second
// apart. The user can leave meanwhile, and what they do then ends the search as it ends the one the New chat panel runs.
test('a search hit stops asking for privacy-id phones when the Chats page is left, and raises no notice on the next page', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Lid 0');
  await clickFirstHit(view.container);

  view.rerender(page(false));
  await settle(1_600);

  assert.equal(lookups().length, 5, 'no lookup follows the first batch once the page is left');
  assert.equal(
    Boolean(rtl.screen.queryByText('The chat of this message could not be found in the list')),
    false,
    'the lookup that outlived the page raised no "not listed" notice on the page that replaced it',
  );
});

test('a search hit stops asking for privacy-id phones when the user opens a chat meanwhile', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Lid 0');
  await clickFirstHit(view.container);

  rtl.fireEvent.click(rtl.screen.getByText('Lid 0'));
  await rtl.waitFor(() => assert.ok(view.container.querySelector('.room-header')));
  await settle(1_600);

  const late = lookups().filter(path => SECOND_BATCH.some(id => path.includes(id)));
  assert.deepEqual(late, [], 'the second batch is not asked for once the user has chosen a chat');
});

// A hit of another session switches to it first and looks its chat up once that session's list has landed, from the
// effect that picks the hit up. The lookup ends with the page there too.
test('a search hit that switched session stops asking for privacy-id phones when the Chats page is left', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  hitSession = OTHER.id;
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Elsewhere');
  await clickFirstHit(view.container);

  view.rerender(page(false));
  await settle(1_600);

  assert.equal(lookups().length, 5, 'no lookup follows the first batch once the page is left');
});

// The same gap in the lookup of a hit that switched session: opening a chat in the new session ends it, as the click of a
// chat in the same session does.
test('a search hit that switched session stops asking for privacy-id phones when the user opens a chat meanwhile', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  hitSession = OTHER.id;
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Elsewhere');
  await clickFirstHit(view.container);

  rtl.fireEvent.click(rtl.screen.getByText('Lid 0'));
  await rtl.waitFor(() => assert.ok(view.container.querySelector('.room-header')));
  await settle(1_600);

  const late = lookups().filter(path => SECOND_BATCH.some(id => path.includes(id)));
  assert.deepEqual(late, [], 'the second batch is not asked for once the user has chosen a chat');
});

// A hit for a session the page does not list as ready waits for a fresh read of the session list. Leaving the page ends
// that wait too: the answer would otherwise tell the page that replaced this one that a session is not connected.
test('a search hit waiting for the session list raises no notice once the Chats page is left', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  hitSession = THIRD.id;
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Elsewhere');
  holdSessions();
  await searchAndClickFirstHit(view.container);

  view.rerender(page(false));
  releaseSessions?.();
  await settle(300);

  assert.equal(
    Boolean(rtl.screen.queryByText('The session of this message is not connected')),
    false,
    'the answer to the session list read raised no notice on the page that replaced Chats',
  );
});

// The same wait can end in a failure to read the session list, which the page answers with an error notice of its own.
test('a search hit whose session list read fails raises no notice once the Chats page is left', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  hitSession = THIRD.id;
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Elsewhere');
  holdSessions();
  await searchAndClickFirstHit(view.container);

  view.rerender(page(false));
  sessionsStatus = 503;
  releaseSessions?.();
  await settle(300);

  assert.equal(
    Boolean(rtl.screen.queryByText('Failed to load sessions')),
    false,
    'the failed session list read raised no notice on the page that replaced Chats',
  );
});

// A chat opened and closed again leaves the open chat as it was, which only the choice itself can tell.
test('a search hit stops asking for privacy-id phones when the user opens a chat and closes it again meanwhile', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const view = rtl.render(page(true));
  await rtl.screen.findByText('Lid 0');
  await clickFirstHit(view.container);

  rtl.fireEvent.click(rtl.screen.getByText('Lid 0'));
  await rtl.waitFor(() => assert.ok(view.container.querySelector('.room-header')));
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Back' }));
  await rtl.waitFor(() => assert.equal(view.container.querySelector('.room-header'), null));
  await settle(1_600);

  const late = lookups().filter(path => SECOND_BATCH.some(id => path.includes(id)));
  assert.deepEqual(late, [], 'the second batch is not asked for once the user has opened and left a chat');
});
