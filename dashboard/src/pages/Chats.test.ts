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
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, Chat, ChatMessage } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

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
      return Promise.resolve(jsonResponse({ messages: [DB_MESSAGE], total: 1 }));
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
      return Promise.resolve(jsonResponse({ messageId: 'wamid.out.1', timestamp: 1_700_000_100 }));
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
  // RoleProvider initializes from localStorage; 'admin' makes canWrite true so the composer
  // controls render enabled.
  window.localStorage.setItem('openwa_user_role', 'admin');
  // Side-effect import: initializes the real i18n instance with all locales (JSON modules are
  // handled by the registered loader hooks).
  await import('../i18n/index.ts');
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderChats(): { container: HTMLElement } {
  // Small gcTime so the QueryClient's garbage-collection timers don't hold the test process open.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
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
