// Render smoke test for the Chats page under the bare `node --test` runner (no vitest/jest).
// It exists to catch the classic god-component extraction bugs: a missing prop that crashes the
// render, or a lost provider (QueryClient / Role / Toast / i18n). The page is wrapped in the
// same providers App.tsx uses (QueryClientProvider → RoleProvider → ToastProvider; i18n via the
// side-effect import; Chats uses no router hooks, so no Router is needed) and the backend is
// stubbed at the fetch layer with canned JSON for every endpoint the page hits on mount,
// on chat open, on send, and on status-compose. Every stubbed request is recorded so tests can
// assert the wire effect (POST body) of a UI action, not just its optimistic DOM echo.
//
// Runner constraints honored here: plain .ts with React.createElement (the runner cannot parse
// JSX), loader hooks registered before any app-module import (see test-helpers/register-hooks),
// and JSDOM installed before importing modules that read `window` at import time.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, Chat, ChatMessage, SearchHit, Channel, ChannelMessage, StatusUpdate } from '../services/api';
import { MENTION_CLOSE, MENTION_OPEN } from '../utils/messageFormatter.ts';
import { MEDIA_PAYLOAD_CACHE_LIMIT } from '../utils/chatMessages.ts';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
// socket.io-client resolves to a double under this runner (see vite-shim-hooks.mjs), which is what
// lets a test deliver a server frame to the page's realtime handlers.
import { holdConnect, lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A second session, served only when a test turns `twoSessions` on. Its routes answer with the first
// session's fixtures (see installFetchStub), so a test can switch sessions without a second data set.
const SESSION_2: Session = { ...SESSION, id: 'session-2', name: 'Second', phone: '15559876543' };
let twoSessions = false;

// A third session the gateway lists but that the page may not offer, with the status the list reports.
// Its routes answer with the first session's fixtures, like session-2's.
const SESSION_3: Session = { ...SESSION, id: 'session-3', name: 'Third', phone: '15550004444' };
let thirdSessionStatus: Session['status'] | null = null;

// When set, the session list answers this status with a gateway-style error body until a test clears it.
let sessionListStatus: number | null = null;

// Hits the global search answers with.
let searchHits: SearchHit[] = [];
// The phone the gateway resolves a privacy id to, by id; an id it knows nothing about answers null.
const lidPhones: Record<string, string> = {};

// The engine the gateway reports: only whatsapp-web.js lists channels.
let engineType = 'baileys';
// The subscribed channels, the posts every channel's feed answers with, and the stored statuses.
let channels: Channel[] = [];
let channelPosts: ChannelMessage[] = [];
let statuses: StatusUpdate[] = [];

// Answers a session's chat list in place of the fixture, keyed by the session id in the URL (before
// the rewrite below folds session-2 onto session-1), so a test can land two lists in any order.
let chatsResponder: ((sessionId: string, offset: number, signal?: AbortSignal | null) => Promise<Response>) | null =
  null;

const CHAT: Chat = {
  id: '15550001111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 2,
  timestamp: 1_700_000_000,
  lastMessage: 'hello from alice',
  archived: false,
  pinned: false,
  muted: false,
};

// A second conversation, so the attachment tests can distinguish "closed and reopened the SAME
// room" (staged file survives) from "moved to ANOTHER chat" (staged file is dropped). Named to
// avoid colliding with CONTACT below, which the status-compose test matches by name.
const CHAT_2: Chat = {
  id: '15550003333@c.us',
  name: 'Carol',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_050,
  lastMessage: 'hello from carol',
  archived: false,
  pinned: false,
  muted: false,
};

const DB_MESSAGE: ChatMessage = {
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: 'hello from alice',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

// A row whose media the server did not inline: past MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES the
// message list replaces the payload with this marker, so the bubble has no bytes to render and the
// per-message media route is the only way to reach them.
const OMITTED_MEDIA_MESSAGE: ChatMessage = {
  id: 'db-2',
  waMessageId: 'wamid.2',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: '',
  type: 'image',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_001,
  createdAt: new Date(1_700_000_001_000).toISOString(),
  metadata: { media: { mimetype: 'image/jpeg', filename: 'photo.jpg', omitted: true, sizeBytes: 9_000_000 } },
};

// A second one, so a test can have two downloads open at once and check they do not share state.
const OMITTED_MEDIA_MESSAGE_2: ChatMessage = {
  ...OMITTED_MEDIA_MESSAGE,
  id: 'db-3',
  waMessageId: 'wamid.3',
  timestamp: 1_700_000_002,
  createdAt: new Date(1_700_000_002_000).toISOString(),
  metadata: { media: { mimetype: 'image/jpeg', filename: 'photo-2.jpg', omitted: true, sizeBytes: 9_000_000 } },
};

// Carol's thread is long enough to page: a full first page, then a short older one that ends it.
// Each row's body carries its index so a test can name the exact bubble a given page brought in.
const PAGE_SIZE = 100;

const pagedRow = (index: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `paged-${index}`,
  waMessageId: `wamid.paged.${index}`,
  chatId: CHAT_2.id,
  from: CHAT_2.id,
  to: 'me',
  body: `paged message ${index}`,
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_001_000 + index,
  createdAt: new Date((1_700_001_000 + index) * 1000).toISOString(),
  ...extra,
});

// Newest first, the order the gateway returns (createdAt DESC): 119 down to 20 on the first page,
// 19 down to 0 on the second. The second is short, which is what ends the paging. Row 0 is ours and
// unacked, so the ack test has a delivery tick to watch on a row only the oldest page holds.
const PAGED_NEWEST = Array.from({ length: PAGE_SIZE }, (_, i) => pagedRow(119 - i));
const PAGED_OLDEST = Array.from({ length: 20 }, (_, i) =>
  i === 19 ? pagedRow(0, { direction: 'outgoing', from: 'me', to: CHAT_2.id, status: 'sent' }) : pagedRow(19 - i),
);

// Hold the older page open so the spinner commit and the landing commit stay distinct.
let olderPageGate: Promise<void> | null = null;
// When true, an older-page request (any offset but 0) answers 500 instead of a page.
let olderPageFails = false;
// Rows Carol's older page serves after the fixture rows (oldest last, as the gateway orders them).
let olderPageExtra: ChatMessage[] = [];

function holdOlderPage(): () => void {
  let release!: () => void;
  olderPageGate = new Promise<void>(resolve => {
    release = resolve;
  });
  return release;
}

// Hold a text send open, so a test can land it at a chosen moment relative to an older-page fetch.
let sendGate: Promise<void> | null = null;

// Hold Alice's first page open, so a test can write to the thread before it has any data.
let firstPageGate: Promise<void> | null = null;

// Rows Alice's first page serves after the fixture rows, so a test can put its own message in the thread.
let firstPageExtra: ChatMessage[] = [];

// The id a text send answers with. whatsapp-web.js answers '' when it cannot read the sent id back.
let sendTextId = 'wamid.out.1';
// The id an image send answers with; '' as whatsapp-web.js answers when it cannot read the sent id back.
let sendImageId = 'wamid.out.image';
// Set by a test whose image send the gateway refuses.
let sendImageFails = false;

function holdSend(): () => void {
  let release!: () => void;
  sendGate = new Promise<void>(resolve => {
    release = resolve;
  });
  return release;
}

/** The messages route for one page of Carol's thread, as the api client spells it. */
const pagedMessagesPath = (offset: number): string =>
  `/api/sessions/${SESSION.id}/messages?chatId=${encodeURIComponent(CHAT_2.id)}&limit=${PAGE_SIZE}&offset=${offset}`;

/**
 * Every fetch to Carol's paged route, at ANY offset. A count against one hardcoded offset (as
 * `pagedMessagesPath` builds) proves nothing about a request at some OTHER offset — a termination
 * rule that compares rows-held against a frozen total, instead of the short-page signal, would ask
 * for offset 120 here (PAGE_SIZE + PAGED_OLDEST.length), which a check against, say, `2 * PAGE_SIZE`
 * would silently miss.
 */
function countPagedMessagesFetches(): number {
  const prefix = `/api/sessions/${SESSION.id}/messages?chatId=${encodeURIComponent(CHAT_2.id)}&limit=${PAGE_SIZE}&offset=`;
  return fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(prefix)).length;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** The per-message media route the omitted marker sends the viewer to. */
const mediaPathFor = (waMessageId: string): string =>
  `/api/sessions/${SESSION.id}/messages/${encodeURIComponent(CHAT.id)}/${encodeURIComponent(waMessageId)}/media`;
const MEDIA_PATH = mediaPathFor(OMITTED_MEDIA_MESSAGE.waMessageId as string);
const MEDIA_PATH_2 = mediaPathFor(OMITTED_MEDIA_MESSAGE_2.waMessageId as string);

// A media response can be held open, so a test can have two downloads in flight and settle them out
// of order — the shape in which one fetch's completion can clobber another's state.
const mediaGates = new Map<string, Promise<void>>();

/** Hold the media response for `path` until the returned release function is called. */
function holdMedia(path: string): () => void {
  let release!: () => void;
  mediaGates.set(
    path,
    new Promise<void>(resolve => {
      release = resolve;
    }),
  );
  return release;
}

// Contact for the status-compose recipient picker (Baileys requires an explicit allow-list).
const CONTACT = { id: '15550002222@c.us', name: 'Bob', number: '15550002222' };
const STATUS_TEXT = 'status text here';
const CHANNEL = { id: '120363000000000001@newsletter', name: 'Release notes' };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Every request the stub serves is recorded (method, path, parsed JSON body) so tests can assert
// the WIRE effect of a UI action — an optimistic bubble alone would pass even if the POST broke.
interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];

function resetFetchCalls(): void {
  fetchCalls.length = 0;
}

function findFetchCall(method: string, path: string): FetchCall | undefined {
  return fetchCalls.find(c => c.method === method && c.path === path);
}

function countFetchCalls(method: string, path: string): number {
  return fetchCalls.filter(c => c.method === method && c.path === path).length;
}

// URL router for every endpoint the page (and the hooks/components under it) can hit during the
// smoke flows below. Anything else gets a 404 so an unexpected request fails loudly in the test
// output instead of resolving into a confusing downstream crash.
function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(new RegExp(`/api/sessions/(${SESSION_2.id}|${SESSION_3.id})/`), `/api/sessions/${SESSION.id}/`);

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ method, path, body });

    if (method === 'GET' && path === '/api/sessions') {
      if (sessionListStatus) return Promise.resolve(jsonResponse({ message: 'Bad Gateway' }, sessionListStatus));
      const listed = twoSessions ? [SESSION, SESSION_2] : [SESSION];
      if (thirdSessionStatus) listed.push({ ...SESSION_3, status: thirdSessionStatus });
      return Promise.resolve(jsonResponse(listed));
    }
    // ADMIN-only on the server, so any other role gets the 403 a real gateway answers.
    if (method === 'GET' && path === '/api/infra/engines/current') {
      if (window.sessionStorage.getItem('openwa_user_role') !== 'admin') {
        return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: admin' }, 403));
      }
      return Promise.resolve(jsonResponse({ engineType }));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/channels/`)) {
      return Promise.resolve(jsonResponse(channelPosts));
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/channels`) {
      return Promise.resolve(jsonResponse(channels));
    }
    if (method === 'GET' && /^\/api\/sessions\/[^/]+\/chats(?:\?|$)/.test(path)) {
      if (chatsResponder)
        return chatsResponder(
          url.includes(`/sessions/${SESSION_2.id}/`) ? SESSION_2.id : SESSION.id,
          Number(new URL(url, 'http://localhost').searchParams.get('offset')),
          init?.signal,
        );
      return Promise.resolve(jsonResponse([CHAT, CHAT_2]));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    // Matched for any chat id (both CHAT and CHAT_2 open in these tests), not just the first.
    if (method === 'GET' && /\/contacts\/[^/]+\/profile-picture$/.test(path)) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/contacts?`)) {
      return Promise.resolve(jsonResponse([CONTACT]));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/messages?`)) {
      const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      if (query.get('chatId') === CHAT_2.id) {
        const isFirstPage = Number(query.get('offset')) === 0;
        if (!isFirstPage && olderPageFails) return Promise.resolve(jsonResponse({ message: 'boom' }, 500));
        const messages = isFirstPage ? PAGED_NEWEST : [...PAGED_OLDEST, ...olderPageExtra];
        // `total` deliberately does NOT equal the 120 rows actually served (PAGED_NEWEST.length +
        // PAGED_OLDEST.length). The current termination rule never reads this field — it stops on a
        // page short of what it asked for — so the value doesn't matter to it either way. It matters
        // to the TEST: a `total` that happened to equal the served row count let a reverted, WRONG
        // rule (`rows held >= total`) terminate correctly by coincidence, so the "pulls exactly one
        // older page, then stops" assertion below could not tell a working implementation from a
        // broken one. Set far above what is served, that coincidence is gone.
        const answer = () => jsonResponse({ messages, total: 500 });
        const gate = isFirstPage ? null : olderPageGate;
        return gate ? gate.then(answer) : Promise.resolve(answer());
      }
      const firstPage = () =>
        jsonResponse({
          messages: [DB_MESSAGE, OMITTED_MEDIA_MESSAGE, OMITTED_MEDIA_MESSAGE_2, ...firstPageExtra],
          total: 3 + firstPageExtra.length,
        });
      return firstPageGate ? firstPageGate.then(firstPage) : Promise.resolve(firstPage());
    }
    // The media route answers bytes, not JSON — Content-Disposition: attachment.
    if (method === 'GET' && (path === MEDIA_PATH || path === MEDIA_PATH_2)) {
      const bytes = () => new Response(new Blob(['jpeg-bytes']), { status: 200 });
      const gate = mediaGates.get(path);
      return gate ? gate.then(bytes) : Promise.resolve(bytes());
    }
    if (method === 'GET' && /\/messages\/[^/]+\/history/.test(path)) {
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/status`) {
      return Promise.resolve(jsonResponse({ statuses }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/chats/read`) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-text`) {
      const send = () => jsonResponse({ messageId: sendTextId, timestamp: 1_700_000_100 });
      return sendGate ? sendGate.then(send) : Promise.resolve(send());
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-audio`) {
      return Promise.resolve(jsonResponse({ messageId: 'wamid.out.audio', timestamp: 1_700_000_100 }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-image`) {
      const send = () =>
        sendImageFails
          ? jsonResponse({ message: 'boom' }, 500)
          : jsonResponse({ messageId: sendImageId, timestamp: 1_700_000_100 });
      return sendGate ? sendGate.then(send) : Promise.resolve(send());
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-document`) {
      return Promise.resolve(jsonResponse({ messageId: 'wamid.out.document', timestamp: 1_700_000_100 }));
    }
    if (method === 'GET' && path.startsWith('/api/search?')) {
      return Promise.resolve(jsonResponse({ hits: searchHits, total: searchHits.length }));
    }
    if (method === 'GET' && /\/contacts\/[^/]+\/phone$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/phone')[0]);
      return Promise.resolve(jsonResponse({ contactId: id, phone: lidPhones[id] ?? null }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/status/send-text`) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── Harness bootstrap ────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type ChatsModule = typeof import('./Chats.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let Chats: ChatsModule['Chats'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // RoleProvider initializes from sessionStorage; 'admin' makes canWrite true so the composer
  // controls render enabled.
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  // The engine POST /auth/validate reported at sign-in, kept next to the role.
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  // useWebSocket.connect() bails without this, so no socket would exist to receive a frame. It
  // dials nothing: the client is the double above.
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  // The real i18n instance, and then its readiness promise: catalogues are fetched rather than
  // bundled, so importing the module only STARTS the load. Every `getByText` below is English copy
  // out of en.json, which renders as a raw key until it lands. Awaiting is what makes that
  // deterministic — without it the assertions race the load and win only because the module imports
  // that follow take longer than reading one JSON file.
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(async () => {
  // A test that failed while it held the retry pauses on a fake clock must not leave it to the next one.
  mock.timers.reset();
  rtl.cleanup();
  resetSocketDouble();
  // Cancel before clearing. clear() silently cancels a fetch still in flight, and that fetch's finally
  // then re-arms the gc timer of the query clear() just dropped, where nothing can clear it. The avatar
  // hooks set a 30 minute gcTime and the message thread 5 minutes, so one such timer held the test
  // process open for half an hour on CI.
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = undefined;
  // A gate left held would stall the next test's fetch forever.
  mediaGates.clear();
  olderPageGate = null;
  sendGate = null;
  firstPageGate = null;
  firstPageExtra = [];
  sendTextId = 'wamid.out.1';
  sendImageId = 'wamid.out.image';
  sendImageFails = false;
  olderPageFails = false;
  olderPageExtra = [];
  chatsResponder = null;
  for (const id of Object.keys(lidPhones)) delete lidPhones[id];
  thirdSessionStatus = null;
  sessionListStatus = null;
  searchHits = [];
  engineType = 'baileys';
  channels = [CHANNEL];
  channelPosts = [];
  statuses = [];
});

function renderChats(): ReturnType<RTL['render']> {
  // The avatar and message hooks set their own gcTime over this 1s default; afterEach cancels before it
  // clears so their timers cannot hold the test process open.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
}

/**
 * The session switcher: its trigger names the selected session, and its list picks another. Sessions are
 * told apart by name, which every fixture session has its own of.
 */
const FIXTURE_SESSIONS = [SESSION, SESSION_2, SESSION_3];

function selectSession(container: HTMLElement, id: string): void {
  const { fireEvent, within } = rtl;
  const name = FIXTURE_SESSIONS.find(s => s.id === id)!.name;
  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const list = container.querySelector('[role="listbox"]') as HTMLElement;
  fireEvent.click(within(list).getByRole('option', { name: new RegExp(name) }));
}

function selectedSessionId(container: HTMLElement): string | undefined {
  const name = container.querySelector('.session-switcher-btn .session-name')?.textContent;
  return FIXTURE_SESSIONS.find(s => s.name === name)?.id;
}

/** The message search sits behind a toggle in the sidebar header; open it unless it already is. */
function openMessageSearch(): void {
  const { screen, fireEvent } = rtl;
  if (!screen.queryByLabelText('Search messages…')) {
    fireEvent.click(screen.getByRole('button', { name: 'Search messages' }));
  }
}

// ── Smoke tests ──────────────────────────────────────────────────────────────

test('Chats renders: session/chat list loads, a chat opens, and a message sends', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  // Sidebar: the session selector shows the stubbed ready session, and the chat list row
  // appears once /sessions and /sessions/:id/chats have resolved.
  await screen.findByText(SESSION.name);
  const chatRow = await screen.findByText('Alice');

  // Open the chat: the message thread renders the stubbed DB message (both the DB and the
  // engine-history fetches went through the stub). Scoped to the thread container: the sidebar
  // snippet carries the same lastMessage text, so an unscoped query is a timing coin-flip.
  fireEvent.click(chatRow);
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  // Composer: the send button (aria-label = chats.send) and message input are the stable markers.
  const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  assert.equal(sendButton.disabled, true); // empty input → disabled

  // Type and send: the optimistic bubble appears, then reconciles with the stubbed response
  // (scoped again — the send also promotes the sidebar row to the same snippet text).
  fireEvent.change(input, { target: { value: 'hello back' } });
  assert.equal(sendButton.disabled, false);
  fireEvent.click(sendButton);
  await within(thread).findByText('hello back');

  // The optimistic bubble alone would pass even if the POST never fired — assert the wire call.
  await waitFor(() => {
    const call = findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-text`);
    assert.ok(call, 'expected a POST to the send-text endpoint');
    assert.deepEqual(call.body, { chatId: CHAT.id, text: 'hello back' });
  });
});

test('status compose modal posts a text status with the baileys recipient allow-list', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  renderChats();

  // The compose trigger lives in the sidebar's Status tab. The engine stub answers 'baileys',
  // so the modal enables its contacts query and requires an explicit recipient allow-list.
  await screen.findByText(SESSION.name);
  fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
  fireEvent.click(screen.getByRole('button', { name: 'Post a status' }));

  const dialog = await screen.findByRole('dialog');
  // Text status body (the textarea's placeholder is chats.status.composeText).
  fireEvent.change(within(dialog).getByPlaceholderText('Text'), { target: { value: STATUS_TEXT } });
  // Pick the stubbed contact once the contacts query resolves.
  await within(dialog).findByText('Bob');
  fireEvent.click(within(dialog).getByRole('checkbox'));

  const postButton = within(dialog).getByRole('button', { name: 'Post' }) as HTMLButtonElement;
  assert.equal(postButton.disabled, false); // text + recipient + known engine → submittable
  fireEvent.click(postButton);

  // The wire call: POST status/send-text with the text and the selected allow-list
  // (backgroundColor/font are dropped from the body while unset).
  await waitFor(() => {
    const call = findFetchCall('POST', `/api/sessions/${SESSION.id}/status/send-text`);
    assert.ok(call, 'expected a POST to the status send-text endpoint');
    assert.deepEqual(call.body, { text: STATUS_TEXT, recipients: [CONTACT.id] });
  });

  // Success path: the modal closes and onPosted refetches the status list (one GET from the
  // tab switch, one from the refetch).
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
  await waitFor(() => {
    assert.ok(
      countFetchCalls('GET', `/api/sessions/${SESSION.id}/status`) >= 2,
      'expected the status list to refetch after posting',
    );
  });
});

