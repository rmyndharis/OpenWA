// The in-chat search takes the place of the open room's header. This file holds the page to what that needs: the
// header comes back with focus on the button that opened the search, Escape closes the search before the room, a
// read-only key is not offered it, and a hit or a day is answered from the rows the thread has drawn: scrolled to
// when one is there, and said to be older than what is loaded when none is.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import type { Chat, ChatMessage, SearchHit, Session } from '../services/api';
import { lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

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

/** Epoch seconds of a local wall-clock time in November 2023, the month every row of this file is in. */
const at = (day: number, hour: number): number => Math.floor(new Date(2023, 10, day, hour).getTime() / 1000);

function row(id: string, seconds: number, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `db-${id}`,
    waMessageId: `wamid.${id}`,
    chatId: ALICE.id,
    from: ALICE.id,
    to: 'me',
    body: `message ${id}`,
    type: 'text',
    direction: 'incoming',
    status: 'delivered',
    timestamp: seconds,
    createdAt: new Date(seconds * 1000).toISOString(),
    ...patch,
  };
}

// The 15th starts with a row the thread does not draw, then one the gateway stored without a WhatsApp time: the
// thread dates that one by when it was stored, and it is the first row under the day's separator.
const THREAD: ChatMessage[] = [
  row('first', at(14, 12), { body: 'hello from alice' }),
  row('undrawn', at(15, 8), { type: 'unknown', body: '' }),
  row('stored', at(15, 9), { timestamp: undefined, body: 'dated by the gateway' }),
  row('later', at(15, 10)),
  row('newest', at(16, 12)),
];
/** A full first page, so the gateway has older rows to give: 100 rows, all on the 16th. */
const FULL_PAGE: ChatMessage[] = Array.from({ length: 100 }, (_, i) => row(`full-${i}`, at(16, 1) + i));

const hitFor = (message: ChatMessage, patch: Partial<SearchHit> = {}): SearchHit => ({
  messageId: message.id,
  waMessageId: message.waMessageId as string,
  sessionId: SESSION.id,
  chatId: message.chatId,
  body: message.body ?? '',
  snippet: message.body ?? '',
  timestamp: message.timestamp ?? 0,
  type: 'text',
  direction: 'incoming',
  from: message.from,
  ...patch,
});
// A row the gateway stored long before the loaded page, which the search still finds.
const OLD_HIT = hitFor(row('old', at(1, 12), { body: 'an old message' }));

