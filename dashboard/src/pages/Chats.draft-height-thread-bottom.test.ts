// A chat that is read again opens at its newest message. Its composer is as tall as the draft kept for it, so the
// thread above is shorter by the lines of that draft, and the newest message must still be the one above the field.
// That holds whether the room was on screen with another chat, or was closed and is mounted anew for this one.
//
// jsdom has no layout, so the thread's box is modelled from the document: 600px, less 20px for every line of the
// draft past the first. The scroll event a browser raises on the next frame is dispatched by the test.
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

function rows(chat: Chat, count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `db-${chat.name}-${i}`,
    waMessageId: `wamid.${chat.name}.${i}`,
    chatId: chat.id,
    from: chat.id,
    to: 'me',
    body: `message ${i} of ${chat.name}`,
    type: 'text',
    direction: 'incoming',
    status: 'delivered',
    timestamp: 1_700_000_000 + i,
    createdAt: new Date((1_700_000_000 + i) * 1000).toISOString(),
  }));
}
const THREADS: Record<string, ChatMessage[]> = { [ALICE.id]: rows(ALICE, 40), [CAROL.id]: rows(CAROL, 40) };
// The thread's box: what a loaded thread measures.
const THREAD_HEIGHT = 4600;
const BOX_HEIGHT = 600;
const LINE_HEIGHT = 20;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let client: QueryClient | undefined;
const queries = new Set<Query>();
const tops = new WeakMap<Element, number>();
let restoreGeometry: () => void = () => {};

const isThread = (el: Element) => el.classList.contains('room-messages');
const boxOf = (el: Element): number => {
  const draft = el.closest('.room-container')?.querySelector<HTMLTextAreaElement>('.message-text-input')?.value ?? '';
  return BOX_HEIGHT - LINE_HEIGHT * (draft.split('\n').length - 1);
};
const heightOf = (el: Element): number => (el.querySelector('[data-scroll-anchor]') ? THREAD_HEIGHT : boxOf(el));
const maxTop = (el: Element): number => Math.max(0, heightOf(el) - boxOf(el));

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : matches.call(this, selector);
  } as typeof matches;

  const proto = window.HTMLDivElement.prototype;
  const base = Element.prototype;
  const inherited = (key: 'scrollHeight' | 'clientHeight' | 'scrollTop') =>
    Object.getOwnPropertyDescriptor(base, key) as PropertyDescriptor;
  Object.defineProperties(proto, {
    scrollHeight: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? heightOf(this) : inherited('scrollHeight').get!.call(this);
      },
    },
    clientHeight: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? boxOf(this) : inherited('clientHeight').get!.call(this);
      },
    },
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? Math.min(tops.get(this) ?? 0, maxTop(this)) : inherited('scrollTop').get!.call(this);
      },
      set(this: Element, value: number) {
        if (isThread(this)) tops.set(this, Math.max(0, Math.min(value, maxTop(this))));
        else inherited('scrollTop').set!.call(this, value);
      },
    },
  });
  restoreGeometry = () => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json([ALICE, CAROL]));
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (/\/profile-picture$/.test(path)) return Promise.resolve(json({ url: null }));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    if (path.includes('/templates')) return Promise.resolve(json([]));
    if (path.includes('/messages?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const thread = THREADS[params.get('chatId') ?? ''] ?? [];
      const page = params.get('offset') === '0' ? [...thread].reverse() : [];
      return Promise.resolve(json({ messages: page, total: page.length }));
    }
    if (/\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(json([]));
    if (path.endsWith('/chats/read')) return Promise.resolve(json({ success: true }));
    return Promise.resolve(json({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  window.sessionStorage.setItem('openwa_user_role', 'admin');
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
  restoreGeometry();
  window.sessionStorage.clear();
});

const thread = (container: HTMLElement) => container.querySelector('.room-messages') as HTMLDivElement;
const field = () => document.querySelector('.message-text-input') as HTMLTextAreaElement;

async function open(container: HTMLElement, chat: Chat): Promise<void> {
  const { screen, fireEvent } = rtl;
  const listed = (await screen.findByText(chat.name, { selector: '.chat-item-name' })).closest('[role="button"]');
  fireEvent.click(listed as HTMLElement);
  await rtl.waitFor(() => assert.ok(container.querySelector(`[data-scroll-anchor="db-${chat.name}-0"]`)));
  // The event of the write that opened the thread at its newest message.
  fireEvent.scroll(thread(container));
  assert.equal(thread(container).scrollTop, maxTop(thread(container)), `${chat.name} did not open at its bottom`);
}

async function mount(): Promise<HTMLElement> {
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
  // Both threads are read once, so each is drawn in the commit that opens it again.
  await open(container, ALICE);
  await open(container, CAROL);
  return container;
}

/** Types a draft of three lines in the open chat, whose thread follows its box. */
function typeDraft(container: HTMLElement): void {
  rtl.fireEvent.change(field(), { target: { value: 'one\ntwo\nthree' } });
  rtl.fireEvent.scroll(thread(container));
  assert.equal(thread(container).scrollTop, maxTop(thread(container)));
}

/** Opens Carol's chat again, which has the draft, and hands the thread the scroll event of the next frame. */
async function reopenCarol(container: HTMLElement): Promise<void> {
  const { screen, fireEvent } = rtl;
  const listed = screen.getByText('Carol', { selector: '.chat-item-name' }).closest('[role="button"]');
  fireEvent.click(listed as HTMLElement);
  await rtl.waitFor(() => assert.ok(container.querySelector('[data-scroll-anchor="db-Carol-0"]')));
  assert.equal(field().value, 'one\ntwo\nthree');
  assert.equal(thread(container).clientHeight, BOX_HEIGHT - 2 * LINE_HEIGHT);
  fireEvent.scroll(thread(container));
}

test('a chat with a draft of several lines opens at its newest message from another chat', async () => {
  const container = await mount();
  typeDraft(container);
  await open(container, ALICE);
  await reopenCarol(container);
  assert.equal(thread(container).scrollTop, maxTop(thread(container)));
});

test('a chat with a draft of several lines opens at its newest message after the room was closed', async () => {
  const { screen, fireEvent } = rtl;
  const container = await mount();
  typeDraft(container);
  await open(container, ALICE);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  assert.ok(container.querySelector('.room-container') === null, 'the room is still open');

  await reopenCarol(container);
  assert.equal(
    maxTop(thread(container)) - thread(container).scrollTop,
    0,
    'the newest message is under the composer by the height of the draft',
  );
});
