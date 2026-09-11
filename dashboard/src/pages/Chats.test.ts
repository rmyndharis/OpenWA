// Render smoke test for the Chats page under the bare `node --test` runner (no vitest/jest).
// It exists to catch the classic god-component extraction bugs: a missing prop that crashes the
// render, or a lost provider (QueryClient / Role / Toast / i18n). The page is wrapped in the
// same providers App.tsx uses (QueryClientProvider → RoleProvider → ToastProvider → MemoryRouter,
// the last for useNavigate/useLocation — the "Tag as Client" handoff to /client-mappings; i18n via
// the side-effect import) and the backend is
// stubbed at the fetch layer with canned JSON for every endpoint the page hits on mount,
// on chat open, on send, and on status-compose. Every stubbed request is recorded so tests can
// assert the wire effect (POST body) of a UI action, not just its optimistic DOM echo.
//
// Runner constraints honored here: plain .ts with React.createElement (the runner cannot parse
// JSX), loader hooks registered before any app-module import (see test-helpers/register-hooks),
// and JSDOM installed before importing modules that read `window` at import time.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, Chat, ChatMessage } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
// socket.io-client resolves to a double under this runner (see vite-shim-hooks.mjs), which is what
// lets a test deliver a server frame to the page's realtime handlers.
import { lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

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

function holdOlderPage(): () => void {
  let release!: () => void;
  olderPageGate = new Promise<void>(resolve => {
    release = resolve;
  });
  return release;
}

// Hold a text send open, so a test can land it at a chosen moment relative to an older-page fetch.
let sendGate: Promise<void> | null = null;

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
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ method, path, body });

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([SESSION]));
    if (method === 'GET' && path === '/api/infra/engines/current') {
      return Promise.resolve(jsonResponse({ engineType: 'baileys' }));
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/chats`) {
      return Promise.resolve(jsonResponse([CHAT, CHAT_2]));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    // Matched for any chat id (both CHAT and CHAT_2 open in these tests), not just the first.
    if (method === 'GET' && /\/contacts\/[^/]+\/profile-picture$/.test(path)) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/contacts`) {
      return Promise.resolve(jsonResponse([CONTACT]));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/messages?`)) {
      const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      if (query.get('chatId') === CHAT_2.id) {
        const isFirstPage = Number(query.get('offset')) === 0;
        if (!isFirstPage && olderPageFails) return Promise.resolve(jsonResponse({ message: 'boom' }, 500));
        const messages = isFirstPage ? PAGED_NEWEST : PAGED_OLDEST;
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
      return Promise.resolve(
        jsonResponse({ messages: [DB_MESSAGE, OMITTED_MEDIA_MESSAGE, OMITTED_MEDIA_MESSAGE_2], total: 3 }),
      );
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
      return Promise.resolve(jsonResponse({ statuses: [] }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/chats/read`) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-text`) {
      const send = () => jsonResponse({ messageId: 'wamid.out.1', timestamp: 1_700_000_100 });
      return sendGate ? sendGate.then(send) : Promise.resolve(send());
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
type RouterModule = typeof import('react-router-dom');

let rtl: RTL;
let Chats: ChatsModule['Chats'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let MemoryRouter: RouterModule['MemoryRouter'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // RoleProvider initializes from localStorage; 'admin' makes canWrite true so the composer
  // controls render enabled.
  window.localStorage.setItem('openwa_user_role', 'admin');
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
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  resetSocketDouble();
  queryClient?.clear();
  queryClient = undefined;
  // A gate left held would stall the next test's fetch forever.
  mediaGates.clear();
  olderPageGate = null;
  sendGate = null;
  olderPageFails = false;
});

function renderChats(): { container: HTMLElement } {
  // Small gcTime so the QueryClient's garbage-collection timers don't hold the test process open.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(Chats))),
      ),
    ),
  );
}

// ── Smoke tests ──────────────────────────────────────────────────────────────

test('Chats renders: session/chat list loads, a chat opens, and a message sends', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  // Sidebar: the session selector shows the stubbed ready session, and the chat list row
  // appears once /sessions and /sessions/:id/chats have resolved.
  await screen.findByText('Main (15551234567)');
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
  await screen.findByText('Main (15551234567)');
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
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
  await waitFor(() => {
    assert.ok(
      countFetchCalls('GET', `/api/sessions/${SESSION.id}/status`) >= 2,
      'expected the status list to refetch after posting',
    );
  });
});

test('a typed draft survives closing and reopening the room', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  // Open the chat and type (but do NOT send) a draft.
  await screen.findByText('Main (15551234567)');
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'draft survives' } });

  // Close the room with the back button (aria-label = common.back); the composer unmounts.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  assert.equal(screen.queryByRole('button', { name: 'Back' }), null);

  // Reopen the same chat (room closed → 'Alice' matches only the sidebar row): the draft must
  // still be in the input — the page owns messageInput precisely so it survives this round trip.
  fireEvent.click(screen.getByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  assert.equal(input.value, 'draft survives');
});

// Stage a file in the open room and wait for the preview banner. A non-image type is used on
// purpose: the image branch calls URL.createObjectURL, which JSDOM does not implement.
//
// The File MUST come from the JSDOM window, not the bare `File` global: installJsdomGlobals only
// copies window properties that Node does not already define, so `Blob`/`File` stay Node's while
// `FileReader` is JSDOM's — and JSDOM's readAsDataURL brand-checks its argument against JSDOM's
// own Blob ("parameter 1 is not of type 'Blob'").
async function stageAttachment(container: HTMLElement, filename: string): Promise<void> {
  const { fireEvent, waitFor } = rtl;
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new window.File(['%PDF-1.4 stub'], filename, { type: 'application/pdf' });
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

  await screen.findByText('Main (15551234567)');
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await stageAttachment(container, 'contract.pdf');

  // Close the room: ChatComposer unmounts, so the file only survives because the page owns it.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  assert.equal(container.querySelector('.attachment-preview-banner'), null);

  fireEvent.click(screen.getByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  assert.ok(container.querySelector('.attachment-preview-banner'), 'attachment was lost on reopen');
  assert.equal(container.querySelector('.preview-filename')?.textContent, 'contract.pdf');
});

test('a staged attachment is dropped when a different chat is opened', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderChats();

  await screen.findByText('Main (15551234567)');
  fireEvent.click(await screen.findByText('Alice'));
  await within(container.querySelector('.room-messages') as HTMLElement).findByText('hello from alice');
  await stageAttachment(container, 'for-alice.pdf');

  // Move to another conversation without closing the room first. Carrying the file over would let
  // the next send deliver it to the wrong recipient, so it must be dropped.
  fireEvent.click(screen.getByText('Carol'));
  await within(container.querySelector('.room-header') as HTMLElement).findByText('Carol');
  assert.equal(
    container.querySelector('.attachment-preview-banner'),
    null,
    "Alice's attachment followed the user into Carol's room",
  );
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

/**
 * Two omitted bubbles can be downloading at once — nothing stops a viewer clicking one, then the
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
const OLDER_SPINNER_PX = 46;

/**
 * Give the thread container a scrollable geometry. jsdom lays nothing out, so every offset reads 0
 * and the page would never see a thread it can scroll.
 *
 * `scrollHeight` is a getter over the live DOM rather than a constant: the older-page spinner is an
 * in-flow child of this container, so it grows the thread on its own commit, one commit BEFORE the
 * page lands. A constant cannot tell those two commits apart, and the scroll-restore test below
 * turns entirely on the difference.
 */
function makeScrollable(thread: HTMLElement, scrollTop: number): void {
  Object.defineProperty(thread, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(thread, 'scrollHeight', {
    configurable: true,
    get: () =>
      thread.querySelectorAll('.message-bubble').length * BUBBLE_PX +
      (thread.querySelector('.messages-loading-older') ? OLDER_SPINNER_PX : 0),
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
  await screen.findByText('Main (15551234567)');
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
  assert.equal(within(thread).queryByText('paged message 0'), null);
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
  assert.equal(within(thread).queryByText(/couldn.t load messages/i), null, 'the full-screen error must not render');
  assert.equal(container.querySelector('.messages-empty'), null, 'the full-screen error must not render');

  // The failure shows inline, where the spinner would have — with a retry hint, since the
  // container never collapsed and scrolling up again is still possible.
  await waitFor(() => {
    const inline = thread.querySelector('.messages-loading-older');
    assert.ok(inline, 'expected an inline failure indicator');
    assert.match(inline!.textContent ?? '', /couldn.t load older messages/i);
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
  assert.equal(thread.scrollHeight, before + OLDER_SPINNER_PX);

  releaseOlderPage();
  await within(thread).findByText('paged message 0');
  await waitFor(() => assert.equal(thread.querySelector('.messages-loading-older'), null));

  // The thread grew upward by the new bubbles, so the row the user was reading has to move down by
  // exactly that much. The regression this locks out: measuring the growth on the first commit that
  // changed scrollHeight caught the older-page SPINNER entering the flow, one commit early, and
  // spent the correction on its ~46px — leaving the real prepend uncorrected and the view thrown a
  // full page backwards.
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
  await waitFor(() => assert.equal(thread.querySelector('.messages-loading-older'), null));

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