test('Refresh on a feed that never connected refetches the open thread once the socket is back', async () => {
  const { screen, fireEvent, within, waitFor, act } = rtl;
  resetFetchCalls();
  holdConnect();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  const threadReads = (): number =>
    fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(`/api/sessions/${SESSION.id}/messages?`)).length;
  const readsBeforeRetry = threadReads();

  // A rejected handshake delivers its connect and the server's close in one batch, so this socket
  // never renders as connected, and the thread misses whatever arrives while the banner is up.
  const rejected = lastSocket();
  assert.ok(rejected, 'expected the page to have opened a socket');
  act(() => {
    rejected.receive('connect');
    rejected.receive('disconnect', 'io server disconnect');
  });
  const banner = await screen.findByRole('alert');
  fireEvent.click(within(banner).getByRole('button', { name: 'Refresh' }));
  const redialed = lastSocket();
  assert.ok(redialed && redialed !== rejected, 'expected Refresh to open a fresh socket');
  act(() => redialed.receive('connect'));

  await waitFor(() => assert.equal(threadReads(), readsBeforeRetry + 1));
});

test('a typed draft survives closing and reopening the room', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  // Open the chat and type (but do NOT send) a draft.
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'draft survives' } });

  // Close the room with the back button (aria-label = common.back); the composer unmounts.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  assert.equal(screen.queryByRole('button', { name: 'Back' }) === null, true);

  // Reopen the same chat (room closed → 'Alice' matches only the sidebar row): the draft must
  // still be in the input — the page owns messageInput precisely so it survives this round trip.
  fireEvent.click(screen.getByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  assert.equal(input.value, 'draft survives');
});

// A draft is the chat's, like a staged file or reply: carried into another chat, the next Enter would deliver it to
// the wrong recipient. It is kept for the chat it was typed in, so looking at another one loses nothing.
test('a typed draft stays with its chat: another chat opens with its own, and the first gets it back', async () => {
  const { screen, fireEvent, within } = rtl;
  const { container } = renderChats();
  const composer = () => screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  const open = async (name: string) => {
    fireEvent.click(within(container.querySelector('.chats-sidebar') as HTMLElement).getByText(name));
    await within(container.querySelector('.room-header') as HTMLElement).findByText(name);
  };

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  fireEvent.change(composer(), { target: { value: 'for alice' } });

  await open('Carol');
  assert.equal(composer().value, '', "Alice's draft followed the user into Carol's room");
  fireEvent.change(composer(), { target: { value: 'for carol' } });

  await open('Alice');
  assert.equal(composer().value, 'for alice');
  // Closing the room in between keeps the draft of the chat that was open, as closing and reopening it does.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await open('Carol');
  assert.equal(composer().value, 'for carol');
});

test('a typed draft stays with its session: the same chat on another account opens without it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  try {
    resetFetchCalls();
    const { container } = renderChats();
    const composer = () => screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
    const openAlice = async () => {
      fireEvent.click(await within(container.querySelector('.chats-sidebar') as HTMLElement).findByText('Alice'));
      await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
    };

    await screen.findByText(SESSION.name);
    await openAlice();
    fireEvent.change(composer(), { target: { value: 'from session one' } });

    // Session 2 lists a chat with Alice's id (a contact both accounts share).
    selectSession(container, SESSION_2.id);
    await waitFor(() => assert.equal(container.querySelector('.room-header') === null, true));
    await openAlice();
    assert.equal(composer().value, '', 'the draft followed the user into the other session');
    fireEvent.submit(container.querySelector('.input-form') as HTMLFormElement);
    assert.equal(
      countFetchCalls('POST', `/api/sessions/${SESSION.id}/messages/send-text`),
      0,
      'the draft was sent from the other session',
    );

    selectSession(container, SESSION.id);
    await waitFor(() => assert.equal(container.querySelector('.room-header') === null, true));
    await openAlice();
    assert.equal(composer().value, 'from session one');
  } finally {
    twoSessions = false;
  }
});

test('Escape dismisses the emoji picker instead of the conversation behind it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  fireEvent.click(screen.getByTitle('Pick emoji'));
  await waitFor(() => assert.ok(container.querySelector('.chats-emoji-picker'), 'the emoji picker did not open'));

  fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 });
  assert.ok(container.querySelector('.chats-emoji-picker'), 'an Escape the input method processed closed the picker');
  assert.ok(screen.queryByRole('button', { name: 'Back' }), 'an Escape the input method processed closed the room');

  // Driven from document, which is where a real Escape lands: focus is on the toggle button, not
  // inside the picker, so a handler bound to the picker element would never see this event. One
  // press must do both things, dismiss the picker and leave the conversation open.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    assert.equal(container.querySelector('.chats-emoji-picker') === null, true, 'the picker stayed open'),
  );
  assert.ok(screen.queryByRole('button', { name: 'Back' }), 'Escape closed the room while the picker owned it');

  // With the picker gone the key belongs to the room again, which is what it must not keep.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    assert.equal(screen.queryByRole('button', { name: 'Back' }) === null, true, 'the room stayed open'),
  );
});

test('the emoji picker yields Escape to a surface layered above it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  fireEvent.click(screen.getByTitle('Pick emoji'));
  await waitFor(() => assert.ok(container.querySelector('.chats-emoji-picker'), 'the emoji picker did not open'));

  // The media viewer and the language menu render their own role while open, and the picker can
  // still be open underneath. Taking the key there would dismiss the thing the operator is not
  // looking at. Stand one in rather than driving the viewer, which lives in a third-party portal.
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  document.body.appendChild(overlay);
  try {
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      assert.ok(container.querySelector('.chats-emoji-picker'), 'the picker took a key it does not own'),
    );
    assert.ok(screen.queryByRole('button', { name: 'Back' }), 'the room closed under the overlay');
  } finally {
    overlay.remove();
  }

  // And once that surface is gone the picker answers again.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    assert.equal(container.querySelector('.chats-emoji-picker') === null, true, 'the picker stayed open'),
  );
});

test('Escape closes the open room, and is left alone while a dialog owns it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  // A modal owns Escape while it is open: the room must survive it, or closing a dialog would also
  // throw away the conversation behind it.
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(screen.queryByRole('button', { name: 'Back' }), 'Escape closed the room while a dialog was open');

  dialog.remove();
  fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 });
  assert.ok(screen.queryByRole('button', { name: 'Back' }), 'an Escape the input method processed closed the room');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    assert.equal(screen.queryByRole('button', { name: 'Back' }) === null, true, 'Escape did not close the room'),
  );
});

test('Escape dismisses the message search results instead of the conversation behind them', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  openMessageSearch();
  const search = container.querySelector('.global-search-input') as HTMLInputElement;
  search.focus();
  fireEvent.change(search, { target: { value: 'invoice' } });
  await screen.findByRole('listbox');

  fireEvent.keyDown(search, { key: 'Escape' });
  // assert.ok, not assert.equal(node, null): formatting a live jsdom node into the failure message spins.
  assert.ok(!screen.queryByRole('listbox'), 'Escape left the search results open');
  assert.ok(screen.queryByRole('button', { name: 'Back' }), 'Escape closed the room while the results owned it');

  fireEvent.keyDown(search, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('button', { name: 'Back' }), 'Escape did not close the room'));
});

test('a read-only key is offered no status compose trigger', async () => {
  const { screen, fireEvent } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  try {
    renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
    // Reading statuses stays open to a viewer; only posting one is withheld.
    await screen.findByText('No contacts have an active status.');
    assert.ok(!screen.queryByRole('button', { name: 'Post a status' }), 'a viewer key was offered status compose');
  } finally {
    window.sessionStorage.setItem('openwa_user_role', 'admin');
  }
});

// GET /search needs an operator key, so a viewer would only ever get "Search failed. Try again."
test('a read-only key is offered no message search', async () => {
  const { screen } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  try {
    renderChats();
    await screen.findByText('Alice');
    assert.ok(!screen.queryByLabelText('Search messages…'), 'a viewer key was offered message search');
  } finally {
    window.sessionStorage.setItem('openwa_user_role', 'admin');
  }
});

test('an operator key on whatsapp-web.js posts a status without the admin-only engine route', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  try {
    resetFetchCalls();
    renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post a status' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Text'), { target: { value: STATUS_TEXT } });
    const postButton = within(dialog).getByRole('button', { name: 'Post' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(postButton.disabled, false, 'Post never enabled for an operator key'));
    // whatsapp-web.js has no recipient list, so the picker stays hidden and none are sent.
    assert.equal(within(dialog).queryByRole('checkbox') === null, true);
    fireEvent.click(postButton);

    await waitFor(() => {
      const call = findFetchCall('POST', `/api/sessions/${SESSION.id}/status/send-text`);
      assert.ok(call, 'expected a POST to the status send-text endpoint');
      assert.deepEqual(call.body, { text: STATUS_TEXT });
    });
    assert.equal(countFetchCalls('GET', '/api/infra/engines/current'), 0);
  } finally {
    window.sessionStorage.setItem('openwa_user_role', 'admin');
    window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  }
});

test('an operator key on whatsapp-web.js lists its channels', async () => {
  const { screen, fireEvent } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  try {
    renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
    await screen.findByText(CHANNEL.name);
    assert.equal(screen.queryByText('Channels are not supported on the Baileys engine.') === null, true);
  } finally {
    window.sessionStorage.setItem('openwa_user_role', 'admin');
    window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  }
});

test('a writer key opening a chat clears its unread badge', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const { container } = renderChats();
  await screen.findByText(SESSION.name);
  assert.ok(await screen.findByLabelText('2 unread messages'), 'the fixture chat shows no unread badge');
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await waitFor(() => assert.ok(!screen.queryByLabelText('2 unread messages'), 'opening the chat kept its badge'));
});

test('a chat whose newest message has no text does not claim to have no messages', async () => {
  const { screen, waitFor } = rtl;
  renderChats();
  await screen.findByText(SESSION.name);
  const row = (await screen.findByText('Alice')).closest('.chat-item-card') as HTMLElement;

  // A voice note or an uncaptioned photo arrives with an empty body on both engines.
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_002_000_000).toISOString(),
    payload: {
      event: 'message.received',
      sessionId: SESSION.id,
      data: {
        id: 'wamid.live.voice',
        chatId: CHAT.id,
        from: CHAT.id,
        to: 'me',
        body: '',
        type: 'audio',
        fromMe: false,
        timestamp: 1_700_001_700,
      },
    },
  });
  await waitFor(() => assert.ok(screen.queryByLabelText('3 unread messages'), 'the arrival did not reach the row'));
  assert.equal(row.querySelector('.no-message')?.textContent ?? null, null, 'the row reads "No messages yet"');
});

// The list draws every chat of the account, so a row is drawn again only when what it shows changes: a keystroke in
// the composer redraws none, and a message redraws the row of its chat and moves it, nothing else. A row's time is
// formatted from its timestamp each time the row is drawn, which is what this counts, by the row's own timestamp.
test('typing in the composer draws no chat row again, and a message draws only the row of its chat', async () => {
  const { screen, fireEvent, within, waitFor, act } = rtl;
  const others = Array.from({ length: 20 }, (_, n) => ({
    ...CHAT_2,
    id: `1555100${String(n).padStart(4, '0')}@c.us`,
    name: `Other ${n}`,
    timestamp: 1_650_000_200 + n,
  }));
  const alice = { ...CHAT, timestamp: 1_650_000_101 };
  const carol = { ...CHAT_2, timestamp: 1_650_000_102 };
  chatsResponder = () => Promise.resolve(jsonResponse([alice, carol, ...others]));
  const drawn: number[] = [];
  const original = Date.prototype.toDateString;
  Date.prototype.toDateString = function (this: Date) {
    drawn.push(this.getTime() / 1000);
    return original.call(this);
  };
  const rowsDrawn = (timestamps: number[]) => drawn.filter(ts => timestamps.includes(ts)).length;
  try {
    const { container } = renderChats();
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    await flush();

    drawn.length = 0;
    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'h' } });
    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'hi' } });
    await flush();
    const listed = [alice, carol, ...others].map(chat => chat.timestamp);
    assert.equal(rowsDrawn(listed), 0, `a keystroke drew ${rowsDrawn(listed)} chat rows again`);

    drawn.length = 0;
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    act(() =>
      socket.receive('message', {
        type: 'event',
        timestamp: new Date(1_650_000_400_000).toISOString(),
        payload: {
          event: 'message.received',
          sessionId: SESSION.id,
          data: {
            id: 'wamid.live.carol',
            chatId: CHAT_2.id,
            from: CHAT_2.id,
            to: 'me',
            body: 'news from carol',
            type: 'text',
            fromMe: false,
            timestamp: 1_650_000_300,
          },
        },
      }),
    );
    const names = () =>
      Array.from(container.querySelectorAll('.chats-list .chat-item-name')).map(name => name.textContent);
    await waitFor(() => assert.equal(names()[0], 'Carol', 'the row did not move to the top'));
    assert.ok(rowsDrawn([1_650_000_300]) > 0, "Carol's row was not drawn with the message");
    assert.equal(rowsDrawn(listed), 0, `the message drew ${rowsDrawn(listed)} rows of other chats again`);
  } finally {
    Date.prototype.toDateString = original;
  }
});

test('a message arriving the moment the chat list commits updates the listed row without a refetch', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  // Deliver the frame from a MutationObserver callback, a microtask right after the commit that puts
  // the Alice row on screen and before React flushes that commit's passive effects. A list the socket
  // handler reads from a passive effect is still empty there, so the chat reads as unlisted and the
  // refetch it fires replaces the row this frame just updated.
  let delivered = false;
  const observer = new MutationObserver(() => {
    if (delivered || !screen.queryByText('Alice')) return;
    delivered = true;
    observer.disconnect();
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    socket.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_002_000_000).toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION.id,
        data: {
          id: 'wamid.live.commit',
          chatId: CHAT.id,
          from: CHAT.id,
          to: 'me',
          body: 'right on the commit',
          type: 'text',
          fromMe: false,
          timestamp: 1_700_001_800,
        },
      },
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    renderChats();
    await waitFor(() => assert.ok(screen.queryByLabelText('3 unread messages'), 'the arrival did not reach the row'));
    await flush();
    assert.ok(delivered, 'the frame was never delivered');
    assert.equal(
      countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`),
      1,
      'a listed chat refetched the list',
    );
    assert.ok(screen.queryByLabelText('3 unread messages'), 'a refetch overwrote the live row');
  } finally {
    observer.disconnect();
  }
});

test('a socket reconnect refetches the chat list so the sidebar shows what arrived during the gap', async () => {
  const { screen, act } = rtl;
  resetFetchCalls();
  renderChats();
  await screen.findByText('Alice');
  const chatsPath = `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`;
  assert.equal(countFetchCalls('GET', chatsPath), 1);

  // While the socket was down, Alice wrote again and a new chat started.
  const DAVE: Chat = { ...CHAT_2, id: '15550005555@c.us', name: 'Dave', timestamp: 1_700_000_900 };
  chatsResponder = () =>
    Promise.resolve(
      jsonResponse([{ ...CHAT, unreadCount: 4, lastMessage: 'sent during the gap', timestamp: 1_700_000_800 }, DAVE]),
    );
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));

  await screen.findByText('Dave');
  await screen.findByText('sent during the gap');
  assert.ok(screen.queryByLabelText('4 unread messages'), 'the unread count missed during the gap is not shown');
  assert.equal(countFetchCalls('GET', chatsPath), 2);
});

test('a message that lands while a reconnect refetch is out survives the older snapshot', async () => {
  const { screen, act, waitFor } = rtl;
  resetFetchCalls();
  renderChats();
  await screen.findByText('Alice');

  // The refetch's snapshot was built before the live message below reached the gateway.
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  chatsResponder = () => gate.then(() => jsonResponse([CHAT, CHAT_2]));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await waitFor(() => assert.equal(countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`), 2));

  act(() =>
    socket.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_002_000_000).toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION.id,
        data: {
          id: 'wamid.live.refetch',
          chatId: CHAT.id,
          from: CHAT.id,
          to: 'me',
          body: 'while the list reloads',
          type: 'text',
          fromMe: false,
          timestamp: 1_700_001_000,
        },
      },
    }),
  );
  await screen.findByText('while the list reloads');

  release();
  await flush();
  await flush();
  assert.ok(screen.queryByText('while the list reloads'), 'the older snapshot replaced the live preview');
  assert.ok(screen.queryByLabelText('3 unread messages'), 'the older snapshot dropped the live unread count');
});

test('a row a send stamped with the browser clock does not outrank a later reconnect snapshot', async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  const { container } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  // The send stamps Alice's row with the browser clock, far ahead of the fixture timestamps, and no
  // echo arrives to replace that stamp with the gateway's.
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'hello back' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-text`)));

  chatsResponder = () =>
    Promise.resolve(
      jsonResponse([{ ...CHAT, lastMessage: 'a reply after the send', timestamp: 1_700_000_800 }, CHAT_2]),
    );
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));

  await screen.findByText('a reply after the send');
});

test('a socket reconnect keeps the open chat read instead of badging it with the gap count', async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  const { container } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await waitFor(() => assert.ok(!screen.queryByLabelText('2 unread messages'), 'opening the chat kept its badge'));
  // Past the mark-as-read quiet window, so the open's own call is out before counting.
  await new Promise(resolve => setTimeout(resolve, 1_000));
  resetFetchCalls();

  // Alice wrote into the open chat while the socket was down; the snapshot still counts it unread.
  chatsResponder = () =>
    Promise.resolve(jsonResponse([{ ...CHAT, unreadCount: 4, lastMessage: 'sent during the gap' }, CHAT_2]));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));

  await screen.findByText('sent during the gap');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(!screen.queryByLabelText('4 unread messages'), 'the open chat was badged with the gap count');
  assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/chats/read`), 'the gap messages were not marked read');
});

test('a reconnect whose refetch fails while the engine starts sends no mark-as-read', async () => {
  const { screen, fireEvent, within, act } = rtl;
  const { container } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  resetFetchCalls();

  // After a backend restart the socket is back before the engine: the session's routes answer 409.
  chatsResponder = () =>
    Promise.resolve(jsonResponse({ statusCode: 409, message: 'Engine not ready', code: 'ENGINE_NOT_READY' }, 409));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));

  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`), 1);
  assert.ok(
    !findFetchCall('POST', `/api/sessions/${SESSION.id}/chats/read`),
    'a mark-as-read went out while the engine was starting',
  );
});

test('a reload asked for before the reconnect zeroed the open row does not bring the gap count back', async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  const { container } = renderChats();
  await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  resetFetchCalls();

  // Every snapshot counts Alice's gap messages, as the gateway does until it has processed the read.
  const snapshot = [{ ...CHAT, unreadCount: 4, lastMessage: 'sent during the gap' }, CHAT_2];
  const answers: Array<() => void> = [];
  chatsResponder = () =>
    new Promise<Response>(resolve => {
      answers.push(() => resolve(jsonResponse(snapshot)));
    });
  const edit = () =>
    receiveEvent('message.edited', {
      messageId: 'wamid.carol.1',
      chatId: CHAT_2.id,
      body: 'edited',
      timestamp: 1_700_003_000,
    });
  edit();
  await waitFor(() => assert.equal(answers.length, 1));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await flush();
  answers[0]();
  await screen.findByText('sent during the gap');
  await waitFor(() => assert.equal(answers.length, 2), { timeout: 3_000 }); // the reconnect's own reload is out

  // Another event asks for a list while it is out; that one starts the moment the reconnect's lands.
  edit();
  answers[1]();
  // The row is zeroed with the reload, well before the read it sends is due.
  await flush();
  await flush();
  assert.ok(!screen.queryByLabelText('4 unread messages'), 'the open chat was badged');
  await waitFor(() => assert.equal(answers.length, 3), { timeout: 3_000 });
  answers[2]();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!screen.queryByLabelText('4 unread messages'), 'the gap count came back on the open chat');
});

test('a reconnect refetch that settles after the open chat was left keeps its unread count', async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  const { container } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  resetFetchCalls();

  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  chatsResponder = () =>
    gate.then(() => jsonResponse([{ ...CHAT, unreadCount: 4, lastMessage: 'sent after leaving' }, CHAT_2]));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await waitFor(() => assert.equal(countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`), 1));

  // The user moves on to Carol before the refetch lands; Alice's new message was never seen.
  fireEvent.click(await screen.findByText('Carol'));
  release();
  await screen.findByText('sent after leaving');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(screen.queryByLabelText('4 unread messages'), 'the chat the user left lost its unread count');
  assert.ok(
    !fetchCalls.some(
      c =>
        c.method === 'POST' &&
        c.path === `/api/sessions/${SESSION.id}/chats/read` &&
        (c.body as { chatId?: string } | undefined)?.chatId === CHAT.id,
    ),
    'the chat the user left was marked read',
  );
});