const NOT_LOADED = 'Older than the messages loaded in this chat. Scroll up in the chat to load older messages.';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let thread: ChatMessage[] = THREAD;
let hits: SearchHit[] = [];
/** The scroll anchor of every thread row scrolled to, in order. */
const scrolled: string[] = [];
const searches: string[] = [];

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
  Element.prototype.scrollIntoView = function (this: Element) {
    const anchor = this.getAttribute('data-scroll-anchor');
    if (anchor) scrolled.push(anchor);
  };
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json([ALICE, CAROL]));
    if (path.includes('/search?')) {
      searches.push(path);
      return Promise.resolve(json({ hits, total: hits.length, tookMs: 1, provider: 'test' }));
    }
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (/\/profile-picture$/.test(path)) return Promise.resolve(json({ url: null }));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    if (path.includes('/messages?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      // Newest first, as the gateway answers; nothing behind the first page.
      const page = params.get('chatId') === ALICE.id && params.get('offset') === '0' ? [...thread].reverse() : [];
      return Promise.resolve(json({ messages: page, total: page.length }));
    }
    if (/\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(json([]));
    if (path.endsWith('/chats/read')) return Promise.resolve(json({ success: true }));
    return Promise.resolve(json({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key_id', 'test-key');
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
  for (const query of queries) query.destroy();
  queries.clear();
  client = undefined;
  thread = THREAD;
  hits = [];
  scrolled.length = 0;
  searches.length = 0;
});

after(() => {
  window.sessionStorage.clear();
});

async function openAlice(role: 'admin' | 'viewer' = 'admin'): Promise<HTMLElement> {
  const { screen, fireEvent } = rtl;
  window.sessionStorage.setItem('openwa_user_role', role);
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
  const listed = (await screen.findByText('Alice', { selector: '.chat-item-name' })).closest('[role="button"]');
  fireEvent.click(listed as HTMLElement);
  await rtl.waitFor(() => assert.ok(container.querySelector('.room-messages [data-scroll-anchor]')));
  return container;
}

/** Opens Alice's room and its search bar. */
async function openSearch(): Promise<HTMLElement> {
  const container = await openAlice();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Search in chat' }));
  return container;
}

const searchField = () => rtl.screen.getByLabelText('Search') as HTMLInputElement;
const NO_MESSAGE_THAT_DAY = 'No loaded messages on that day';
/** Which of its two notices the bar shows, or null when it shows neither. */
function notice(): string | null {
  const bar = document.querySelector<HTMLElement>('.room-search');
  if (!bar) return null;
  return [NOT_LOADED, NO_MESSAGE_THAT_DAY].find(text => rtl.within(bar).queryAllByText(text).length > 0) ?? null;
}
const pickDay = (day: number) =>
  rtl.fireEvent.change(document.querySelector('.room-search input[type="date"]') as HTMLInputElement, {
    target: { value: `2023-11-${String(day).padStart(2, '0')}` },
  });

/** What holds focus, by role and name: never two DOM nodes compared. */
function focused(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return 'the page';
  return `${active.getAttribute('role') ?? active.tagName.toLowerCase()} "${(active.getAttribute('aria-label') ?? active.getAttribute('placeholder') ?? active.textContent ?? '').trim().slice(0, 40)}"`;
}

test('the search button puts the search bar in place of the room header, and Back returns the header and the focus', async () => {
  const { screen, fireEvent } = rtl;
  const container = await openSearch();
  assert.ok(container.querySelector('.room-header .room-search'));
  assert.equal(focused(), 'combobox "Search"');
  assert.ok(screen.queryByRole('button', { name: 'More actions' }) === null, 'the header was drawn beside the bar');

  const back = screen.getByRole('button', { name: 'Back' });
  back.focus();
  fireEvent.click(back);
  assert.ok(container.querySelector('.room-search') === null);
  assert.ok(screen.getByRole('button', { name: 'More actions' }));
  assert.ok(container.querySelector('.room-container'), 'closing the search closed the room');
  assert.equal(focused(), 'button "Search in chat"');
});

test('Escape in the search bar closes the search, keeps the room, and returns focus to the search button', async () => {
  const container = await openSearch();
  rtl.fireEvent.keyDown(searchField(), { key: 'Escape' });
  assert.ok(container.querySelector('.room-search') === null);
  assert.ok(container.querySelector('.room-container'), 'the room closed with the search');
  assert.equal(focused(), 'button "Search in chat"');
});

test('Escape from the composer closes the search first, and the room only on the next press', async () => {
  const { screen, fireEvent } = rtl;
  const container = await openSearch();
  const composer = screen.getByPlaceholderText('Type a message...');
  composer.focus();
  fireEvent.keyDown(composer, { key: 'Escape' });
  assert.ok(container.querySelector('.room-search') === null, 'the search stayed open');
  assert.ok(container.querySelector('.room-container'), 'the whole conversation closed, not the search');
  // The composer is still there and held focus, so focus is not taken from it.
  assert.equal(focused(), 'textarea "Type a message..."');

  fireEvent.keyDown(composer, { key: 'Escape' });
  await rtl.waitFor(() => assert.ok(container.querySelector('.room-container') === null));
});

test('a read-only key is not offered the in-chat search', async () => {
  await openAlice('viewer');
  assert.ok(rtl.screen.getByRole('button', { name: 'More actions' }), 'the room header is not drawn');
  assert.ok(rtl.screen.queryByRole('button', { name: 'Search in chat' }) === null);
});

test('a hit among the loaded messages scrolls the thread to it and keeps the bar, its query and its hits', async () => {
  const { screen, fireEvent } = rtl;
  hits = [hitFor(THREAD[0]), OLD_HIT];
  const container = await openSearch();
  fireEvent.change(searchField(), { target: { value: 'message' } });
  const options = await screen.findAllByRole('option');
  assert.match(searches[0], /chatId=15550001111%40c\.us/);

  fireEvent.click(options[0]);
  assert.ok(container.querySelector('.room-search'), 'picking a hit closed the search');
  assert.deepEqual(scrolled, ['db-first']);
  assert.equal(searchField().value, 'message');
  assert.ok(screen.queryByRole('option') === null, 'the list stayed over the message');
  assert.equal(notice(), null);

  fireEvent.click(searchField());
  assert.equal(screen.getAllByRole('option').length, 2);
  assert.equal(searches.length, 1, 'the hits were fetched again');
});

test('a hit stored under another form of the chat id is scrolled to without asking the chat list for its chat', async () => {
  const { screen, fireEvent } = rtl;
  // The search returns the open chat's rows under every form they were stored with, a privacy id included, and
  // the chat list holds this chat under its phone form only.
  hits = [hitFor(THREAD[0], { chatId: '99887766554433@lid' })];
  await openSearch();
  fireEvent.change(searchField(), { target: { value: 'message' } });
  fireEvent.click(await screen.findByRole('option'));
  await rtl.waitFor(() => assert.deepEqual(scrolled, ['db-first']));
  assert.ok(screen.queryByText('The chat of this message could not be found in the list') === null);
});

test('a hit older than the loaded messages keeps the bar and the list and says scrolling up loads older ones', async () => {
  const { screen, fireEvent } = rtl;
  hits = [hitFor(THREAD[0]), OLD_HIT];
  const container = await openSearch();
  fireEvent.change(searchField(), { target: { value: 'message' } });
  const options = await screen.findAllByRole('option');

  fireEvent.click(options[1]);
  assert.deepEqual(scrolled, []);
  assert.equal(notice(), NOT_LOADED);
  assert.ok(container.querySelector('.room-search'), 'the search closed on a hit it could not show');
  assert.equal(screen.getAllByRole('option').length, 2);
  assert.equal(searchField().value, 'message');
});

test('a day jumps to the first row the thread draws under that day, dated as the thread dates it', async () => {
  await openSearch();
  pickDay(15);
  // Not the undrawn row before it, and not the later row that carries a WhatsApp time.
  assert.deepEqual(scrolled, ['db-stored']);
  assert.equal(notice(), null);
  assert.equal(searches.length, 0);
});

test('a day with no message among the loaded ones says so when there is nothing older to load', async () => {
  await openSearch();
  pickDay(1);
  assert.deepEqual(scrolled, []);
  assert.equal(notice(), NO_MESSAGE_THAT_DAY);
});

test('a day further back than a full loaded page says scrolling up loads older messages', async () => {
  thread = FULL_PAGE;
  await openSearch();
  pickDay(1);
  assert.deepEqual(scrolled, []);
  assert.equal(notice(), NOT_LOADED);
  // A later day than everything loaded is not older, whatever the gateway still holds.
  pickDay(20);
  assert.equal(notice(), NO_MESSAGE_THAT_DAY);
});

test('a message that arrives while a day is selected does not scroll the thread back to that day', async () => {
  const { act, within } = rtl;
  const container = await openSearch();
  pickDay(14);
  assert.deepEqual(scrolled, ['db-first']);

  act(() => {
    lastSocket()?.receive('message', {
      type: 'event',
      timestamp: new Date().toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION.id,
        data: {
          id: 'wamid.live',
          chatId: ALICE.id,
          from: ALICE.id,
          to: 'me',
          body: 'a reply while reading',
          type: 'text',
          fromMe: false,
          timestamp: at(17, 9),
        },
      },
    });
  });
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('a reply while reading');
  assert.deepEqual(scrolled, ['db-first'], 'the reader was pulled back to the day by a thread update');
});

test('opening another chat closes the search, and the new room starts without it', async () => {
  const { screen, fireEvent } = rtl;
  const container = await openSearch();
  fireEvent.change(searchField(), { target: { value: 'message' } });
  const carol = screen.getByText('Carol', { selector: '.chat-item-name' }).closest<HTMLElement>('[role="button"]')!;
  fireEvent.click(carol);
  await screen.findByRole('heading', { name: 'Carol' });
  assert.ok(container.querySelector('.room-search') === null);
  assert.ok(screen.getByRole('button', { name: 'Search in chat' }));
});

test('closing the contact panel while searching leaves focus in the search field', async () => {
  const { screen, fireEvent, within } = rtl;
  const container = await openAlice();
  fireEvent.click(screen.getByRole('button', { name: 'Contact info' }));
  fireEvent.click(screen.getByRole('button', { name: 'Search in chat' }));
  const close = within(container.querySelector('.contact-info-panel') as HTMLElement).getByRole('button', {
    name: 'Close',
  });
  close.focus();
  fireEvent.click(close);
  assert.ok(container.querySelector('.contact-info-panel') === null);
  assert.equal(focused(), 'combobox "Search"');
});
