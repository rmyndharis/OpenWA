// The Reply button of a message sits in a menu that is drawn only while the pointer is over the message or focus is
// inside it, and the reply banner it opens changes the room under the pointer: the menu goes, and the focus that the
// press gave the button falls to the page, so the answer cannot be typed. Starting a reply puts the focus in the
// message field, as opening a chat to write in it does, and never after a tap, where a focused field raises a phone's
// keyboard over the thread.
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
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json([ALICE]));
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (/\/profile-picture$/.test(path)) return Promise.resolve(json({ url: null }));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    if (path.includes('/templates')) return Promise.resolve(json([]));
    if (path.includes('/messages?')) return Promise.resolve(json({ messages: [MESSAGE], total: 1 }));
    if (/\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(json([]));
    if (path.endsWith('/chats/read')) return Promise.resolve(json({ success: true }));
    return Promise.resolve(json({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
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
});

after(() => {
  window.sessionStorage.clear();
});

/** Alice's chat open, with her one message drawn. */
async function openAlice(): Promise<void> {
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
}

/** What holds focus, by tag and name: never two DOM nodes compared. */
function focused(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return 'the page';
  if (active.classList.contains('message-text-input')) return 'the message field';
  return `${active.tagName.toLowerCase()} "${(active.getAttribute('title') ?? active.textContent ?? '').trim().slice(0, 40)}"`;
}

/**
 * Press Reply as a pointer of that type does (its pointerdown, the focus the press gives the button, then the click),
 * or with Enter, which a native button turns into a click with no count.
 */
function pressReply(press: 'mouse' | 'pen' | 'touch' | 'key'): void {
  const reply = rtl.screen.getByTitle('Reply');
  if (press === 'key') rtl.fireEvent.keyDown(reply, { key: 'Enter' });
  else rtl.fireEvent.pointerDown(reply, { pointerType: press });
  reply.focus();
  rtl.fireEvent.click(reply, { detail: press === 'key' ? 0 : 1 });
}

const replyBanner = (): Element | null => document.querySelector('.replying-preview-banner');

for (const press of ['mouse', 'pen', 'key'] as const) {
  test(`starting a reply with a ${press} puts the focus in the message field`, async () => {
    await openAlice();
    assert.notEqual(focused(), 'the message field', 'precondition: the field already had the focus');
    pressReply(press);
    assert.ok(replyBanner(), 'the reply did not start');
    assert.equal(focused(), 'the message field');
  });
}

test('starting a reply with a tap leaves focus alone, as a focused field raises a phone keyboard', async () => {
  await openAlice();
  pressReply('touch');
  assert.ok(replyBanner(), 'the reply did not start');
  assert.notEqual(focused(), 'the message field');
});

test('pressing Reply again on the message being answered brings the focus back to the field', async () => {
  await openAlice();
  pressReply('mouse');
  assert.equal(focused(), 'the message field');
  (document.activeElement as HTMLElement).blur();
  assert.equal(focused(), 'the page');
  pressReply('mouse');
  assert.equal(focused(), 'the message field');
});