test('a reconnect refetch that settles after the page was left sends no mark-as-read', async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  const { container, unmount } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  resetFetchCalls();

  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  chatsResponder = () =>
    gate.then(() => jsonResponse([{ ...CHAT, unreadCount: 4, lastMessage: 'sent after leaving' }, CHAT_2]));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await waitFor(() => assert.equal(countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`), 1));

  // The operator opens another page before the refetch lands; the gap messages were never seen.
  unmount();
  release();
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(
    !findFetchCall('POST', `/api/sessions/${SESSION.id}/chats/read`),
    'the chat was marked read after the page was left',
  );
});

async function leaveWithPendingRead(loggedOut: boolean): Promise<number> {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container, unmount } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  // Opening the chat queued its read behind the quiet window; the page goes away inside it.
  assert.ok(
    !findFetchCall('POST', `/api/sessions/${SESSION.id}/chats/read`),
    'the read went out before the page was left',
  );
  // Logout removes the key before the authenticated tree unmounts.
  if (loggedOut) window.sessionStorage.removeItem('openwa_api_key');
  try {
    unmount();
    await new Promise(resolve => setTimeout(resolve, 1_000));
  } finally {
    window.sessionStorage.setItem('openwa_api_key', 'test-key');
  }
  return countFetchCalls('POST', `/api/sessions/${SESSION.id}/chats/read`);
}

test('leaving the page sends the pending mark-as-read', async () => {
  assert.equal(await leaveWithPendingRead(false), 1, 'the pending mark-as-read was dropped');
});

test('logging out sends no pending mark-as-read without a key', async () => {
  assert.equal(await leaveWithPendingRead(true), 0, 'a keyless mark-as-read went out after logout');
});

test('a reconnect that arrives while another reload is out is answered by the trailing one, which marks the open chat read', async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  const { container } = renderChats();
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  resetFetchCalls();

  // An edit in a chat that was never opened reloads the list, and that reload stays out while the socket
  // drops and reconnects, so the reconnect's own reload waits behind it. Both snapshots count Alice's gap
  // messages, although her chat is open.
  const snapshot = [{ ...CHAT, unreadCount: 4, lastMessage: 'sent during the gap' }, CHAT_2];
  const answers: Array<() => void> = [];
  chatsResponder = () =>
    new Promise<Response>(resolve => {
      answers.push(() => resolve(jsonResponse(snapshot)));
    });
  receiveEvent('message.edited', {
    messageId: 'wamid.carol.1',
    chatId: CHAT_2.id,
    body: 'edited',
    timestamp: 1_700_003_000,
  });
  await waitFor(() => assert.equal(answers.length, 1));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await flush();
  assert.equal(answers.length, 1, 'the reconnect started a reload of its own while one was out');

  // The reload that was already out lands first. It began before the reconnect, so it is not the
  // reconnect's answer and the open chat keeps the gap count for now.
  answers[0]();
  await screen.findByText('sent during the gap');
  assert.ok(screen.queryByLabelText('4 unread messages'), 'a reload that began before the reconnect answered it');
  await waitFor(() => assert.equal(answers.length, 2));

  answers[1]();
  await waitFor(() =>
    assert.ok(!screen.queryByLabelText('4 unread messages'), 'the open chat was badged with the gap count'),
  );
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(
    fetchCalls.some(
      c =>
        c.method === 'POST' &&
        c.path === `/api/sessions/${SESSION.id}/chats/read` &&
        (c.body as { chatId?: string } | undefined)?.chatId === CHAT.id,
    ),
    'the gap messages in the open chat were not marked read',
  );
});

test("a reconnect refetch that settles after a session switch leaves the new session's unread badge", async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

    // Session 1's reconnect refetch stays out; session 2 lists Alice too (a contact both accounts
    // share), unread there, and its list lands first.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    chatsResponder = sessionId =>
      sessionId === SESSION.id
        ? firstGate.then(() => jsonResponse([CHAT, CHAT_2]))
        : Promise.resolve(jsonResponse([{ ...CHAT, unreadCount: 3, lastMessage: 'alice on two' }, CHAT_2]));
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    act(() => socket.receive('disconnect', 'transport close'));
    act(() => socket.receive('connect'));
    await waitFor(() =>
      assert.equal(countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`) >= 2, true),
    );

    selectSession(container, SESSION_2.id);
    await screen.findByText('alice on two');
    assert.ok(screen.queryByLabelText('3 unread messages'), "session 2's unread count is not shown");

    releaseFirst();
    await flush();
    await flush();
    assert.ok(screen.queryByLabelText('3 unread messages'), "session 1's refetch cleared session 2's unread badge");
  } finally {
    twoSessions = false;
  }
});

test('switching session with a chat open marks only the chats opened on the new session read', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  // Session 2 lists Alice too (a contact both accounts share). The stub folds session 2's routes onto
  // session 1's, so its mark-as-read bodies are collected before that.
  chatsResponder = sessionId =>
    Promise.resolve(
      jsonResponse(sessionId === SESSION.id ? [CHAT] : [{ ...CHAT, lastMessage: 'alice on two' }, CHAT_2]),
    );
  const readsOnOne: unknown[] = [];
  const readsOnTwo: unknown[] = [];
  const stub = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(`/api/sessions/${SESSION.id}/chats/read`))
      readsOnOne.push(JSON.parse(String(init?.body)));
    if (String(input).endsWith(`/api/sessions/${SESSION_2.id}/chats/read`))
      readsOnTwo.push(JSON.parse(String(init?.body)));
    return stub(input, init);
  }) as typeof fetch;
  try {
    const { container, unmount } = renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

    selectSession(container, SESSION_2.id);
    await screen.findByText('alice on two');
    fireEvent.click(await screen.findByText('Carol'));
    await waitFor(() => assert.ok(container.querySelector('.room-messages')));

    // Unmounting flushes the reads still queued for session 2, so none can be missed by a timer.
    unmount();
    await flush();
    await flush();
    const chatIdsOf = (reads: unknown[]) => reads.map(read => (read as { chatId: string }).chatId);
    assert.deepEqual(chatIdsOf(readsOnTwo), [CHAT_2.id]);
    // The read queued for the session that was left still reaches that session.
    assert.deepEqual(chatIdsOf(readsOnOne), [CHAT.id]);
  } finally {
    globalThis.fetch = stub;
    twoSessions = false;
  }
});

test('a read-only key opening a chat sends no mark-as-read', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  try {
    const { container } = renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    // Past the mark-as-read quiet window, so a queued call would have gone out.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.ok(!findFetchCall('POST', `/api/sessions/${SESSION.id}/chats/read`), 'a viewer key marked the chat read');
    // The chat is still unread on the gateway, so the sidebar badge keeps its count.
    assert.ok(
      screen.queryByLabelText('2 unread messages'),
      'the unread badge was cleared for a chat never marked read',
    );
    // A message arriving in the open chat is unread on the gateway too, so it counts.
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    socket.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_002_000_000).toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION.id,
        data: {
          id: 'wamid.live.viewer',
          chatId: CHAT.id,
          from: CHAT.id,
          to: 'me',
          body: 'second from alice',
          type: 'text',
          fromMe: false,
          timestamp: 1_700_001_500,
        },
      },
    });
    await waitFor(() =>
      assert.ok(screen.queryByLabelText('3 unread messages'), 'the open chat did not count the arrival'),
    );
  } finally {
    window.sessionStorage.setItem('openwa_user_role', 'admin');
  }
});

// Stage a file in the open room and wait for the preview banner. A non-image type is used on
// purpose: the image branch calls URL.createObjectURL, which JSDOM does not implement.
//
// The File MUST come from the JSDOM window, not the bare `File` global: installJsdomGlobals only
// copies window properties that Node does not already define, so `Blob`/`File` stay Node's while
// `FileReader` is JSDOM's — and JSDOM's readAsDataURL brand-checks its argument against JSDOM's
// own Blob ("parameter 1 is not of type 'Blob'").
async function stageAttachment(container: HTMLElement, filename: string, type = 'application/pdf'): Promise<void> {
  const { fireEvent, waitFor } = rtl;
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new window.File(['%PDF-1.4 stub'], filename, { type });
  fireEvent.change(fileInput, { target: { files: [file] } });
  // The bytes arrive through FileReader.onload, so the banner is asynchronous.
  await waitFor(() => {
    assert.ok(container.querySelector('.attachment-preview-banner'), 'attachment banner did not appear');
  });
}

test('a staged attachment survives closing and reopening the same room', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await stageAttachment(container, 'contract.pdf');

  // Close the room: ChatComposer unmounts, so the file only survives because the page owns it.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  assert.equal(container.querySelector('.attachment-preview-banner') === null, true);

  fireEvent.click(screen.getByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  assert.ok(container.querySelector('.attachment-preview-banner'), 'attachment was lost on reopen');
  assert.equal(container.querySelector('.preview-filename')?.textContent, 'contract.pdf');
});

test('text typed with an audio attachment stays in the input instead of showing as sent', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');
  await stageAttachment(container, 'note.ogg', 'audio/ogg');

  // Audio carries no caption on either engine, so the input does not offer one and keeps the text.
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'not a caption' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    const call = findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-audio`);
    assert.ok(call, 'expected a POST to the send-audio endpoint');
    assert.equal((call.body as { caption?: string }).caption, undefined);
  });
  await flush();

  assert.equal(input.value, 'not a caption', 'the text that was not sent was cleared');
  assert.equal(
    within(thread).queryByText('not a caption') === null,
    true,
    'the audio bubble shows text that was never sent',
  );
});

test('sends answered with no message id each keep their own bubble', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  sendTextId = '';
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  const sendPath = `/api/sessions/${SESSION.id}/messages/send-text`;
  for (const [index, text] of ['first id-less', 'second id-less'].entries()) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => assert.equal(countFetchCalls('POST', sendPath), index + 1));
    await flush();
    await flush();
  }

  assert.ok(within(thread).queryByText('first id-less'), 'the earlier id-less send vanished from the thread');
  assert.ok(within(thread).queryByText('second id-less'), 'the later id-less send is missing');
});

test('a caption sent with a document shows in its bubble', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');
  await stageAttachment(container, 'contract.pdf');

  const input = screen.getByPlaceholderText('Add a caption...') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'please sign' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    const call = findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-document`);
    assert.ok(call, 'expected a POST to the send-document endpoint');
    assert.equal((call.body as { caption?: string }).caption, 'please sign');
  });
  await flush();

  assert.equal(input.value, '');
  assert.ok(within(thread).queryByText('please sign'), 'the caption that was sent is missing from the bubble');
});

test('a file the browser cannot type goes out as a document with a generic MIME type', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  // File.type is '' for an extension the browser has no mapping for, and the gateway refuses base64
  // without a MIME type.
  await stageAttachment(container, 'settings.env', '');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    const call = findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-document`);
    assert.ok(call, 'expected a POST to the send-document endpoint');
    assert.equal((call.body as { mimetype?: string }).mimetype, 'application/octet-stream');
  });
});

test('the reply banner and the sent snippet name a media type in words, not as a raw token', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  const row = (await screen.findByText('Alice')).closest('.chat-item-card') as HTMLElement;
  fireEvent.click(row);
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  // Reply to the image row: the banner reads its localized type, not "[image]".
  const image = thread.querySelector(`[data-wa-message-id="${OMITTED_MEDIA_MESSAGE.waMessageId}"]`) as HTMLElement;
  fireEvent.click(image.querySelector('button[title="Reply"]') as HTMLElement);
  await waitFor(() =>
    assert.equal(container.querySelector('.replying-to-body')?.textContent ?? null, '[Image]', 'reply banner'),
  );

  // Sending the reply: the optimistic bubble's quote box names the type the same way.
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'nice shot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await within(thread).findByText('nice shot');
  assert.equal(
    thread.querySelector('.message-quote-box .quote-body')?.textContent ?? null,
    '[Image]',
    'optimistic quote box',
  );

  // A PDF goes out as a document, and the sidebar says so rather than "[application]".
  await stageAttachment(container, 'contract.pdf');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    assert.equal(row.querySelector('.chat-item-snippet')?.textContent ?? null, '[Document]', 'sidebar snippet'),
  );
});

test('a staged attachment is dropped when a different chat is opened', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await stageAttachment(container, 'for-alice.pdf');

  // Move to another conversation without closing the room first. Carrying the file over would let
  // the next send deliver it to the wrong recipient, so it must be dropped.
  fireEvent.click(screen.getByText('Carol'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Carol');
  assert.equal(
    container.querySelector('.attachment-preview-banner') === null,
    true,
    "Alice's attachment followed the user into Carol's room",
  );
});

test('a staged reply is kept on reopening its chat and dropped when a different chat is opened', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  let row: HTMLElement | null = await within(container.querySelector('.room-messages') as HTMLElement).findByText(
    'hello from alice',
  );
  while (row && !row.querySelector('button[title="Reply"]')) row = row.parentElement;
  fireEvent.click(row?.querySelector('button[title="Reply"]') as HTMLElement);
  await waitFor(() => assert.ok(container.querySelector('.replying-preview-banner')));

  // Close and reopen the same room: the staged reply survives, like a staged attachment does.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  assert.ok(container.querySelector('.replying-preview-banner'), 'the reply was lost on reopening its own chat');

  // A reply carried into another chat would quote Alice's message, text and number, to Carol.
  // Compared as text: a failing assertion on the DOM node itself stalls the runner.
  fireEvent.click(screen.getByText('Carol'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Carol');
  assert.equal(
    container.querySelector('.replying-preview-banner')?.textContent ?? null,
    null,
    "Alice's reply followed the user into Carol's room",
  );
});

async function reopenAfterSessionSwitch(): Promise<void> {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  chatsResponder = sessionId => Promise.resolve(jsonResponse(sessionId === SESSION.id ? [CHAT] : [CHAT_2]));
  // The stub folds session 2's routes onto session 1's, so the thread reads are counted before that.
  const threadPath = `/api/sessions/${SESSION.id}/messages?chatId=${encodeURIComponent(CHAT.id)}&`;
  let threadFetches = 0;
  const stub = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes(threadPath)) threadFetches++;
    return stub(input, init);
  }) as typeof fetch;
  try {
    const { container } = renderChats();

    await screen.findByText(SESSION.name);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    assert.equal(threadFetches, 1);

    // Session 1's events are not delivered while session 2 is selected, so its cached threads may
    // have missed messages by the time it is selected again.
    selectSession(container, SESSION_2.id);
    await screen.findByText('Carol');
    await waitFor(() => assert.equal(screen.queryByText('Alice') === null, true));
    selectSession(container, SESSION.id);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    await waitFor(() => assert.equal(threadFetches, 2, 'the cached thread was shown without a refetch'));
  } finally {
    globalThis.fetch = stub;
    twoSessions = false;
  }
}

test('a chat reopened after switching sessions and back fetches its thread again', reopenAfterSessionSwitch);

// A chat-scoped key is refused at the /events handshake, so its page never has a live feed.
test('a chat reopened after switching sessions and back fetches its thread again without a live feed', async () => {
  holdConnect();
  await reopenAfterSessionSwitch();
});

// A drop alone delivers nothing new; the reconnect is what refetches the open thread.
test('a socket drop does not refetch the open thread', async () => {
  const { screen, fireEvent, within, act } = rtl;
  resetFetchCalls();
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  const threadFetches = () =>
    fetchCalls.filter(
      c =>
        c.method === 'GET' &&
        c.path.startsWith(`/api/sessions/${SESSION.id}/messages?chatId=${encodeURIComponent(CHAT.id)}&`),
    ).length;
  const before = threadFetches();

  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('disconnect', 'transport close'));
  await act(() => new Promise(resolve => setTimeout(resolve, 50)));
  assert.equal(threadFetches(), before, 'the open thread was refetched on a socket drop');
});

test('a staged reply is dropped when another session is opened', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  try {
    resetFetchCalls();
    const { container } = renderChats();

    await screen.findByText(SESSION.name);
    fireEvent.click(await screen.findByText('Alice'));
    let row: HTMLElement | null = await within(container.querySelector('.room-messages') as HTMLElement).findByText(
      'hello from alice',
    );
    while (row && !row.querySelector('button[title="Reply"]')) row = row.parentElement;
    fireEvent.click(row?.querySelector('button[title="Reply"]') as HTMLElement);
    await waitFor(() => assert.ok(container.querySelector('.replying-preview-banner')));

    // The session switch closes the room. The chat opened next has the same id in the other session
    // (a contact both accounts share), so only the session switch, not a change of chat id, can drop it.
    selectSession(container, SESSION_2.id);
    await waitFor(() => assert.equal(container.querySelector('.room-header') === null, true));
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
    assert.equal(
      container.querySelector('.replying-preview-banner')?.textContent ?? null,
      null,
      "Alice's reply followed the user into the other session",
    );
  } finally {
    twoSessions = false;
  }
});

test("a send that resolves after a session switch does not promote the other session's chat", async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  const releaseSend = holdSend();
  // Session 2 lists a chat with Alice's id too (a contact both accounts share), below Carol.
  chatsResponder = sessionId =>
    Promise.resolve(
      jsonResponse(sessionId === SESSION.id ? [CHAT, CHAT_2] : [CHAT_2, { ...CHAT, lastMessage: 'alice on two' }]),
    );
  try {
    resetFetchCalls();
    const { container } = renderChats();
    await screen.findByText(SESSION.name);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'from session one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-text`)));

    selectSession(container, SESSION_2.id);
    await screen.findByText('alice on two');
    releaseSend();
    await flush();
    await flush();

    const rows = [...container.querySelectorAll('.chat-item-card')];
    assert.equal(rows[0]?.textContent?.includes('Carol'), true, "the other session's Alice row was moved to the top");
    const alice = rows.find(row => row.textContent?.includes('Alice'));
    assert.equal(alice?.querySelector('.chat-item-snippet')?.textContent ?? null, 'alice on two');
  } finally {
    twoSessions = false;
  }
});

test('a chat list that answers after the user switched sessions does not replace the new one', async () => {
  const { screen, waitFor } = rtl;
  twoSessions = true;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  chatsResponder = sessionId =>
    sessionId === SESSION.id ? firstGate.then(() => jsonResponse([CHAT])) : Promise.resolve(jsonResponse([CHAT_2]));
  try {
    const { container } = renderChats();
    await screen.findByText(SESSION.name);
    await waitFor(() => assert.ok(container.querySelector('.chats-list-loading'), 'the first list never started'));

    // Session 2's list lands first; session 1's slower answer arrives after it.
    selectSession(container, SESSION_2.id);
    await screen.findByText('Carol');
    releaseFirst();
    await flush();
    await flush();

    assert.ok(!screen.queryByText('Alice'), "the previous session's chats replaced the selected session's list");
    assert.ok(screen.queryByText('Carol'), "the selected session's chats are gone");
  } finally {
    twoSessions = false;
  }
});

test("a chat list that answers after a switch leaves the new session's spinner up", async () => {
  const { screen, waitFor } = rtl;
  twoSessions = true;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>(resolve => {
    releaseSecond = resolve;
  });
  chatsResponder = sessionId =>
    sessionId === SESSION.id
      ? firstGate.then(() => jsonResponse([CHAT]))
      : secondGate.then(() => jsonResponse([CHAT_2]));
  try {
    const { container } = renderChats();
    await screen.findByText(SESSION.name);
    await waitFor(() => assert.ok(container.querySelector('.chats-list-loading'), 'the first list never started'));
    selectSession(container, SESSION_2.id);

    // Session 1's list settles while session 2's is still out.
    releaseFirst();
    await flush();
    await flush();
    assert.ok(container.querySelector('.chats-list-loading'), 'the previous session cleared the switch spinner');
    assert.ok(!screen.queryByText('Alice'), "the previous session's chats showed under the selected session");

    releaseSecond();
    await screen.findByText('Carol');
    assert.equal(
      container.querySelector('.chats-list-loading') === null,
      true,
      'the list stayed on the loading spinner',
    );
  } finally {
    twoSessions = false;
  }
});

test("a failed background refetch during a session switch keeps the spinner over the previous session's list", async () => {
  const { screen, waitFor } = rtl;
  twoSessions = true;
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>(resolve => {
    releaseSecond = resolve;
  });
  let secondCalls = 0;
  // Session 2's first list is held open; the realtime refetch that overtakes it is throttled.
  chatsResponder = sessionId => {
    if (sessionId === SESSION.id) return Promise.resolve(jsonResponse([CHAT]));
    secondCalls += 1;
    if (secondCalls === 1) return secondGate.then(() => jsonResponse([CHAT_2]));
    return Promise.resolve(jsonResponse({ message: 'too many requests' }, 429));
  };
  try {
    const { container } = renderChats();
    await screen.findByText('Alice');
    selectSession(container, SESSION_2.id);
    await waitFor(() => assert.ok(container.querySelector('.chats-list-loading'), 'the switch showed no spinner'));

    const DAVE = '15550009999@c.us';
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    socket.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_003_000_000).toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION_2.id,
        data: {
          id: 'wamid.dave.1',
          chatId: DAVE,
          from: DAVE,
          to: 'me',
          body: 'hi',
          type: 'text',
          fromMe: false,
          timestamp: 1_700_003_000,
        },
      },
    });
    await waitFor(() => assert.equal(secondCalls, 2, 'the unlisted chat did not refetch the list'));
    await flush();
    await flush();

    assert.ok(container.querySelector('.chats-list-loading'), 'the failed refetch cleared the switch spinner');
    assert.ok(!screen.queryByText('Alice'), "the previous session's chats showed under the selected session");

    releaseSecond();
    await screen.findByText('Carol');
    assert.equal(
      container.querySelector('.chats-list-loading') === null,
      true,
      'the list stayed on the loading spinner',
    );
  } finally {
    twoSessions = false;
  }
});

// Answers every chat list request by hand, in the order asked. Each answer is a list led by Carol, whose
// preview names the request it answers, so a test sees which one the sidebar shows.
function holdChatLists(): Array<() => void> {
  const answers: Array<() => void> = [];
  chatsResponder = () =>
    new Promise<Response>(resolve => {
      const version = answers.length + 1;
      answers.push(() => resolve(jsonResponse([{ ...CHAT_2, lastMessage: `carol v${version}` }, CHAT])));
    });
  return answers;
}

// Two edits and a deletion in a chat that was never opened, and a message from a chat the sidebar does not
// list: four events that each ask for a list reload.
function askForReloads(): void {
  const DAVE = '15550009999@c.us';
  for (const messageId of ['wamid.carol.1', 'wamid.carol.2']) {
    receiveEvent('message.edited', { messageId, chatId: CHAT_2.id, body: 'edited', timestamp: 1_700_003_000 });
  }
  receiveEvent('message.revoked', {
    id: 'wamid.carol.3',
    revokedId: 'wamid.carol.3',
    chatId: CHAT_2.id,
    from: CHAT_2.id,
    to: 'me',
    body: '',
    type: 'revoked',
    timestamp: 1_700_003_000,
  });
  receiveEvent('message.received', {
    id: 'wamid.dave.1',
    chatId: DAVE,
    from: DAVE,
    to: 'me',
    body: 'hi',
    type: 'text',
    fromMe: false,
    timestamp: 1_700_003_000,
  });
}

test('background reloads asked for while one is out share a single trailing reload', async () => {
  const { screen, waitFor } = rtl;
  renderChats();
  await screen.findByText('Alice');
  resetFetchCalls();
  const chatsPath = `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`;
  const answers = holdChatLists();

  askForReloads();
  await waitFor(() => assert.equal(answers.length, 1));
  await flush();
  await flush();
  assert.equal(countFetchCalls('GET', chatsPath), 1, 'a trigger made while a reload was out started its own');
  assert.ok(screen.queryByText('Alice'), 'a background reload hid the chat list behind the loading spinner');

  // The reload that was out lands, and the three triggers it left waiting are answered by ONE more.
  answers[0]();
  await screen.findByText('carol v1');
  await waitFor(() => assert.equal(answers.length, 2));
  answers[1]();
  await screen.findByText('carol v2');
  await flush();
  await flush();
  assert.equal(countFetchCalls('GET', chatsPath), 2, 'the waiting triggers did not share one reload');
});

test('triggers made while the trailing reload is out queue one more behind it', async () => {
  const { screen, waitFor } = rtl;
  renderChats();
  await screen.findByText('Alice');
  resetFetchCalls();
  const chatsPath = `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`;
  const answers = holdChatLists();

  askForReloads();
  await waitFor(() => assert.equal(answers.length, 1));
  answers[0]();
  await waitFor(() => assert.equal(answers.length, 2));

  // The trailing reload is the one out now, so these four wait for one more reload, not four.
  askForReloads();
  await flush();
  await flush();
  assert.equal(countFetchCalls('GET', chatsPath), 2);
  answers[1]();
  await waitFor(() => assert.equal(answers.length, 3));
  answers[2]();
  await screen.findByText('carol v3');
  await flush();
  await flush();
  assert.equal(countFetchCalls('GET', chatsPath), 3);
});

// A background walk that never answers is cut at a deadline of the page's own, a timer of a couple of minutes.
// Only a timer that long is held back, to be fired by hand, so the rest of the page keeps its real clock.
function holdWalkDeadlines(t: TestContext): Array<() => void> {
  const fire: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, ms?: number, ...args: unknown[]) => {
    // Above a healthy walk, and below the 180 s the gateway takes to answer a stalled engine.
    if (typeof ms === 'number' && ms >= 60_000 && ms < 180_000) {
      fire.push(callback);
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  return fire;
}

test('a background walk that never answers is abandoned at its deadline, and the reload behind it starts', async t => {
  const { screen, waitFor } = rtl;
  renderChats();
  await screen.findByText('Alice');
  const deadlines = holdWalkDeadlines(t);
  // Every list request stays out until its signal aborts it, as a half-open connection would.
  const signals: Array<AbortSignal | null | undefined> = [];
  chatsResponder = (_sessionId, _offset, signal) =>
    new Promise<Response>((_resolve, reject) => {
      signals.push(signal);
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });

  askForReloads();
  await waitFor(() => assert.equal(signals.length, 1));
  assert.equal(deadlines.length, 1, 'the background walk was given no deadline');
  await flush();
  assert.equal(signals.length, 1, 'a trigger made while the walk was out started its own');

  deadlines[0]();
  await waitFor(() => assert.equal(signals.length, 2, 'the reload behind the stalled walk never started'));
  assert.equal(signals[0]?.aborted, true, 'the stalled walk was left holding its request');
  assert.equal(signals[1]?.aborted, false);
});

test('a background reload that lands before the initial list is not overwritten by it', async () => {
  const { screen, waitFor } = rtl;
  const answers = holdChatLists();
  const { container } = renderChats();
  await waitFor(() =>
    assert.equal(container.querySelector('.session-switcher-btn .session-name')?.textContent, SESSION.name),
  );
  await waitFor(() => assert.equal(answers.length, 1));
  assert.ok(container.querySelector('.chats-list-loading'), 'the initial list showed no spinner');

  // The reload is a different kind of load from the one under the spinner, so it starts at once instead of
  // waiting behind it, and whichever began later wins however the two land.
  receiveEvent('message.edited', {
    messageId: 'wamid.carol.1',
    chatId: CHAT_2.id,
    body: 'edited',
    timestamp: 1_700_003_000,
  });
  await waitFor(() => assert.equal(answers.length, 2));

  answers[1]();
  await flush();
  await flush();
  assert.ok(container.querySelector('.chats-list-loading'), 'a background reload cleared the initial list spinner');

  answers[0]();
  await screen.findByText('carol v2');
  assert.ok(!screen.queryByText('carol v1'), 'the older initial answer replaced the newer list');
  assert.equal(container.querySelector('.chats-list-loading') === null, true, 'the list stayed on the loading spinner');
});

test("a session switch drops the previous session's trailing reload and lets the new session reload at once", async () => {
  const { screen, waitFor } = rtl;
  twoSessions = true;
  const asked = { one: 0, two: 0 };
  const held: Array<() => void> = [];
  let holdOne = false;
  chatsResponder = sessionId => {
    if (sessionId === SESSION_2.id) {
      asked.two += 1;
      return Promise.resolve(jsonResponse([{ ...CHAT_2, lastMessage: 'carol on two' }]));
    }
    asked.one += 1;
    if (!holdOne) return Promise.resolve(jsonResponse([CHAT, CHAT_2]));
    return new Promise<Response>(resolve => {
      held.push(() => resolve(jsonResponse([{ ...CHAT, lastMessage: 'alice on one' }, CHAT_2])));
    });
  };
  try {
    const { container } = renderChats();
    await screen.findByText('Alice');
    holdOne = true;

    // One reload is out for session 1 and a second trigger waits behind it.
    for (const messageId of ['wamid.carol.1', 'wamid.carol.2']) {
      receiveEvent('message.edited', { messageId, chatId: CHAT_2.id, body: 'edited', timestamp: 1_700_003_000 });
    }
    await waitFor(() => assert.equal(held.length, 1));
    assert.equal(asked.one, 2);

    selectSession(container, SESSION_2.id);
    await screen.findByText('carol on two');

    // Session 2 is not queued behind the reload session 1 left out.
    receiveEvent(
      'message.edited',
      { messageId: 'wamid.carol.9', chatId: CHAT_2.id, body: 'edited', timestamp: 1 },
      SESSION_2.id,
    );
    await waitFor(() => assert.equal(asked.two, 2));

    held[0]();
    await flush();
    await flush();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(asked.one, 2, 'the trailing reload of the session left behind started after the switch');
    assert.ok(screen.queryByText('carol on two'), "the previous session's reload replaced the new session's list");
    assert.ok(!screen.queryByText('alice on one'), "the previous session's list showed under the new session");
  } finally {
    twoSessions = false;
  }
});

test('a failed background refetch keeps the chat list and raises no error', async () => {
  const { screen } = rtl;
  renderChats();
  await screen.findByText('Alice');

  chatsResponder = () => Promise.resolve(jsonResponse({ message: 'gateway timeout' }, 504));
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_003_000_000).toISOString(),
    payload: {
      event: 'message.edited',
      sessionId: SESSION.id,
      data: { messageId: 'wamid.carol.1', chatId: CHAT_2.id, body: 'edited', timestamp: 1_700_003_000 },
    },
  });
  await flush();
  await flush();

  assert.ok(screen.queryByText('Alice'), 'a failed background refetch emptied the chat list');
  assert.ok(!screen.queryByText('Failed to load chats'), 'a failed background refetch raised an error toast');
});

test('every message for a chat the sidebar does not list refetches the list, and the chat appears', async () => {
  const { screen, waitFor } = rtl;
  renderChats();
  await screen.findByText('Alice');
  resetFetchCalls();

  const DAVE = '15550009999@c.us';
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  const receive = (id: string): void =>
    socket.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_003_000_000).toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION.id,
        data: {
          id,
          chatId: DAVE,
          from: DAVE,
          to: 'me',
          body: 'hi',
          type: 'text',
          fromMe: false,
          timestamp: 1_700_003_000,
        },
      },
    });
  // Each arrival renders before the next, the shape of live traffic.
  const chatsPath = `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`;
  for (const [index, id] of ['wamid.dave.1', 'wamid.dave.2', 'wamid.dave.3'].entries()) {
    receive(id);
    await waitFor(() => assert.equal(countFetchCalls('GET', chatsPath), index + 1, 'an arrival did not refetch'));
    await flush();
  }

  chatsResponder = () =>
    Promise.resolve(jsonResponse([{ ...CHAT_2, id: DAVE, name: 'Dave', lastMessage: 'hi' }, CHAT_2, CHAT]));
  receive('wamid.dave.4');
  await screen.findByText('Dave');
});

function revoke(chatId: string, id: string): void {
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_003_000_000).toISOString(),
    payload: {
      event: 'message.revoked',
      sessionId: SESSION.id,
      data: { id, revokedId: id, chatId, from: chatId, to: 'me', body: '', type: 'revoked', timestamp: 1_700_003_000 },
    },
  });
}

test("a message deleted for everyone leaves the sidebar preview when it was the chat's newest", async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  const room = container.querySelector('.room-messages') as HTMLElement;
  const sidebar = container.querySelector('.chats-sidebar') as HTMLElement;

  // An older row going leaves the preview, which shows the newest one.
  revoke(CHAT.id, DB_MESSAGE.waMessageId as string);
  await waitFor(() => assert.ok(!within(room).queryByText('hello from alice'), 'the deleted row kept its text'));
  within(sidebar).getByText('hello from alice');

  revoke(CHAT.id, OMITTED_MEDIA_MESSAGE_2.waMessageId as string);
  await waitFor(() =>
    assert.ok(!within(sidebar).queryByText('hello from alice'), 'the sidebar still previews the deleted message'),
  );
});

test('a message deleted for everyone in a chat never opened refetches the chat list', async () => {
  const { screen, waitFor } = rtl;
  renderChats();
  await screen.findByText('Carol');
  resetFetchCalls();

  revoke(CHAT_2.id, 'wamid.carol.1');
  await waitFor(() => assert.equal(countFetchCalls('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`), 1));
});

test('a delayed poll echo cannot restore a revoked message or its sidebar preview', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const room = container.querySelector('.room-messages') as HTMLElement;
  await within(room).findByText('hello from alice');
  const id = OMITTED_MEDIA_MESSAGE_2.waMessageId as string;
  revoke(CHAT.id, id);
  const sidebar = container.querySelector('.chats-sidebar') as HTMLElement;
  await waitFor(() => assert.ok(!within(sidebar).queryByText('hello from alice')));
  resetFetchCalls();
  lastSocket()!.receive('message', {
    type: 'event',
    timestamp: new Date().toISOString(),
    payload: {
      event: 'message.received',
      sessionId: SESSION.id,
      data: {
        id,
        chatId: CHAT.id,
        from: CHAT.id,
        to: 'me',
        body: 'withdrawn question',
        type: 'poll',
        fromMe: false,
        timestamp: 1_700_003_000,
        poll: { name: 'withdrawn question', options: ['private choice'], allowMultipleAnswers: false },
      },
    },
  });
  await flush();
  assert.ok(!within(container).queryByText('withdrawn question'));
  assert.ok(!within(room).queryByText('private choice'));
  assert.equal(countFetchCalls('POST', `/api/sessions/${SESSION.id}/chats/read`), 0);
  const cached = queryClient!.getQueryData<{ pages: Array<{ db: ChatMessage[] }> }>(['messages', SESSION.id, CHAT.id]);
  const row = cached!.pages.flatMap(page => page.db).find(m => m.waMessageId === id)!;
  assert.equal(row.type, 'revoked');
  assert.equal(row.metadata, undefined);
});

// A global-search hit in the third session, on Alice's chat.
const THIRD_SESSION_HIT: SearchHit = {
  messageId: 'db-9',
  waMessageId: 'wamid.third.1',
  sessionId: SESSION_3.id,
  chatId: CHAT.id,
  body: 'hello from the third session',
  snippet: 'hello from the <mark>third</mark> session',
  timestamp: 1_700_000_000,
  type: 'text',
  direction: 'incoming',
  from: CHAT.id,
};

async function clickSearchHit(container: HTMLElement): Promise<void> {
  const { screen, fireEvent, waitFor } = rtl;
  openMessageSearch();
  fireEvent.change(screen.getByLabelText('Search messages…'), { target: { value: 'third' } });
  const hit = await waitFor(() => {
    const found = container.querySelector('.global-search-hit');
    assert.ok(found, 'the search hit did not render');
    return found;
  });
  fireEvent.click(hit);
}

// The New chat panel replaces the whole sidebar, the session switcher and the message search toggle included, so
// nothing reaches another session while it is open: no hit can switch the session under the panel. Once it is
// closed, a hit in another session switches to it and the panel stays closed.
test('the New chat panel leaves no way to another session, and a hit after it closes switches without it', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  twoSessions = true;
  searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION_2.id }];
  try {
    const { container } = renderChats();
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    assert.ok(container.querySelector('.new-chat-panel'), 'the panel did not open');
    assert.equal(container.querySelector('.session-switcher-btn'), null, 'the session switcher is reachable');
    assert.equal(screen.queryByRole('button', { name: 'Search messages' }), null, 'the message search is reachable');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await clickSearchHit(container);
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION_2.id));
    assert.equal(container.querySelector('.new-chat-panel'), null, 'the panel came back on the other session');
  } finally {
    twoSessions = false;
  }
});

test('a search hit in a session that is not connected stays on the selected session', async () => {
  const { screen, waitFor } = rtl;
  thirdSessionStatus = 'disconnected';
  searchHits = [THIRD_SESSION_HIT];
  resetFetchCalls();
  const { container } = renderChats();
  await screen.findByText('Alice');

  await clickSearchHit(container);
  await screen.findByText('The session of this message is not connected');
  await waitFor(() => assert.equal(countFetchCalls('GET', '/api/sessions'), 2, 'the session list was not reread'));
  await flush();
  assert.equal(selectedSessionId(container), SESSION.id);
  assert.ok(screen.queryByText('Alice'), 'the chat list of the selected session is gone');
  assert.ok(!screen.queryByText('Failed to load chats'), 'the page tried to load the unconnected session');
});

test('a search hit in a session that connected after the page loaded opens it', async () => {
  const { screen, within, waitFor } = rtl;
  thirdSessionStatus = 'disconnected';
  searchHits = [THIRD_SESSION_HIT];
  const { container } = renderChats();
  await screen.findByText('Alice');

  thirdSessionStatus = 'ready';
  await clickSearchHit(container);
  await waitFor(() => assert.equal(selectedSessionId(container), SESSION_3.id));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), "the hit's chat did not open"));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
});

test('a search hit in a session that dropped while it was open, and was left since, is refused', async () => {
  const { screen, waitFor, act } = rtl;
  thirdSessionStatus = 'ready';
  searchHits = [THIRD_SESSION_HIT];
  const { container } = renderChats();
  await screen.findByText('Alice');
  selectSession(container, SESSION_3.id);
  await waitFor(() => assert.equal(selectedSessionId(container), SESSION_3.id));

  // The open session stays in the switcher when it drops; the operator then goes back to the first one.
  thirdSessionStatus = 'disconnected';
  act(() =>
    lastSocket()?.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_003_000_000).toISOString(),
      payload: { event: 'session.status', sessionId: SESSION_3.id, data: { status: 'disconnected' } },
    }),
  );
  selectSession(container, SESSION.id);
  await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));

  await clickSearchHit(container);
  await screen.findByText('The session of this message is not connected');
  await flush();
  assert.equal(selectedSessionId(container), SESSION.id, 'the hit opened a session that is not connected');
});

test("a search hit in another session opens that session's chat, not the one the previous list held", async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  // A chat both accounts list, under a different name in each.
  searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION_2.id }];
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>(resolve => {
    releaseSecond = resolve;
  });
  chatsResponder = sessionId =>
    sessionId === SESSION.id
      ? Promise.resolve(jsonResponse([CHAT, CHAT_2]))
      : secondGate.then(() => jsonResponse([{ ...CHAT, name: 'Alice on two' }]));
  try {
    const { container } = renderChats();
    // A room already open is what re-runs the hit's lookup while session 1's list is still held.
    fireEvent.click(await screen.findByText('Carol'));
    await waitFor(() => assert.ok(container.querySelector('.room-header'), 'Carol did not open'));

    await clickSearchHit(container);
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION_2.id));
    await flush();
    releaseSecond();

    const header = await waitFor(() => {
      const found = container.querySelector('.room-header');
      assert.ok(found, "the hit's chat did not open");
      return found as HTMLElement;
    });
    await within(header).findByText('Alice on two');
  } finally {
    twoSessions = false;
  }
});

// The notice a hit gives when no listed chat is found to be its chat. Only the newest privacy-id chats are asked for
// their phone, so it says the chat was not found rather than that the list lacks it.
const CHAT_NOT_LISTED = 'The chat of this message could not be found in the list';

// Search reads stored messages while the list comes from the engine, so a hit's chat can be missing.
test("a search hit whose chat the other session's list lacks does not open it later on its own", async () => {
  const { screen, fireEvent, within, act, waitFor } = rtl;
  twoSessions = true;
  const DAVE: Chat = { ...CHAT_2, id: '15550005555@c.us', name: 'Dave', timestamp: 1_700_000_900 };
  searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION_2.id, chatId: DAVE.id }];
  try {
    const { container } = renderChats();
    await screen.findByText('Alice');
    await clickSearchHit(container);
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION_2.id));
    await screen.findByText(CHAT_NOT_LISTED);
    await flush();

    fireEvent.click(await screen.findByText('Carol'));
    const header = await waitFor(() => {
      const found = container.querySelector('.room-header');
      assert.ok(found, 'Carol did not open');
      return found as HTMLElement;
    });
    await within(header).findByText('Carol');

    // Dave writes; the refetch his unlisted chat triggers now lists him.
    chatsResponder = () => Promise.resolve(jsonResponse([CHAT, CHAT_2, DAVE]));
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    act(() =>
      socket.receive('message', {
        type: 'event',
        timestamp: new Date(1_700_002_000_000).toISOString(),
        payload: {
          event: 'message.received',
          sessionId: SESSION_2.id,
          data: {
            id: 'wamid.live.dave',
            chatId: DAVE.id,
            from: DAVE.id,
            to: 'me',
            body: 'dave says hi',
            type: 'text',
            fromMe: false,
            timestamp: 1_700_001_900,
          },
        },
      }),
    );
    await screen.findByText('Dave');
    await flush();
    await flush();
    const room = container.querySelector('.room-header') as HTMLElement;
    assert.equal(within(room).queryByText('Dave') === null, true, 'the old search hit opened Dave');
  } finally {
    twoSessions = false;
  }
});

// The hit's thread can take seconds to load, or fail; until it renders the hit is still pending.
test("leaving a search hit's chat before its thread loads does not reopen it", async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION.id, chatId: CHAT.id, waMessageId: DB_MESSAGE.waMessageId! }];
  firstPageGate = new Promise<void>(() => {});
  const { container } = renderChats();
  await screen.findByText('Carol');

  await clickSearchHit(container);
  await waitFor(() => assert.ok(container.querySelector('.room-header'), "the hit's chat did not open"));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
  fireEvent.click(within(container.querySelector('.chats-sidebar') as HTMLElement).getByText('Carol'));
  await flush();
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Carol');
});

// Two sessions listing the same chat id, with the target session's thread still cached.
test('a search hit in another session on the chat open in this one opens it there', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  twoSessions = true;
  chatsResponder = sessionId => Promise.resolve(jsonResponse(sessionId === SESSION.id ? [CHAT, CHAT_2] : [CHAT]));
  searchHits = [
    { ...THIRD_SESSION_HIT, sessionId: SESSION_2.id, chatId: CHAT.id, waMessageId: DB_MESSAGE.waMessageId! },
  ];
  try {
    const { container } = renderChats();
    const openAlice = async () => {
      fireEvent.click(await screen.findByText('Alice'));
      await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    };
    await screen.findByText('Carol');
    selectSession(container, SESSION_2.id);
    await waitFor(() => assert.equal(screen.queryByText('Carol') === null, true));
    await openAlice();
    selectSession(container, SESSION.id);
    await screen.findByText('Carol');
    await openAlice();

    await clickSearchHit(container);
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION_2.id));
    await flush();
    await waitFor(() => assert.ok(container.querySelector('.room-header'), "the hit's chat did not open"));
    await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
  } finally {
    twoSessions = false;
  }
});

test('a second search hit in the chat already open scrolls to it at once', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION.id, chatId: CHAT.id, waMessageId: DB_MESSAGE.waMessageId! }];
  const scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  try {
    const { container } = renderChats();
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
    const toHit = () => scrolled.filter(el => el.getAttribute('data-wa-message-id') === DB_MESSAGE.waMessageId);

    await clickSearchHit(container);
    await waitFor(() => assert.equal(toHit().length, 1, 'the first hit did not scroll'));
    // The same hit again, after the user scrolled away: the chat is open, so nothing else changes.
    fireEvent.click(screen.getByLabelText('Search messages…'));
    fireEvent.click(await waitFor(() => container.querySelector('.global-search-hit') as HTMLElement));
    await flush();
    assert.equal(toHit().length, 2, 'the second hit did not scroll');
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

// A stored row keeps the chat id it was written with: an API client may send to the raw `@s.whatsapp.net` form of a
// chat the list names by `@c.us`, or to the phone of a contact the list holds under its privacy id. The thread read
// takes those as one chat, so the hit opens the listed chat and scrolls to the message there.
for (const variant of ['the same session', 'another session', 'a privacy-id chat'] as const) {
  test(`a search hit stored under another spelling of a listed chat opens it and scrolls to the message (${variant})`, async () => {
    const { screen, waitFor, within } = rtl;
    const LID_ALICE: Chat = { ...CHAT, id: '262813461250099@lid' };
    if (variant === 'another session') twoSessions = true;
    if (variant === 'a privacy-id chat') {
      chatsResponder = () => Promise.resolve(jsonResponse([LID_ALICE, CHAT_2]));
      lidPhones[LID_ALICE.id] = '15550001111';
    }
    searchHits = [
      {
        ...THIRD_SESSION_HIT,
        sessionId: variant === 'another session' ? SESSION_2.id : SESSION.id,
        chatId: variant === 'a privacy-id chat' ? '15550001111@c.us' : '15550001111@s.whatsapp.net',
        waMessageId: DB_MESSAGE.waMessageId!,
      },
    ];
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const { container } = renderChats();
      await screen.findByText('Carol');
      await clickSearchHit(container);
      await waitFor(() => assert.ok(container.querySelector('.room-header'), "the hit's chat did not open"));
      await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
      await waitFor(() =>
        assert.equal(
          scrolled.filter(el => el.getAttribute('data-wa-message-id') === DB_MESSAGE.waMessageId).length,
          1,
          'the open chat did not scroll to the message',
        ),
      );
      assert.equal(screen.queryByText(CHAT_NOT_LISTED) === null, true, 'a hit that opened its chat said it is missing');
    } finally {
      Element.prototype.scrollIntoView = original;
      twoSessions = false;
    }
  });
}

// A hit whose chat the list holds under no spelling, not even as a privacy-id chat of the same phone, opens nothing
// and says why, rather than leaving the click without an answer.
for (const variant of ['a phone id', 'a phone no privacy-id chat resolves to'] as const) {
  test(`a search hit whose chat the list lacks under every spelling says so and opens nothing (${variant})`, async () => {
    const { screen } = rtl;
    if (variant === 'a phone no privacy-id chat resolves to') {
      chatsResponder = () => Promise.resolve(jsonResponse([{ ...CHAT, id: '262813461250099@lid' }, CHAT_2]));
      lidPhones['262813461250099@lid'] = '15550001111';
    }
    searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION.id, chatId: '15550005555@c.us' }];
    const { container } = renderChats();
    await screen.findByText('Carol');
    await clickSearchHit(container);
    await screen.findByText(CHAT_NOT_LISTED);
    await flush();
    assert.equal(container.querySelector('.room-header') === null, true, 'a chat opened for the hit');
  });
}

// Only a list that landed for the hit's session can say it lacks the chat. A hit clicked while its session's list is
// still loading waits for it and opens its chat once it lands, as a hit in another session does; a hit whose session's
// list failed to load is dropped quietly, since the failure banner already answers and the chat may well be there.
test('a search hit clicked while its session list loads opens its chat once the list lands', async () => {
  const { screen, waitFor, within } = rtl;
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  chatsResponder = () => gate.then(() => jsonResponse([CHAT, CHAT_2]));
  searchHits = [{ ...THIRD_SESSION_HIT, sessionId: SESSION.id, chatId: CHAT.id }];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    assert.equal(screen.queryByText('Carol') === null, true, 'the list landed before the click');
    await clickSearchHit(container);
    await flush();
    assert.equal(screen.queryByText(CHAT_NOT_LISTED) === null, true, 'a list still loading was said to lack the chat');
    release();
    await waitFor(() => assert.ok(container.querySelector('.room-header'), "the hit's chat did not open"));
    await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
    assert.equal(screen.queryByText(CHAT_NOT_LISTED) === null, true, 'the chat that opened was said to be missing');
  } finally {
    release();
    Element.prototype.scrollIntoView = original;
  }
});

for (const variant of ['the same session', 'another session'] as const) {
  test(`a search hit whose session list failed to load is not said to lack its chat (${variant})`, async () => {
    const { screen, waitFor } = rtl;
    if (variant === 'another session') twoSessions = true;
    const failing = variant === 'another session' ? SESSION_2.id : SESSION.id;
    chatsResponder = sessionId =>
      Promise.resolve(
        sessionId === failing ? jsonResponse({ message: 'Bad Gateway' }, 502) : jsonResponse([CHAT, CHAT_2]),
      );
    searchHits = [{ ...THIRD_SESSION_HIT, sessionId: failing, chatId: CHAT.id }];
    try {
      const { container } = renderChats();
      if (variant === 'another session') await screen.findByText('Carol');
      else await screen.findByText(/Failed to load chats/);
      await clickSearchHit(container);
      await waitFor(() => assert.equal(selectedSessionId(container), failing));
      await screen.findByText(/Failed to load chats/);
      await flush();
      await flush();
      assert.equal(screen.queryByText(CHAT_NOT_LISTED) === null, true, 'a list that failed was said to lack the chat');
      assert.equal(container.querySelector('.room-header') === null, true, 'a chat opened for the hit');
    } finally {
      twoSessions = false;
    }
  });
}

test('changing the UI language keeps the selected session and the open chat', async () => {
  const { screen, fireEvent, within, waitFor, act } = rtl;
  const { default: i18n } = await import('../i18n/index.ts');
  twoSessions = true;
  try {
    const { container } = renderChats();
    await screen.findByText(SESSION.name);
    selectSession(container, SESSION_2.id);
    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

    const sessionLoads = countFetchCalls('GET', '/api/sessions');
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    await flush();

    assert.equal(countFetchCalls('GET', '/api/sessions'), sessionLoads, 'the language change reloaded the sessions');
    assert.equal(selectedSessionId(container), SESSION_2.id, 'the language change reselected the first session');
    await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the language change closed the chat'));
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    twoSessions = false;
  }
});

/**
 * The server-side inline-media budget replaces an over-budget payload with `{ omitted: true }`. This
 * thread requests the largest page size and caches it with staleTime Infinity, so without a fetch of
 * its own the marker is terminal — the bytes exist on the server and the viewer cannot reach them.
 * Asserting the WIRE call, not the label: a placeholder that merely looks clickable would pass a
 * DOM-only check.
 */
test('an omitted media bubble fetches the bytes from the per-message media route', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();

  // jsdom implements neither, and the component uses both to hand the blob to a download link.
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  URL.createObjectURL = (): string => {
    const url = `blob:mock-${createdUrls.length}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => void revokedUrls.push(url);

  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;

  // Two omitted rows render, so target the first by its message id rather than by role alone.
  const placeholder = (await within(thread).findAllByRole('button', { name: /Media/ }))[0] as HTMLButtonElement;
  assert.equal(countFetchCalls('GET', MEDIA_PATH), 0, 'the media route must not be hit until asked');

  fireEvent.click(placeholder);

  await waitFor(() => {
    assert.equal(countFetchCalls('GET', MEDIA_PATH), 1, 'expected one GET to the per-message media route');
  });
  // The object URL is released once the download is handed off, so browsing a media-heavy thread
  // does not accumulate blobs.
  await waitFor(() => {
    assert.deepEqual(revokedUrls, createdUrls, 'every object URL created must be revoked');
  });
});

test('the media viewer saves an image under its file name, not its caption', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  firstPageExtra = [
    {
      ...DB_MESSAGE,
      id: 'db-img',
      waMessageId: 'wamid.img',
      body: 'Look at this!',
      type: 'image',
      timestamp: 1_700_000_003,
      createdAt: new Date(1_700_000_003_000).toISOString(),
      metadata: { media: { mimetype: 'image/png', filename: 'photo.png', data: 'http://localhost/media/photo.png' } },
    },
  ];
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const image = await waitFor(() => {
    const found = container.querySelector('.room-messages img.chat-image-media');
    assert.ok(found, 'the image bubble did not render');
    return found;
  });
  fireEvent.click(image);
  const download = await screen.findByRole('button', { name: 'Download' });

  const links: HTMLAnchorElement[] = [];
  const createElementOriginal = document.createElement;
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElementOriginal.call(document, tag, options);
    if (tag === 'a') {
      // Stop the synthetic click from navigating jsdom; only the name matters here.
      element.dispatchEvent = () => true;
      links.push(element as HTMLAnchorElement);
    }
    return element;
  }) as typeof document.createElement;
  try {
    fireEvent.click(download);
  } finally {
    document.createElement = createElementOriginal;
  }
  assert.equal(links.length, 1, 'expected one download link');
  assert.equal(links[0].download, 'photo.png');
});

// A sticker is drawn with the image's zoom affordance, and an archived one already opens in its own viewer.
test('a sticker opens in the media viewer, as an image does', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  firstPageExtra = [
    {
      ...DB_MESSAGE,
      id: 'db-sticker',
      waMessageId: 'wamid.sticker',
      body: '',
      type: 'sticker',
      timestamp: 1_700_000_003,
      createdAt: new Date(1_700_000_003_000).toISOString(),
      metadata: { media: { mimetype: 'image/webp', data: 'http://localhost/media/sticker.webp' } },
    },
  ];
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const sticker = await waitFor(() => {
    const found = container.querySelector('.room-messages img.chat-image-media');
    assert.ok(found, 'the sticker bubble did not render');
    return found;
  });
  fireEvent.click(sticker);
  assert.ok(await screen.findByRole('button', { name: 'Download' }), 'the viewer did not open on the sticker');
});

// whatsapp-web.js reports that a channel post has media but gives no URL for it.
test('a channel post with media and no URL says the media is unavailable', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  engineType = 'whatsapp-web.js';
  window.sessionStorage.setItem('openwa_engine_type', engineType);
  channels = [{ id: '120363000000000001@newsletter', name: 'News' }];
  channelPosts = [{ id: 'post-1', body: '', timestamp: 1_700_000_000, hasMedia: true }];
  const { container } = renderChats();
  await screen.findByText('Alice');

  fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
  fireEvent.click(await screen.findByText('News'));
  const bubble = await waitFor(() => {
    const found = container.querySelector('.channel-room .message-bubble');
    assert.ok(found, 'the post did not render');
    return found;
  });
  assert.ok(within(bubble as HTMLElement).queryByText('Media unavailable'), 'the media post rendered empty');
});

test('a channel post or status caption carrying mention delimiters renders them as nothing, not as a mention', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  // Only resolveMentions may place the delimiters; raw text carrying them is stripped before render.
  const raw = `${MENTION_OPEN}@Mallory${MENTION_CLOSE} says hi`;
  engineType = 'whatsapp-web.js';
  window.sessionStorage.setItem('openwa_engine_type', engineType);
  channels = [{ id: '120363000000000001@newsletter', name: 'News' }];
  channelPosts = [{ id: 'post-1', body: raw, timestamp: 1_700_000_000, hasMedia: false }];
  const now = Date.now();
  statuses = [
    {
      id: 'status-1',
      contact: { id: CONTACT.id, name: 'Bob' },
      type: 'image',
      caption: raw,
      timestamp: new Date(now).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
    },
  ];
  const { container } = renderChats();
  await screen.findByText('Alice');
  const bubbleText = async (): Promise<Element> =>
    waitFor(() => {
      const found = container.querySelector('.channel-room .message-bubble .message-text');
      assert.ok(found, 'the post did not render');
      return found;
    });

  fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
  fireEvent.click(await screen.findByText('News'));
  const post = await bubbleText();
  assert.equal(post.textContent, '@Mallory says hi');
  assert.ok(!post.querySelector('bdi'), 'the channel post rendered a mention');

  fireEvent.click(screen.getByRole('tab', { name: 'Status' }));
  fireEvent.click(await screen.findByText('Bob'));
  const caption = await bubbleText();
  assert.equal(caption.textContent, '@Mallory says hi');
  assert.ok(!caption.querySelector('bdi'), 'the status caption rendered a mention');
});

/**
 * Two omitted bubbles can be downloading at once, and nothing stops a viewer clicking one, then the
 * next. Each must own its own lifecycle: with a single shared slot the second click overwrote the
 * first, and then whichever settled first cleared the other's state, re-enabling a button whose
 * download was still open and letting a later failure mark the wrong bubble.
 */
test('two media downloads in flight do not clobber each other', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();

  const createdUrls: string[] = [];
  URL.createObjectURL = (): string => {
    const url = `blob:mock-${createdUrls.length}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (): void => undefined;

  // Hold BOTH responses so the two fetches overlap, then settle them out of order.
  const releaseA = holdMedia(MEDIA_PATH);
  holdMedia(MEDIA_PATH_2);

  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findAllByRole('button', { name: /Media/ });

  // Addressed by message id, not by position: the thread's ordering is not this test's subject.
  const buttonFor = (waMessageId: string): HTMLButtonElement =>
    thread.querySelector(`[data-wa-message-id="${waMessageId}"] .message-media-omitted`) as HTMLButtonElement;
  const a = buttonFor(OMITTED_MEDIA_MESSAGE.waMessageId as string);
  const b = buttonFor(OMITTED_MEDIA_MESSAGE_2.waMessageId as string);

  fireEvent.click(a);
  fireEvent.click(b);
  await waitFor(() => {
    assert.equal(countFetchCalls('GET', MEDIA_PATH), 1, 'A should have been requested');
    assert.equal(countFetchCalls('GET', MEDIA_PATH_2), 1, 'B should have been requested');
  });

  // Settle A while B is still open.
  releaseA();
  await waitFor(() => {
    assert.equal(createdUrls.length, 1, "A's blob should have been handed to the download link");
  });

  // B is still fetching, so its button must still be disabled. With a shared slot A's completion
  // cleared it here and B became clickable again mid-download.
  assert.equal(
    buttonFor(OMITTED_MEDIA_MESSAGE_2.waMessageId as string).disabled,
    true,
    "B's download was still open — A settling must not re-enable it",
  );
});

// ── Paging, and realtime over a paged cache ──────────────────────────────────

/** Modelled heights, so a commit that changes the thread's contents changes its scrollHeight. */
const BUBBLE_PX = 30;

/**
 * Give the thread container a scrollable geometry. jsdom lays nothing out, so every offset reads 0
 * and the page would never see a thread it can scroll.
 *
 * `scrollHeight` is a getter over the live DOM rather than a constant, so a commit that adds or
 * removes bubbles changes it. Only bubbles are modelled: whether the older-page indicator takes room
 * in the thread is the stylesheet's, and ChatThread.test.ts pins it there.
 */
function makeScrollable(thread: HTMLElement, scrollTop: number): void {
  Object.defineProperty(thread, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(thread, 'scrollHeight', {
    configurable: true,
    get: () => thread.querySelectorAll('.message-bubble').length * BUBBLE_PX,
  });
  let top = scrollTop;
  Object.defineProperty(thread, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
}

/** Open Carol's thread and return its scroll container, with the first page rendered. */
async function openPagedChat(container: HTMLElement): Promise<HTMLElement> {
  const { screen, fireEvent, within } = rtl;
  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Carol'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('paged message 119');
  return thread;
}

test('scrolling to the top of a long thread pulls exactly one older page, then stops', async () => {
  const { fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);
  assert.equal(within(thread).queryByText('paged message 0') === null, true);
  assert.equal(countFetchCalls('GET', pagedMessagesPath(0)), 1);

  makeScrollable(thread, 0);
  fireEvent.scroll(thread);

  // Asked for at the number of DB rows already held, not at the length of the rendered thread —
  // the engine-history merge would have inflated the latter past rows the DB never returned.
  await waitFor(() => assert.equal(countFetchCalls('GET', pagedMessagesPath(PAGE_SIZE)), 1));
  await within(thread).findByText('paged message 0');
  assert.equal(countPagedMessagesFetches(), 2);

  // And it ends: the older page came back short (20 rows < PAGE_SIZE), so a further scroll asks
  // for nothing at all — not "nothing at 2 * PAGE_SIZE" (see countPagedMessagesFetches).
  fireEvent.scroll(thread);
  await flush();
  assert.equal(countPagedMessagesFetches(), 2);
});

test('a failed older-page fetch does not blank an already-loaded thread', async () => {
  const { fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);
  olderPageFails = true;
  makeScrollable(thread, 0);
  fireEvent.scroll(thread);

  // The regression: ChatThread tested messagesError before messages.length, so this 500 replaced
  // the 100 already-loaded bubbles with the full-screen error placeholder — and the collapsed
  // container could then never regain enough height to retry by scrolling.
  await waitFor(() => assert.ok(within(thread).queryByText('paged message 119')));
  assert.equal(
    within(thread).queryByText(/couldn.t load messages/i) === null,
    true,
    'the full-screen error must not render',
  );
  assert.equal(container.querySelector('.messages-empty') === null, true, 'the full-screen error must not render');

  // The failure shows inline, where the spinner would have — with a retry hint, since the
  // container never collapsed and scrolling up again is still possible.
  await waitFor(() => {
    const inline = thread.querySelector('.messages-loading-older');
    assert.ok(inline, 'expected an inline failure indicator');
    assert.match(inline!.textContent ?? '', /couldn.t load older messages/i);
    assert.ok(inline!.classList.contains('failed'), 'the failure is styled to stay at the top of the thread');
  });
});

test('a delivery ack reaches a message held by an older page', async () => {
  const { fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);
  makeScrollable(thread, 0);
  fireEvent.scroll(thread);
  await within(thread).findByText('paged message 0');

  const statusIcon = (): Element | null =>
    within(thread).getByText('paged message 0').closest('.message-bubble')?.querySelector('.message-status-icon') ??
    null;
  assert.ok(statusIcon()?.classList.contains('sent'), 'expected the row to start unacked');

  // The regression this locks out: the realtime handlers used to read this cache as a flat array.
  // Against the paged shape the ack threw `list.findIndex is not a function` inside a listener with
  // no try/catch, so delivery ticks, reactions, revokes and edits stopped working in any open chat
  // with nothing surfaced to the user. The acked row is on the OLDEST page, so a handler that only
  // walked page 0 would miss it too.
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_002_000_000).toISOString(),
    payload: {
      event: 'message.ack',
      sessionId: SESSION.id,
      data: { id: 'paged-0', messageId: 'wamid.paged.0', status: 'read', ack: 3 },
    },
  });

  await waitFor(() => assert.ok(statusIcon()?.classList.contains('read'), 'expected the read tick on the acked row'));
});

test('the reading position is held across the commit that lands an older page', async () => {
  const { fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);
  await waitFor(() => assert.equal(thread.querySelectorAll('.message-bubble').length, PAGE_SIZE));

  const releaseOlderPage = holdOlderPage();
  makeScrollable(thread, 0);
  const before = thread.scrollHeight;
  fireEvent.scroll(thread);

  await waitFor(() => assert.ok(thread.querySelector('.messages-loading-older')));

  releaseOlderPage();
  await within(thread).findByText('paged message 0');
  await waitFor(() => assert.equal(thread.querySelector('.messages-loading-older') === null, true));

  // The thread grew upward by the new bubbles, so the row the user was reading has to move down by
  // exactly that much.
  assert.equal(thread.scrollHeight - before, PAGED_OLDEST.length * BUBBLE_PX);
  assert.equal(thread.scrollTop, PAGED_OLDEST.length * BUBBLE_PX);
});

test('leaving without scrolling again restores the corrected position, not the stale pre-correction one', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);

  // The only scroll event this test fires — the position the scroll listener's own map records —
  // stays at 0 throughout. Everything after this is the older-page CORRECTION writing scrollTop
  // directly (a programmatic write, which the listener does not see), not a further user scroll.
  const releaseOlderPage = holdOlderPage();
  makeScrollable(thread, 0);
  fireEvent.scroll(thread);
  await waitFor(() => assert.ok(thread.querySelector('.messages-loading-older')));

  releaseOlderPage();
  await within(thread).findByText('paged message 0');
  await waitFor(() => assert.equal(thread.querySelector('.messages-loading-older') === null, true));

  const corrected = thread.scrollTop;
  assert.ok(corrected > 0, 'expected the older-page correction to have moved scrollTop off 0');

  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');

  // Back to Carol, with no scroll event fired in between. The regression: the correction above
  // writes scrollTop directly and skips the scroll-listener's own scrollMap.set (it is a
  // programmatic write, not a user scroll), so without saving it explicitly the per-chat map
  // still holds the stale value from the one real scroll this test fired, at 0 — landing the
  // reader roughly a page above the row they were actually reading.
  fireEvent.click(await screen.findByText('Carol'));
  await within(thread).findByText('paged message 0');
  assert.equal(thread.scrollTop, corrected);
});

test('a message arriving while an older page is in flight survives the page landing', async () => {
  const { fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);

  const releaseOlderPage = holdOlderPage();
  makeScrollable(thread, 0);
  fireEvent.scroll(thread);
  await waitFor(() => assert.ok(thread.querySelector('.messages-loading-older')));

  // The regression this locks out: a page in flight carries a snapshot of `data.pages` taken when
  // it started, so its result overwrites anything written meanwhile — and at staleTime: Infinity
  // no refetch brings it back. Without the replay the bubble below is gone for good.
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_002_000_000).toISOString(),
    payload: {
      event: 'message.received',
      sessionId: SESSION.id,
      data: {
        id: 'wamid.live.1',
        chatId: CHAT_2.id,
        from: CHAT_2.id,
        to: 'me',
        body: 'arrived mid-fetch',
        type: 'text',
        fromMe: false,
        timestamp: 1_700_001_500,
      },
    },
  });
  await within(thread).findByText('arrived mid-fetch');

  releaseOlderPage();
  await within(thread).findByText('paged message 0');

  // Still there, exactly once, after the page landed on top of it.
  await waitFor(() => assert.equal(within(thread).getAllByText('arrived mid-fetch').length, 1));
});

test('a write during an in-flight older page survives leaving and returning to the chat', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);

  const releaseOlderPage = holdOlderPage();
  makeScrollable(thread, 0);
  fireEvent.scroll(thread);
  await waitFor(() => assert.ok(thread.querySelector('.messages-loading-older')));

  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_002_100_000).toISOString(),
    payload: {
      event: 'message.received',
      sessionId: SESSION.id,
      data: {
        id: 'wamid.live.2',
        chatId: CHAT_2.id,
        from: CHAT_2.id,
        to: 'me',
        body: 'arrived while switching away',
        type: 'text',
        fromMe: false,
        timestamp: 1_700_001_600,
      },
    },
  });
  await within(thread).findByText('arrived while switching away');

  // Leave Carol's room WITHOUT waiting for the older page to land — this is the regression: the
  // in-flight fetch is not cancelled by leaving, so it still lands later and, unfixed, an unmount
  // that forgets the queued write above leaves nothing to replay it onto the result.
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');

  releaseOlderPage();

  // Back to Carol. staleTime: Infinity means this reads the cache, not a fresh fetch — the same
  // landed-page data the departure left behind, now with the write replayed onto it.
  fireEvent.click(await screen.findByText('Carol'));
  const reopened = container.querySelector('.room-messages') as HTMLElement;
  await within(reopened).findByText('paged message 0');
  await waitFor(() => assert.equal(within(reopened).getAllByText('arrived while switching away').length, 1));
});

test('a send that reconciles after the older page has already settled does not resurrect the placeholder', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  const thread = await openPagedChat(container);

  const releaseOlderPage = holdOlderPage();
  makeScrollable(thread, 0);
  fireEvent.scroll(thread);
  await waitFor(() => assert.ok(thread.querySelector('.messages-loading-older')));

  // Send while the older page is still in flight, so the optimistic append queues behind it —
  // same as the write the previous test covers. The send's own HTTP response is held separately.
  const releaseSend = holdSend();
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'race test message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await within(thread).findByText('race test message');

  // Leave before either settles.
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');

  // The order that matters: the older page lands FIRST — replay fires immediately (not on
  // remount), reapplying the queued optimistic append onto the just-landed page. Only THEN does
  // the send resolve, reconciling directly onto what is now an idle cache (nothing left to queue
  // behind). If replay instead waited for a remount, it would still be pending when this second,
  // independent write landed — and firing later, on return, would replay the stale optimistic
  // append over the reconciled result, putting the temp placeholder back beside the real message.
  releaseOlderPage();
  await flush();
  releaseSend();
  await waitFor(() => assert.equal(countFetchCalls('POST', `/api/sessions/${SESSION.id}/messages/send-text`), 1));
  await flush();

  fireEvent.click(await screen.findByText('Carol'));
  const reopened = container.querySelector('.room-messages') as HTMLElement;
  await within(reopened).findByText('paged message 119');

  const bubbles = within(reopened).getAllByText('race test message');
  assert.equal(bubbles.length, 1, 'expected exactly one bubble — a resurrected placeholder would show a second');
  const icon = bubbles[0].closest('.message-bubble')?.querySelector('.message-status-icon');
  assert.ok(icon?.classList.contains('sent'), 'expected the reconciled (sent) row, not a reverted pending ghost');
});

test('a message sent while the first page is still loading survives the page landing', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  let releaseFirstPage!: () => void;
  firstPageGate = new Promise<void>(resolve => {
    releaseFirstPage = resolve;
  });
  const { container } = renderChats();

  await screen.findByText(SESSION.name);
  fireEvent.click(await screen.findByText('Alice'));
  // The composer is live before the thread has loaded, so a send can land in a cache with no data.
  fireEvent.change(await screen.findByPlaceholderText('Type a message...'), {
    target: { value: 'sent while loading' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-text`)));
  await flush();

  releaseFirstPage();
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');
  await waitFor(() => assert.equal(within(thread).queryAllByText('sent while loading').length, 1));
});

function receiveEvent(event: string, data: Record<string, unknown>, sessionId: string = SESSION.id): void {
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: new Date(1_700_003_000_000).toISOString(),
    payload: { event, sessionId, data },
  });
}

test('a live edit labels the message it changed, and not one whose text it repeats', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const room = container.querySelector('.room-messages') as HTMLElement;
  await within(room).findByText('hello from alice');
  const labels = () => room.querySelectorAll('.message-edited').length;
  assert.equal(labels(), 0);

  // The backend announces an edit that repeats the stored text but no longer stores a marker for it.
  receiveEvent('message.edited', {
    messageId: DB_MESSAGE.waMessageId,
    chatId: CHAT.id,
    body: DB_MESSAGE.body,
    timestamp: 1_700_003_001,
  });
  await flush();
  assert.equal(labels(), 0, 'a repeated text was labelled as edited');

  receiveEvent('message.edited', {
    messageId: DB_MESSAGE.waMessageId,
    chatId: CHAT.id,
    body: 'hello from alice, edited',
    timestamp: 1_700_003_002,
  });
  await waitFor(() => assert.equal(labels(), 1, 'a changed text was not labelled as edited'));
  await within(room).findByText('hello from alice, edited');
});

// The gateway announces the edit of a message it had not stored yet before the message, which then arrives with
// the edited text and, where its row is marked, the mark.
test('a live message announced as edited is labelled, though its edit arrived first', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const room = container.querySelector('.room-messages') as HTMLElement;
  await within(room).findByText('hello from alice');
  const labelOf = (text: string) =>
    within(room).getByText(text).closest('.message-bubble')?.querySelector('.message-edited');
  const arrive = (id: string, body: string, edited?: true) => {
    receiveEvent('message.edited', { messageId: id, chatId: CHAT.id, body, timestamp: 1_700_003_001 });
    receiveEvent('message.received', {
      id,
      chatId: CHAT.id,
      from: CHAT.id,
      to: 'me',
      body,
      type: 'text',
      fromMe: false,
      timestamp: 1_700_003_000,
      ...(edited ? { edited } : {}),
    });
  };

  arrive('wamid.live.edited', 'corrected on arrival', true);
  arrive('wamid.live.same', 'sent as it was');
  await within(room).findByText('corrected on arrival');
  await within(room).findByText('sent as it was');

  await waitFor(() => assert.ok(labelOf('corrected on arrival'), 'the message announced as edited was not labelled'));
  assert.equal(labelOf('sent as it was') ?? null, null, 'a message announced without the mark was labelled');
});

test('an edit arriving after the newest message was deleted for everyone does not refill the sidebar preview', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const room = container.querySelector('.room-messages') as HTMLElement;
  await within(room).findByText('hello from alice');
  const sidebar = container.querySelector('.chats-sidebar') as HTMLElement;
  const id = OMITTED_MEDIA_MESSAGE_2.waMessageId as string;

  revoke(CHAT.id, id);
  await waitFor(() => assert.ok(!within(sidebar).queryByText('hello from alice')));
  receiveEvent('message.edited', { messageId: id, chatId: CHAT.id, body: 'late edit', timestamp: 1_700_003_001 });
  await flush();

  assert.ok(
    !within(sidebar).queryByText('late edit'),
    'the edit of a deleted message came back as the sidebar preview',
  );
  assert.ok(!within(room).queryByText('late edit'), 'the edit of a deleted message came back into the thread');
});

const LARGE_CHAT_PAGE: Chat[] = [
  CHAT,
  ...Array.from({ length: 999 }, (_, i) => ({ ...CHAT_2, id: `large-${i}@c.us`, name: `Conversation ${i}` })),
];
const TAIL_CHAT: Chat = { ...CHAT_2, id: 'tail@c.us', name: 'Tail conversation' };

test('a conversation past the first 1000 is searchable and opens from the sidebar', async () => {
  chatsResponder = (_sessionId, offset) => Promise.resolve(jsonResponse(offset === 0 ? LARGE_CHAT_PAGE : [TAIL_CHAT]));
  const { container } = renderChats();
  await rtl.screen.findByText('Tail conversation');
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText('Search chats...'), { target: { value: 'Tail conversation' } });
  assert.equal(container.querySelectorAll('.chat-item-card').length, 1);
  rtl.fireEvent.click(rtl.screen.getByText('Tail conversation'));
  await rtl.within(container.querySelector('.room-header') as HTMLElement).findByText('Tail conversation');
});

for (const action of ['switch session', 'unmount'] as const) {
  test(`a chat list stops paging after ${action}`, async () => {
    twoSessions = true;
    const offsets: number[] = [];
    let signal: AbortSignal | null | undefined;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => {
      release = resolve;
    });
    chatsResponder = (sessionId, offset, requestSignal) => {
      if (sessionId === SESSION_2.id) return Promise.resolve(jsonResponse([CHAT_2]));
      offsets.push(offset);
      signal = requestSignal;
      return offset === 0 ? Promise.resolve(jsonResponse(LARGE_CHAT_PAGE)) : pending;
    };
    const view = renderChats();
    await rtl.waitFor(() => assert.deepEqual(offsets, [0, 1000]));
    if (action === 'switch session') {
      selectSession(view.container, SESSION_2.id);
      await rtl.screen.findByText('Carol');
    } else view.unmount();
    assert.equal(signal?.aborted, true);
    await rtl.act(async () => {
      release(jsonResponse(LARGE_CHAT_PAGE));
      await new Promise(resolve => setImmediate(resolve));
    });
    assert.deepEqual(offsets, [0, 1000]);
    if (action === 'switch session') assert.equal(rtl.screen.queryByText('Alice'), null);
    twoSessions = false;
  });
}

test('a failed later chat page keeps the previously loaded sidebar', async () => {
  renderChats();
  await rtl.screen.findByText('Alice');
  chatsResponder = (_sessionId, offset) =>
    Promise.resolve(
      offset === 0 ? jsonResponse(LARGE_CHAT_PAGE) : jsonResponse({ message: 'Later page unavailable' }, 500),
    );
  const socket = lastSocket()!;
  rtl.act(() => socket.receive('disconnect', 'transport close'));
  rtl.act(() => socket.receive('connect'));
  await rtl.waitFor(() => assert.ok(findFetchCall('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=1000`)));
  await flush();
  assert.ok(rtl.screen.queryByText('Alice'));
  assert.equal(rtl.screen.queryByText('Conversation 1'), null);
});

test('a live sidebar row survives movement outside a paginated reconnect snapshot', async () => {
  renderChats();
  await rtl.screen.findByText('Alice');
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => {
    release = resolve;
  });
  chatsResponder = (_sessionId, offset) =>
    offset === 0
      ? Promise.resolve(
          jsonResponse(
            Array.from({ length: 1000 }, (_, i) => ({ ...CHAT_2, id: `snapshot-${i}@c.us`, name: `Snapshot ${i}` })),
          ),
        )
      : pending;
  const socket = lastSocket()!;
  rtl.act(() => socket.receive('disconnect', 'transport close'));
  rtl.act(() => socket.receive('connect'));
  await rtl.waitFor(() => assert.ok(findFetchCall('GET', `/api/sessions/${SESSION.id}/chats?limit=1000&offset=1000`)));
  rtl.act(() =>
    receiveEvent('message.received', {
      id: 'live-during-paging',
      chatId: CHAT.id,
      from: CHAT.id,
      to: 'me',
      body: 'Updated during paging',
      type: 'text',
      fromMe: false,
      timestamp: 1_700_004_000,
    }),
  );
  await rtl.screen.findByText('Updated during paging');
  await rtl.act(async () => {
    release(jsonResponse([TAIL_CHAT]));
    await new Promise(resolve => setImmediate(resolve));
  });
  await rtl.screen.findByText('Tail conversation');
  assert.equal(rtl.screen.getAllByText('Updated during paging').length, 1);
  assert.ok(rtl.screen.queryByLabelText('3 unread messages'));
});

// ── Reading position of a thread ─────────────────────────────────────────────

const ROOM_HEIGHT = 600;
/** What a reaction badge adds to the thread. */
const BADGE_PX = 20;

/**
 * Scroll geometry for every `.room-messages` the page mounts, clamped to the content as a browser clamps it. The
 * room unmounts when a session switch closes its chat, so a shim on one element (makeScrollable) would arrive
 * after the restore it is meant to see. Content height is the bubbles, as in makeScrollable.
 */
function installRoomGeometry(bubblePx: number = BUBBLE_PX): () => void {
  const proto = window.HTMLDivElement.prototype;
  const inherited = Object.getOwnPropertyDescriptors(window.Element.prototype);
  const tops = new WeakMap<Element, number>();
  const isRoom = (el: Element): boolean => el.classList.contains('room-messages');
  const contentHeight = (el: Element): number =>
    el.querySelectorAll('.message-bubble').length * bubblePx +
    el.querySelectorAll('.message-reactions-badge').length * BADGE_PX;
  const maxTop = (el: Element): number => Math.max(0, contentHeight(el) - ROOM_HEIGHT);
  Object.defineProperties(proto, {
    scrollHeight: {
      configurable: true,
      get(this: Element) {
        return isRoom(this) ? contentHeight(this) : inherited.scrollHeight.get!.call(this);
      },
    },
    clientHeight: {
      configurable: true,
      get(this: Element) {
        return isRoom(this) ? ROOM_HEIGHT : inherited.clientHeight.get!.call(this);
      },
    },
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return isRoom(this) ? Math.min(tops.get(this) ?? 0, maxTop(this)) : inherited.scrollTop.get!.call(this);
      },
      set(this: Element, value: number) {
        if (isRoom(this)) tops.set(this, Math.max(0, Math.min(value, maxTop(this))));
        else inherited.scrollTop.set!.call(this, value);
      },
    },
  });
  return () => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}

test('a chat opened in another session starts at its newest message, not at the offset left in the first', async () => {
  const { screen, fireEvent, within } = rtl;
  twoSessions = true;
  // Session 2 lists Carol too, a contact both accounts share.
  chatsResponder = sessionId =>
    Promise.resolve(
      jsonResponse(sessionId === SESSION.id ? [CHAT, CHAT_2] : [CHAT, { ...CHAT_2, lastMessage: 'carol on two' }]),
    );
  const restoreGeometry = installRoomGeometry();
  try {
    const { container } = renderChats();
    const thread = await openPagedChat(container);
    assert.equal(thread.scrollTop, thread.scrollHeight - thread.clientHeight, 'a first visit did not open at the end');

    thread.scrollTop = 900; // the reader goes back through Carol's history in the first session
    fireEvent.scroll(thread);

    selectSession(container, SESSION_2.id);
    await screen.findByText('carol on two');
    fireEvent.click(screen.getByText('Carol'));
    const second = container.querySelector('.room-messages') as HTMLElement;
    await within(second).findByText('paged message 119');
    assert.equal(
      second.scrollTop,
      second.scrollHeight - second.clientHeight,
      "Carol opened in the second session at the offset left in the first session's thread",
    );

    // The first session's own position is still there when the reader comes back to it.
    selectSession(container, SESSION.id);
    await screen.findByText('hello from carol');
    fireEvent.click(screen.getByText('Carol'));
    const back = container.querySelector('.room-messages') as HTMLElement;
    await within(back).findByText('paged message 119');
    assert.equal(back.scrollTop, 900, "the first session's position was lost");
  } finally {
    restoreGeometry();
    twoSessions = false;
  }
});

// A live message in the open chat follows a reader who is at the bottom, whoever sent it: the contact, or the
// account itself (the phone, an API client, an automation).
for (const fromMe of [false, true]) {
  test(`a live message ${fromMe ? 'from the account itself' : 'from the contact'} scrolls a reader at the bottom to it`, async () => {
    const { within, waitFor } = rtl;
    const restoreGeometry = installRoomGeometry();
    try {
      const { container } = renderChats();
      const thread = await openPagedChat(container);
      const newest = (): number => thread.scrollHeight - thread.clientHeight;
      assert.equal(thread.scrollTop, newest(), 'a first visit did not open at the end');

      receiveEvent(fromMe ? 'message.sent' : 'message.received', {
        id: 'wamid.live.follow',
        chatId: CHAT_2.id,
        from: fromMe ? 'me' : CHAT_2.id,
        to: fromMe ? CHAT_2.id : 'me',
        body: 'live follow',
        type: 'text',
        fromMe,
        timestamp: 1_700_001_500,
      });
      await within(thread).findByText('live follow');
      await waitFor(() => assert.equal(thread.scrollTop, newest(), 'the new message was left below the fold'));
    } finally {
      restoreGeometry();
    }
  });
}

test('a live message from the account itself leaves a reader of older messages where they are', async () => {
  const { fireEvent, within } = rtl;
  const restoreGeometry = installRoomGeometry();
  try {
    const { container } = renderChats();
    const thread = await openPagedChat(container);
    thread.scrollTop = 900;
    fireEvent.scroll(thread);

    receiveEvent('message.sent', {
      id: 'wamid.live.reading',
      chatId: CHAT_2.id,
      from: 'me',
      to: CHAT_2.id,
      body: 'live while reading',
      type: 'text',
      fromMe: true,
      timestamp: 1_700_001_500,
    });
    await within(thread).findByText('live while reading');
    await flush();
    assert.equal(thread.scrollTop, 900);
  } finally {
    restoreGeometry();
  }
});

test('a message sent from the page scrolls the thread to it, whatever the reader was reading', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const restoreGeometry = installRoomGeometry();
  try {
    const { container } = renderChats();
    const thread = await openPagedChat(container);
    thread.scrollTop = 900;
    fireEvent.scroll(thread);

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'sent from the page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await within(thread).findByText('sent from the page');
    await waitFor(() =>
      assert.equal(
        thread.scrollTop,
        thread.scrollHeight - thread.clientHeight,
        'the thread stayed where the reader was',
      ),
    );
  } finally {
    restoreGeometry();
  }
});

// A message that merges into a row the thread already holds adds no row, so it must not leave the thread waiting for
// one: the next commit that grows it would be taken for that row.
test('the echo of a send from the page, after its response, does not take a reader paging upward to the bottom', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  // Bubbles are 8px, so the older page is about as tall as the thread's whole scroll range, as a page of 100 rows is.
  const bubblePx = 8;
  const restoreGeometry = installRoomGeometry(bubblePx);
  try {
    const { container } = renderChats();
    const thread = await openPagedChat(container);

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'reply from the page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await within(thread).findByText('reply from the page');
    await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-text`)));
    await flush(); // the response has reconciled the placeholder under its real id
    receiveEvent('message.sent', {
      id: sendTextId,
      chatId: CHAT_2.id,
      from: 'me',
      to: CHAT_2.id,
      body: 'reply from the page',
      type: 'text',
      fromMe: true,
      timestamp: 1_700_001_500,
    });
    await flush();
    assert.equal(within(thread).getAllByText('reply from the page').length, 1, 'the echo added a second row');

    // The reader goes back through the history; the older page lands above them.
    const releaseOlderPage = holdOlderPage();
    thread.scrollTop = 0;
    fireEvent.scroll(thread);
    await waitFor(() => assert.ok(thread.querySelector('.messages-loading-older')));
    releaseOlderPage();
    await within(thread).findByText('paged message 0');
    await waitFor(() => assert.equal(thread.querySelector('.messages-loading-older') === null, true));
    assert.equal(
      thread.scrollTop,
      PAGED_OLDEST.length * bubblePx,
      'the reader was not held on the message they were on',
    );
  } finally {
    restoreGeometry();
  }
});

test('a message delivered twice leaves a reader just above the bottom where they are when the thread grows', async () => {
  const { fireEvent, within, waitFor } = rtl;
  const restoreGeometry = installRoomGeometry();
  try {
    const { container } = renderChats();
    const thread = await openPagedChat(container);
    thread.scrollTop = thread.scrollHeight - thread.clientHeight - 60; // inside the 100px band that follows
    fireEvent.scroll(thread);
    const reader = thread.scrollTop;

    // The newest row arrives again: the cache merges it, and the thread does not grow.
    receiveEvent('message.received', {
      id: 'wamid.paged.119',
      chatId: CHAT_2.id,
      from: CHAT_2.id,
      to: 'me',
      body: 'paged message 119',
      type: 'text',
      fromMe: false,
      timestamp: 1_700_001_119,
    });
    await flush();
    assert.equal(thread.querySelectorAll('.message-bubble').length, PAGE_SIZE, 'the duplicate added a row');

    // Something else grows the thread: a reaction badge under a bubble.
    receiveEvent('message.reaction', {
      messageId: 'wamid.paged.119',
      chatId: CHAT_2.id,
      reaction: '👍',
      senderId: CHAT_2.id,
      reactions: { [CHAT_2.id]: '👍' },
    });
    await waitFor(() => assert.ok(thread.querySelector('.message-reactions-badge')));
    await within(thread).findByText('paged message 119');
    assert.equal(thread.scrollTop, reader, 'the reader was taken to the bottom by a commit that was not a new message');
  } finally {
    restoreGeometry();
  }
});

test('a message sent from the page scrolls a chat reopened at its saved spot to it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  const restoreGeometry = installRoomGeometry();
  try {
    const { container } = renderChats();
    const thread = await openPagedChat(container);
    thread.scrollTop = 900; // the reader's spot in Carol's thread
    fireEvent.scroll(thread);

    fireEvent.click(await screen.findByText('Alice'));
    await within(container.querySelector('.room-header') as HTMLElement).findByText('Alice');
    fireEvent.click(await screen.findByText('Carol'));
    await within(container.querySelector('.room-messages') as HTMLElement).findByText('paged message 119');
    assert.equal(thread.scrollTop, 900, 'Carol did not reopen at the spot the reader left');

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'sent at the saved spot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await within(thread).findByText('sent at the saved spot');
    await waitFor(() =>
      assert.equal(
        thread.scrollTop,
        thread.scrollHeight - thread.clientHeight,
        'the sent message was left below the fold',
      ),
    );
  } finally {
    restoreGeometry();
  }
});

test('a message sent while a chat with a saved spot loads again opens the chat at it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  // Forty more of Alice's messages, so her thread scrolls.
  firstPageExtra = Array.from({ length: 40 }, (_, i) => ({
    ...DB_MESSAGE,
    id: `db-extra-${i}`,
    waMessageId: `wamid.extra.${i}`,
    body: `alice extra ${i}`,
    timestamp: 1_700_000_100 + i,
    createdAt: new Date((1_700_000_100 + i) * 1000).toISOString(),
  }));
  const restoreGeometry = installRoomGeometry();
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    fireEvent.click(await screen.findByText('Alice'));
    const thread = container.querySelector('.room-messages') as HTMLElement;
    await within(thread).findByText('alice extra 39');
    thread.scrollTop = 300; // the reader's spot in Alice's thread
    fireEvent.scroll(thread);

    fireEvent.click(await screen.findByText('Carol'));
    await within(thread).findByText('paged message 119');
    // Alice's thread leaves the cache while the reader is elsewhere, and her first page is slow to come back.
    queryClient!.removeQueries({ queryKey: ['messages', SESSION.id, CHAT.id] });
    let releaseFirstPage!: () => void;
    firstPageGate = new Promise<void>(resolve => {
      releaseFirstPage = resolve;
    });
    fireEvent.click(await screen.findByText('Alice'));
    await waitFor(() => assert.ok(thread.querySelector('.messages-loading')));

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'sent while loading' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-text`)));
    await flush();
    releaseFirstPage();
    await within(thread).findByText('sent while loading');
    assert.equal(
      thread.scrollTop,
      thread.scrollHeight - thread.clientHeight,
      'the message sent while the chat loaded was left below the fold',
    );
  } finally {
    restoreGeometry();
  }
});

// ── Live feed subscription ───────────────────────────────────────────────────

const MESSAGE_FEED_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.reaction',
  'message.revoked',
  'message.edited',
  'status.received',
];

/**
 * The payload of every frame the page sent over the socket for the message feed. The session feed the switcher
 * follows (session.status and the like, on the '*' room) is a subscription of its own and is left out.
 */
const feedFrames = (): unknown[] =>
  sentFrames().filter(frame => frame.sessionId !== '*' && !frame.events?.includes('session.status'));

const SESSION_FEED_EVENTS = ['session.status', 'session.qr', 'session.restriction'];
const sessionFeedFrames = () => sentFrames().filter(frame => frame.events?.includes('session.status'));

/** The frames the page sent, without the requestId that only matches the gateway's answer to one. */
function sentFrames(): { type?: string; sessionId?: string; events?: string[] }[] {
  return (lastSocket()?.emitted ?? []).map(frame =>
    Object.fromEntries(Object.entries(frame.args[0] as object).filter(([key]) => key !== 'requestId')),
  );
}

test("the page follows every session's status on the wildcard room, and each listed session for a key refused it", async () => {
  const { screen, waitFor, act } = rtl;
  twoSessions = true;
  try {
    renderChats();
    await screen.findByText('Alice');
    await waitFor(() => assert.ok(sessionFeedFrames().length > 0, 'the page did not join the session feed'));
    for (const frame of sessionFeedFrames()) {
      assert.deepEqual(frame, { type: 'subscribe', sessionId: '*', events: SESSION_FEED_EVENTS });
    }

    const joined = sessionFeedFrames().length;
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    act(() =>
      socket.receive('message', { type: 'error', code: 'FORBIDDEN_SESSION', message: 'Scoped keys cannot join *' }),
    );
    await waitFor(() =>
      assert.deepEqual(
        sessionFeedFrames()
          .slice(joined)
          .map(frame => frame.sessionId)
          .sort(),
        [SESSION.id, SESSION_2.id].sort(),
      ),
    );
    for (const frame of sessionFeedFrames().slice(joined)) assert.deepEqual(frame.events, SESSION_FEED_EVENTS);
  } finally {
    twoSessions = false;
  }
});

test("the page joins the open session's message events once connected, and moves to the next session on a switch", async () => {
  const { waitFor } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    await waitFor(() =>
      assert.deepEqual(feedFrames(), [{ type: 'subscribe', sessionId: SESSION.id, events: MESSAGE_FEED_EVENTS }]),
    );

    selectSession(container, SESSION_2.id);
    await waitFor(() =>
      assert.deepEqual(feedFrames().slice(1), [
        { type: 'unsubscribe', sessionId: SESSION.id },
        { type: 'subscribe', sessionId: SESSION_2.id, events: MESSAGE_FEED_EVENTS },
      ]),
    );
  } finally {
    twoSessions = false;
  }
});

type SubscribeFrame = { type?: string; sessionId?: string; events?: string[]; requestId?: string };

/** The subscribe frames the page sent, with the requestId the gateway's answer to each echoes. */
const subscribeFrames = (): SubscribeFrame[] =>
  (lastSocket()?.emitted ?? [])
    .map(frame => frame.args[0] as SubscribeFrame)
    .filter(frame => frame.type === 'subscribe');
const isSessionFeed = (frame: SubscribeFrame) => !!frame.events?.includes('session.status');
const isMessageFeed = (frame: SubscribeFrame) => !!frame.events?.includes('message.received');
const answerSubscribe = (frame: SubscribeFrame, reply: Record<string, unknown>) =>
  lastSocket()?.receive('message', { ...reply, requestId: frame.requestId });
const KEY_UNREADABLE = { type: 'error', code: 'INTERNAL_ERROR', message: 'API key could not be checked' };
const joined = (frame: SubscribeFrame) => ({ type: 'subscribed', sessionId: frame.sessionId, events: frame.events });

// A session-scoped key holds two subscriptions of the open session: its session feed (the '*' room is refused) and
// its message feed. The gateway answers INTERNAL_ERROR to a subscribe whose key it could not read, and the page
// sends it again after a pause; joining the feed of that session meanwhile must not drop the message feed's retry.
test("a scoped key's open session message feed is sent again after its session feed falls back", async () => {
  const { waitFor, act } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    await waitFor(() => assert.ok(subscribeFrames().some(isMessageFeed) && subscribeFrames().some(isSessionFeed)));
    const wildcard = subscribeFrames().find(frame => isSessionFeed(frame) && frame.sessionId === '*');
    const messages = subscribeFrames().find(frame => isMessageFeed(frame) && frame.sessionId === SESSION.id);
    assert.ok(wildcard && messages);
    mock.timers.enable({ apis: ['setTimeout'] });
    act(() => answerSubscribe(messages, KEY_UNREADABLE));
    act(() =>
      answerSubscribe(wildcard, { type: 'error', code: 'FORBIDDEN_SESSION', message: 'Scoped keys cannot join *' }),
    );
    const perSession = subscribeFrames().filter(frame => isSessionFeed(frame) && frame.sessionId !== '*');
    assert.deepEqual(perSession.map(frame => frame.sessionId).sort(), [SESSION.id, SESSION_2.id].sort());
    act(() => {
      for (const frame of perSession) answerSubscribe(frame, joined(frame));
    });
    act(() => mock.timers.tick(1_000));
    const sent = subscribeFrames().filter(frame => isMessageFeed(frame) && frame.sessionId === SESSION.id).length;
    assert.equal(sent, 2, `the open session's message feed was sent ${sent} time(s)`);
  } finally {
    mock.timers.reset();
    twoSessions = false;
  }
});

test("after a reconnect whose subscribes all fail, every feed of a scoped key is sent again, both of the open session's", async () => {
  const { waitFor, act } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    await waitFor(() => assert.ok(subscribeFrames().some(isMessageFeed) && subscribeFrames().some(isSessionFeed)));
    const wildcard = subscribeFrames().find(frame => isSessionFeed(frame) && frame.sessionId === '*');
    assert.ok(wildcard);
    act(() =>
      answerSubscribe(wildcard, { type: 'error', code: 'FORBIDDEN_SESSION', message: 'Scoped keys cannot join *' }),
    );
    await waitFor(() =>
      assert.equal(subscribeFrames().filter(frame => isSessionFeed(frame) && frame.sessionId !== '*').length, 2),
    );
    act(() => {
      for (const frame of subscribeFrames().filter(frame => frame.sessionId !== '*')) {
        answerSubscribe(frame, joined(frame));
      }
    });

    const before = subscribeFrames().length;
    act(() => lastSocket()?.receive('disconnect', 'transport close'));
    act(() => lastSocket()?.receive('connect'));
    await waitFor(() => assert.equal(subscribeFrames().length - before, 3));
    mock.timers.enable({ apis: ['setTimeout'] });
    act(() => {
      for (const frame of subscribeFrames().slice(before)) answerSubscribe(frame, KEY_UNREADABLE);
    });
    act(() => mock.timers.tick(1_000));
    const label = (frame: SubscribeFrame) => `${frame.sessionId}:${isSessionFeed(frame) ? 'session' : 'messages'}`;
    assert.deepEqual(
      subscribeFrames()
        .slice(before + 3)
        .map(label)
        .sort(),
      [`${SESSION.id}:session`, `${SESSION.id}:messages`, `${SESSION_2.id}:session`].sort(),
    );
  } finally {
    mock.timers.reset();
    twoSessions = false;
  }
  // The reconnect's own re-reads land before the test ends.
  await flush();
  await flush();
});

// The page reads the open thread again on a connect, and the chat list on a reconnect, because a room not joined meanwhile
// missed its pushes for good. A subscribe the gateway joined only on a retry missed them the same way.
test('the open thread and the chat list are read again once a retried message subscribe joins', async () => {
  const { screen, fireEvent, within, waitFor, act } = rtl;
  resetFetchCalls();
  const threadPath = `/api/sessions/${SESSION.id}/messages?chatId=${encodeURIComponent(CHAT.id)}`;
  const threadReads = () => fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(threadPath)).length;
  const chatsPath = `/api/sessions/${SESSION.id}/chats?limit=1000&offset=0`;
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');

  // A socket blip: the page joins again and reads again, but the gateway cannot read the key for the message feed.
  const before = subscribeFrames().length;
  act(() => lastSocket()?.receive('disconnect', 'transport close'));
  act(() => lastSocket()?.receive('connect'));
  await waitFor(() => assert.ok(subscribeFrames().slice(before).some(isMessageFeed)));
  await waitFor(() => assert.equal(countFetchCalls('GET', chatsPath), 2));
  await flush();
  await flush();
  const threadReadsBefore = threadReads();
  const listReadsBefore = countFetchCalls('GET', chatsPath);
  const rejoin = subscribeFrames().slice(before).find(isMessageFeed);

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    act(() => {
      for (const frame of subscribeFrames().slice(before)) {
        answerSubscribe(frame, frame === rejoin ? KEY_UNREADABLE : joined(frame));
      }
    });
    act(() => mock.timers.tick(1_000));
  } finally {
    mock.timers.reset();
  }
  const retry = subscribeFrames().at(-1);
  assert.ok(retry && retry !== rejoin && isMessageFeed(retry), 'the message subscribe was not sent again');
  // A message received before this answer reached no one: the room was not joined.
  act(() => answerSubscribe(retry, joined(retry)));
  await waitFor(() => assert.ok(threadReads() > threadReadsBefore, 'the thread was not read again'));
  await waitFor(() =>
    assert.ok(countFetchCalls('GET', chatsPath) > listReadsBefore, 'the chat list was not read again'),
  );
  await flush();
  await flush();
});

// The page sends '*' again itself on every session switch. One sent while the failed '*' waits for its retry ends the
// same gap, so the sessions that connected or dropped meanwhile are read again once it joins.
test('the session list is read again once the wildcard feed joins on a session switch during its pause', async () => {
  const { waitFor, act, within } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    await waitFor(() => assert.ok(subscribeFrames().some(isMessageFeed) && subscribeFrames().some(isSessionFeed)));
    for (let n = 0; n < 5; n++) await flush();
    const wildcard = subscribeFrames().find(frame => frame.sessionId === '*');
    assert.ok(wildcard);
    // The pause before the retry starts on a fake clock that is dropped unmoved, so the retry itself never goes out.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      act(() => {
        for (const frame of subscribeFrames())
          answerSubscribe(frame, frame === wildcard ? KEY_UNREADABLE : joined(frame));
      });
    } finally {
      mock.timers.reset();
    }
    const reads = countFetchCalls('GET', '/api/sessions');
    const before = subscribeFrames().length;
    selectSession(container, SESSION_2.id);
    await waitFor(() =>
      assert.ok(
        subscribeFrames()
          .slice(before)
          .some(frame => frame.sessionId === '*'),
      ),
    );
    act(() => {
      for (const frame of subscribeFrames().slice(before)) answerSubscribe(frame, joined(frame));
    });
    await waitFor(() =>
      assert.ok(countFetchCalls('GET', '/api/sessions') > reads, 'the session list was not read again'),
    );
    await within(container.querySelector('.chats-sidebar') as HTMLElement).findByText('Alice');
    for (let n = 0; n < 5; n++) await flush();
  } finally {
    twoSessions = false;
  }
});

// A session-scoped key: leaving a session leaves its feed room too, a waiting retry of it included, and the page then
// joins that feed again itself. That join ends the same gap.
test("the session list is read again once a scoped key's failed feed is joined again on a switch away", async () => {
  const { waitFor, act, within } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    await waitFor(() => assert.ok(subscribeFrames().some(isMessageFeed) && subscribeFrames().some(isSessionFeed)));
    const wildcard = subscribeFrames().find(frame => frame.sessionId === '*');
    assert.ok(wildcard);
    act(() =>
      answerSubscribe(wildcard, { type: 'error', code: 'FORBIDDEN_SESSION', message: 'Scoped keys cannot join *' }),
    );
    await waitFor(() =>
      assert.equal(subscribeFrames().filter(frame => isSessionFeed(frame) && frame.sessionId !== '*').length, 2),
    );
    for (let n = 0; n < 5; n++) await flush();
    const openFeed = subscribeFrames().find(frame => isSessionFeed(frame) && frame.sessionId === SESSION.id);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      act(() => {
        for (const frame of subscribeFrames().filter(frame => frame.sessionId !== '*')) {
          answerSubscribe(frame, frame === openFeed ? KEY_UNREADABLE : joined(frame));
        }
      });
    } finally {
      mock.timers.reset();
    }
    const reads = countFetchCalls('GET', '/api/sessions');
    const before = subscribeFrames().length;
    selectSession(container, SESSION_2.id);
    await waitFor(() =>
      assert.ok(
        subscribeFrames()
          .slice(before)
          .some(frame => isSessionFeed(frame) && frame.sessionId === SESSION.id),
      ),
    );
    act(() => {
      for (const frame of subscribeFrames().slice(before)) answerSubscribe(frame, joined(frame));
    });
    await waitFor(() =>
      assert.ok(countFetchCalls('GET', '/api/sessions') > reads, 'the session list was not read again'),
    );
    await within(container.querySelector('.chats-sidebar') as HTMLElement).findByText('Alice');
    for (let n = 0; n < 5; n++) await flush();
  } finally {
    twoSessions = false;
  }
});

// The '*' refusal is answered once and never again, so the fallback must not be lost to another error frame the page
// handles in the same batch, here the open session's message subscribe whose key could not be read.
test('a refused wildcard answered together with another error still falls back to each listed session', async () => {
  const { waitFor, act } = rtl;
  twoSessions = true;
  try {
    const { container } = renderChats();
    await waitFor(() => assert.equal(selectedSessionId(container), SESSION.id));
    await waitFor(() => assert.ok(subscribeFrames().some(isMessageFeed) && subscribeFrames().some(isSessionFeed)));
    const wildcard = subscribeFrames().find(frame => isSessionFeed(frame) && frame.sessionId === '*');
    const messages = subscribeFrames().find(frame => isMessageFeed(frame) && frame.sessionId === SESSION.id);
    assert.ok(wildcard && messages);
    act(() => {
      answerSubscribe(wildcard, { type: 'error', code: 'FORBIDDEN_SESSION', message: 'Scoped keys cannot join *' });
      answerSubscribe(messages, KEY_UNREADABLE);
    });
    assert.deepEqual(
      subscribeFrames()
        .filter(frame => isSessionFeed(frame) && frame.sessionId !== '*')
        .map(frame => frame.sessionId)
        .sort(),
      [SESSION.id, SESSION_2.id].sort(),
    );
  } finally {
    twoSessions = false;
  }
});

// A failed read of the sessions is not "no connected sessions", which tells the operator to go connect one.
test('a failed session list says so and offers the read again, not the no-sessions guidance', async () => {
  const { screen, fireEvent, within } = rtl;
  sessionListStatus = 502;
  renderChats();

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Failed to load sessions/);
  assert.match(alert.textContent ?? '', /Bad Gateway/);
  assert.equal(
    screen.queryByText('No connected sessions') === null,
    true,
    'a failed read claimed there are no sessions',
  );

  sessionListStatus = null;
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await screen.findByText('Alice');
  assert.equal(screen.queryByRole('alert') === null, true);
});

// A chat list that could not be read is not an empty one: the sidebar alone would read "No chats".
test('a failed chat list says so and offers the read again, then clears once a read lands', async () => {
  const { screen, fireEvent, within } = rtl;
  chatsResponder = () => Promise.resolve(jsonResponse({ message: 'gateway timeout' }, 504));
  renderChats();

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Failed to load chats/);
  assert.match(alert.textContent ?? '', /gateway timeout/);

  chatsResponder = null;
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await screen.findByText('Alice');
  assert.equal(screen.queryByRole('alert') === null, true, 'the failure stayed after the list was read');
});

// ── The message field stays usable while a send is out ─────────────────────────

// Disabling the field that holds focus makes the browser drop focus to the page (the HTML focus fixup rule), so
// pressing Enter to send would leave the next keystrokes going nowhere. The field stays enabled while a send is
// out; the send handler already refuses a second send meanwhile.
test('the message field keeps focus while a sent message is on its way', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  const releaseSend = holdSend();
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  input.focus();
  fireEvent.change(input, { target: { value: 'first line' } });
  fireEvent.submit(input.closest('form') as HTMLFormElement);
  await within(thread).findByText('first line');

  try {
    assert.equal(input.disabled, false, 'the focused message field was disabled while the send was out');
    assert.equal(document.activeElement === input, true, 'the message field lost focus during the send');
  } finally {
    releaseSend();
    await waitFor(() => assert.equal(countFetchCalls('POST', `/api/sessions/${SESSION.id}/messages/send-text`), 1));
    await flush();
  }
});

// The field being typable during a send must not make a second send possible before the first is answered.
test('Enter pressed again while a send is out sends nothing and keeps the text typed', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  const releaseSend = holdSend();
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  const form = input.closest('form') as HTMLFormElement;
  fireEvent.change(input, { target: { value: 'first line' } });
  fireEvent.submit(form);
  await within(thread).findByText('first line');
  fireEvent.change(input, { target: { value: 'second line' } });
  fireEvent.submit(form);

  releaseSend();
  const sendPath = `/api/sessions/${SESSION.id}/messages/send-text`;
  await waitFor(() => assert.equal(countFetchCalls('POST', sendPath), 1));
  await flush();
  assert.equal(countFetchCalls('POST', sendPath), 1, 'a second send went out while the first was in flight');
  assert.equal(input.value, 'second line');
  assert.equal(within(thread).queryByText('second line') === null, true, 'the refused text was drawn as sent');
});

// Activating Send puts focus on the button, which disables once the sent text is cleared. The field takes focus
// first, so a keyboard user can type the next message at once.
test('sending with the Send button leaves focus in the message field', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  const releaseSend = holdSend();
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'by the button' } });
  const send = screen.getByRole('button', { name: 'Send' });
  send.focus();
  fireEvent.click(send);
  await within(thread).findByText('by the button');

  try {
    assert.equal(
      document.activeElement?.getAttribute('placeholder'),
      'Type a message...',
      'focus stayed on the Send button the send disabled',
    );
  } finally {
    releaseSend();
    await waitFor(() => assert.equal(countFetchCalls('POST', `/api/sessions/${SESSION.id}/messages/send-text`), 1));
    await flush();
  }
});

// ── The media viewer follows the image it was opened on ─────────────────────────

const inlineImage = (key: string, second: number): ChatMessage => ({
  ...DB_MESSAGE,
  id: `db-img-${key}`,
  waMessageId: `wamid.img.${key}`,
  body: '',
  type: 'image',
  timestamp: 1_700_000_000 + second,
  createdAt: new Date((1_700_000_000 + second) * 1000).toISOString(),
  metadata: { media: { mimetype: 'image/png', filename: `${key}.png`, data: `http://localhost/media/${key}.png` } },
});

const viewerSlideSrc = (): string | null =>
  document.querySelector('[role="dialog"] .yarl__slide_current img')?.getAttribute('src') ?? null;

const revokeEvent = (waMessageId: string) => ({
  id: waMessageId,
  revokedId: waMessageId,
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: '',
  type: 'revoked',
  timestamp: 1_700_003_000,
});

test('the media viewer keeps showing the image it was opened on when an earlier image is deleted', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  firstPageExtra = [inlineImage('a', 10), inlineImage('b', 11), inlineImage('c', 12)];
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const images = await waitFor(() => {
    const found = container.querySelectorAll('.room-messages img.chat-image-media');
    assert.equal(found.length, 3, 'the three image bubbles did not render');
    return found;
  });
  fireEvent.click(images[1]);
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/b.png'));

  // The sender deletes the first image for everyone while the second is on screen.
  receiveEvent('message.revoked', revokeEvent('wamid.img.a'));
  await waitFor(() => assert.equal(container.querySelectorAll('.room-messages img.chat-image-media').length, 2));
  await flush();

  assert.equal(viewerSlideSrc(), 'http://localhost/media/b.png', 'the viewer moved to another image');
});

test('a media viewer whose image was deleted does not open again by itself when another image arrives', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  firstPageExtra = [inlineImage('a', 10)];
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const image = await waitFor(() => {
    const found = container.querySelector('.room-messages img.chat-image-media');
    assert.ok(found, 'the image bubble did not render');
    return found;
  });
  fireEvent.click(image);
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/a.png'));

  // The only image is deleted for everyone while it is on screen: the viewer has nothing left to show.
  receiveEvent('message.revoked', revokeEvent('wamid.img.a'));
  await waitFor(() => assert.equal(document.querySelector('[role="dialog"]') === null, true, 'the viewer stayed open'));

  // Another image arrives in the open chat; nobody asked for the viewer.
  receiveEvent('message.received', {
    id: 'wamid.img.new',
    chatId: CHAT.id,
    from: CHAT.id,
    to: 'me',
    body: '',
    type: 'image',
    fromMe: false,
    timestamp: 1_700_003_001,
    media: { mimetype: 'image/png', data: 'http://localhost/media/new.png' },
  });
  await waitFor(() => assert.ok(container.querySelector('.room-messages img[src="http://localhost/media/new.png"]')));
  await flush();

  assert.equal(viewerSlideSrc(), null, 'the media viewer opened without a click');
});

// A thread holding as many media payloads as it keeps drops the oldest one when another arrives, so every image after
// it moves up the list.
test('the media viewer keeps its image when a new one pushes the oldest payload out of the thread', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  // Newest first, as the gateway serves a page: the cache holds it oldest first and strips payloads from the front.
  firstPageExtra = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => {
    const n = MEDIA_PAYLOAD_CACHE_LIMIT - 1 - i;
    return inlineImage(`p${n}`, 10 + n);
  });
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const images = await waitFor(() => {
    const found = container.querySelectorAll('.room-messages img.chat-image-media');
    assert.equal(found.length, MEDIA_PAYLOAD_CACHE_LIMIT, 'the image bubbles did not render');
    return found;
  });
  fireEvent.click(images[50]);
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/p50.png'));

  receiveEvent('message.received', {
    id: 'wamid.img.new',
    chatId: CHAT.id,
    from: CHAT.id,
    to: 'me',
    body: '',
    type: 'image',
    fromMe: false,
    timestamp: 1_700_003_001,
    media: { mimetype: 'image/png', data: 'http://localhost/media/new.png' },
  });
  await waitFor(() => assert.ok(container.querySelector('.room-messages img[src="http://localhost/media/new.png"]')));
  await waitFor(() =>
    assert.equal(container.querySelector('.room-messages img[src="http://localhost/media/p0.png"]') === null, true),
  );
  await flush();

  assert.equal(viewerSlideSrc(), 'http://localhost/media/p50.png', 'the viewer moved to another image');
});

test('the media viewer keeps its image when an older page lands in front of it', async () => {
  const { fireEvent, waitFor } = rtl;
  olderPageExtra = [
    pagedRow(-1, {
      id: 'paged-img-old',
      waMessageId: 'wamid.paged.img.old',
      body: '',
      type: 'image',
      metadata: { media: { mimetype: 'image/png', data: 'http://localhost/media/old.png' } },
    }),
  ];
  const { container } = renderChats();
  const thread = await openPagedChat(container);
  receiveEvent('message.received', {
    id: 'wamid.img.carol',
    chatId: CHAT_2.id,
    from: CHAT_2.id,
    to: 'me',
    body: '',
    type: 'image',
    fromMe: false,
    timestamp: 1_700_003_001,
    media: { mimetype: 'image/png', data: 'http://localhost/media/carol.png' },
  });
  const image = await waitFor(() => {
    const found = thread.querySelector('img[src="http://localhost/media/carol.png"]');
    assert.ok(found, 'the image bubble did not render');
    return found;
  });
  fireEvent.click(image);
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/carol.png'));

  makeScrollable(thread, 0);
  fireEvent.scroll(thread);
  await waitFor(() => assert.ok(thread.querySelector('img[src="http://localhost/media/old.png"]')));
  await flush();

  assert.equal(viewerSlideSrc(), 'http://localhost/media/carol.png', 'the viewer moved to another image');
});

test('the media viewer moves to the next image and stays there', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  firstPageExtra = [inlineImage('b', 11), inlineImage('a', 10)];
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const image = await waitFor(() => {
    const found = container.querySelector('.room-messages img[src="http://localhost/media/a.png"]');
    assert.ok(found, 'the image bubble did not render');
    return found;
  });
  fireEvent.click(image);
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/a.png'));

  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/b.png'));

  // A new image rebuilds the viewer's list; what it shows then is the image the page holds as viewed.
  receiveEvent('message.received', {
    id: 'wamid.img.new',
    chatId: CHAT.id,
    from: CHAT.id,
    to: 'me',
    body: '',
    type: 'image',
    fromMe: false,
    timestamp: 1_700_003_001,
    media: { mimetype: 'image/png', data: 'http://localhost/media/new.png' },
  });
  await waitFor(() => assert.ok(container.querySelector('.room-messages img[src="http://localhost/media/new.png"]')));
  await flush();
  assert.equal(viewerSlideSrc(), 'http://localhost/media/b.png', 'the viewer went back to the image it was opened on');
});

// ── An image opened while it is still being sent ─────────────────────────

/**
 * Send an image to Alice with the send held open, and open the media viewer on its optimistic bubble. Returns the
 * thread, the src the viewer shows, and the release for the send.
 */
async function viewImageBeingSent(t: TestContext): Promise<{ thread: HTMLElement; src: string; release: () => void }> {
  const { screen, fireEvent, within, waitFor } = rtl;
  // jsdom's File is not a Blob Node's URL accepts; the staged preview needs only some URL.
  t.mock.method(URL, 'createObjectURL', () => 'blob:staged-preview');
  t.mock.method(URL, 'revokeObjectURL', () => undefined);
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');
  await stageAttachment(container, 'photo.png', 'image/png');
  const release = holdSend();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const bubble = await waitFor(() => {
    const found = thread.querySelector('img.chat-image-media[src^="data:image/png"]');
    assert.ok(found, 'the optimistic image bubble did not render');
    return found;
  });
  fireEvent.click(bubble);
  const src = await waitFor(() => {
    const shown = viewerSlideSrc() ?? '';
    assert.ok(shown.startsWith('data:image/png'), 'the viewer did not open on the image being sent');
    return shown;
  });
  return { thread, src, release };
}

test('the media viewer opened on an image being sent stays on it when the send is confirmed', async t => {
  const { waitFor } = rtl;
  const { thread, src, release } = await viewImageBeingSent(t);

  release();
  await waitFor(() => assert.ok(thread.querySelector('[data-wa-message-id="wamid.out.image"] img.chat-image-media')));
  await flush();
  assert.equal(viewerSlideSrc(), src, 'the viewer closed by itself when the send it showed was confirmed');

  // The echo of the send then restamps the row with the time the engine gives it; the viewer follows the message.
  receiveEvent('message.sent', {
    id: 'wamid.out.image',
    chatId: CHAT.id,
    from: 'me',
    to: CHAT.id,
    body: '',
    type: 'image',
    fromMe: true,
    timestamp: 1_700_000_100,
  });
  await waitFor(() => assert.equal(rtl.within(thread).queryByText('Today') === null, true, 'the echo was not applied'));
  await flush();
  assert.equal(viewerSlideSrc(), src, 'the viewer closed when the echo restamped the confirmed image');

  // Deleted for everyone, it is gone for good and the viewer closes.
  receiveEvent('message.revoked', revokeEvent('wamid.out.image'));
  await waitFor(() => assert.equal(document.querySelector('[role="dialog"]') === null, true, 'the viewer stayed open'));
});

test('the media viewer stays on an image being sent when the echo of the send lands before its answer', async t => {
  const { waitFor } = rtl;
  const { thread, src, release } = await viewImageBeingSent(t);

  receiveEvent('message.sent', {
    id: 'wamid.out.image',
    chatId: CHAT.id,
    from: 'me',
    to: CHAT.id,
    body: '',
    type: 'image',
    fromMe: true,
    timestamp: 1_700_000_100,
  });
  await waitFor(() => assert.ok(thread.querySelector('[data-wa-message-id="wamid.out.image"]')));
  release();
  await waitFor(() => assert.ok(thread.querySelector('[data-wa-message-id="wamid.out.image"] img.chat-image-media')));
  await flush();
  assert.equal(viewerSlideSrc(), src, 'the viewer closed by itself when the send it showed was confirmed');
});

test('the media viewer stays on an image being sent when the engine confirms it without an id', async t => {
  const { waitFor } = rtl;
  sendImageId = '';
  const { thread, src, release } = await viewImageBeingSent(t);

  release();
  await waitFor(() => assert.ok(thread.querySelector('.message-status-icon.sent')));
  await flush();
  assert.equal(viewerSlideSrc(), src, 'the viewer closed by itself when the send it showed was confirmed');
});

// A file sent alone, from a tap that left nothing focused (a tap on a button does not focus it in Safari on iOS):
// moving focus into the message field would raise a phone's keyboard over the thread for no typing.
test('a file sent alone with nothing focused leaves focus where it was', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');
  await stageAttachment(container, 'contract.pdf');
  (document.activeElement as HTMLElement | null)?.blur();
  assert.equal(document.activeElement === document.body, true, 'precondition: nothing focused');

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-document`)));
  await flush();
  assert.equal(
    document.activeElement?.getAttribute('placeholder') ?? 'body',
    'body',
    'the send moved focus into the message field',
  );
});

/**
 * Stage a file alone in Alice's chat, press Send the way `press` says (a pointer of that type, or a key), and answer
 * the placeholder of what then holds focus, or 'body'.
 */
async function sendFileAlone(press: 'touch' | 'mouse' | 'key', tappedBefore = false): Promise<string> {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');
  // A tap on + focuses the button in Chromium, so focus is inside the composer from here on.
  (screen.getByRole('button', { name: 'Send file / image' }) as HTMLButtonElement).focus();
  await stageAttachment(container, 'contract.pdf');
  const send = screen.getByRole('button', { name: 'Send' });
  if (tappedBefore) fireEvent.pointerDown(send, { pointerType: 'touch' });
  if (press === 'key') fireEvent.keyDown(send, { key: 'Enter' });
  else fireEvent.pointerDown(send, { pointerType: press });
  send.focus();
  fireEvent.click(send);
  await waitFor(() => assert.ok(findFetchCall('POST', `/api/sessions/${SESSION.id}/messages/send-document`)));
  await flush();
  return document.activeElement?.getAttribute('placeholder') ?? 'body';
}

// In Chromium a tap focuses the button it hits; a focused message field would raise a phone's keyboard.
test('a file sent alone by a tap on Send leaves the message field unfocused', async () => {
  assert.notEqual(await sendFileAlone('touch'), 'Type a message...', 'the tap moved focus into the message field');
});

test('a file sent alone with a mouse click on Send leaves focus in the message field', async () => {
  assert.equal(await sendFileAlone('mouse'), 'Type a message...');
});

test('a key on Send after an earlier tap on it leaves focus in the message field', async () => {
  assert.equal(await sendFileAlone('key', true), 'Type a message...');
});

// The answer to a send and the echo of it reach the page close together. The client library tells the page about a
// cache change on its next timer turn, so an echo frame handled before that turn lands in the same render as the
// answer: the page never draws the confirmed row with the placeholder's time before the echo restamps it.
test('the media viewer stays on an image being sent when its echo lands right after its answer', async t => {
  const { waitFor } = rtl;
  const { thread, src, release } = await viewImageBeingSent(t);
  const cache = queryClient!.getQueryCache();
  let echoed = false;
  const unsubscribe = cache.subscribe(() => {
    if (echoed) return;
    const confirmed = cache
      .findAll({ queryKey: ['messages', SESSION.id, CHAT.id] })
      .some(q =>
        ((q.state.data as { pages?: Array<{ db: ChatMessage[] }> } | undefined)?.pages ?? []).some(page =>
          page.db.some(m => m.waMessageId === 'wamid.out.image'),
        ),
      );
    if (!confirmed) return;
    echoed = true;
    receiveEvent('message.sent', {
      id: 'wamid.out.image',
      chatId: CHAT.id,
      from: 'me',
      to: CHAT.id,
      body: '',
      type: 'image',
      fromMe: true,
      timestamp: 1_700_000_100,
    });
  });
  t.after(unsubscribe);

  release();
  await waitFor(() => assert.ok(thread.querySelector('[data-wa-message-id="wamid.out.image"] img.chat-image-media')));
  await flush();
  assert.equal(echoed, true, 'the echo was not delivered');
  assert.equal(viewerSlideSrc(), src, 'the viewer closed by itself when the send it showed was confirmed');
});

test('the media viewer stays on an image whose send failed', async t => {
  const { waitFor } = rtl;
  sendImageFails = true;
  const { thread, src, release } = await viewImageBeingSent(t);

  release();
  await waitFor(() => assert.ok(thread.querySelector('.message-status-icon.failed'), 'the send was not marked failed'));
  await flush();
  assert.equal(viewerSlideSrc(), src, 'the viewer closed when the send of its image failed');
});

test('a confirmed image send leaves the media viewer on the other image it shows', async t => {
  const { screen, fireEvent, waitFor } = rtl;
  t.mock.method(URL, 'createObjectURL', () => 'blob:staged-preview');
  t.mock.method(URL, 'revokeObjectURL', () => undefined);
  firstPageExtra = [inlineImage('a', 10)];
  const { container } = renderChats();
  fireEvent.click(await screen.findByText('Alice'));
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await waitFor(() => assert.ok(thread.querySelector('img.chat-image-media[src="http://localhost/media/a.png"]')));
  await stageAttachment(container, 'photo.png', 'image/png');
  const release = holdSend();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.ok(thread.querySelector('img.chat-image-media[src^="data:image/png"]')));
  fireEvent.click(thread.querySelector('img.chat-image-media[src="http://localhost/media/a.png"]') as HTMLElement);
  await waitFor(() => assert.equal(viewerSlideSrc(), 'http://localhost/media/a.png'));

  release();
  await waitFor(() => assert.ok(thread.querySelector('[data-wa-message-id="wamid.out.image"] img.chat-image-media')));
  await flush();
  assert.equal(viewerSlideSrc(), 'http://localhost/media/a.png', 'the viewer left its image when a send was confirmed');
});
