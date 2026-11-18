// A message search hit scrolls the open thread to the hit's row. The thread's container is reused by every chat, and
// the box a browser gives it is not the same from one look to the next: a desktop browser's scrollbar (Chats.css draws
// one 6px wide) takes room from its width once the thread overflows, and the header over it is taller while the in-chat
// search is open. jsdom has no layout, so the container below models those sizes, and the frame a browser runs after a
// commit: the scroll event of a moved thread first, then the ResizeObserver reports.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import type { Chat, ChatMessage, SearchHit, Session } from '../services/api';
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

const ROWS = 40;
const HIT_ROW = 5;
const message = (chatId: string, n: number): ChatMessage => ({
  id: `db-${chatId}-${n}`,
  waMessageId: `wamid.${chatId}.${n}`,
  chatId,
  from: chatId,
  to: 'me',
  body: `message number ${n}`,
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000 + n * 60,
  createdAt: new Date((1_700_000_000 + n * 60) * 1000).toISOString(),
});
const HIT: SearchHit = {
  messageId: `db-${CAROL.id}-${HIT_ROW}`,
  waMessageId: `wamid.${CAROL.id}.${HIT_ROW}`,
  sessionId: SESSION.id,
  chatId: CAROL.id,
  body: `message number ${HIT_ROW}`,
  snippet: `message number ${HIT_ROW}`,
  timestamp: 1_700_000_000 + HIT_ROW * 60,
  type: 'text',
  direction: 'incoming',
  from: CAROL.id,
};

// --- The browser's layout of the thread, as far as the page reads it ---
const FULL_WIDTH = 640;
const SCROLLBAR_WIDTH = 6;
const BOX_HEIGHT = 400;
const SEARCH_HEADER_GROWTH = 33;
const ROW_HEIGHT = 100;

const isThread = (el: Element): boolean => el.classList.contains('room-messages');
const rowCount = (el: Element): number => el.querySelectorAll('[data-scroll-anchor]').length;
// A thread still loading is one spinner, which fills the box; a loaded one is a row of its own height each.
const contentHeight = (el: Element): number => (rowCount(el) > 0 ? rowCount(el) * ROW_HEIGHT : BOX_HEIGHT);
const boxHeight = (): number =>
  BOX_HEIGHT - (document.querySelector('.room-header-searching') ? SEARCH_HEADER_GROWTH : 0);
const overflows = (el: Element): boolean => contentHeight(el) > boxHeight();
const boxWidth = (el: Element): number => FULL_WIDTH - (overflows(el) ? SCROLLBAR_WIDTH : 0);
const maxTop = (el: Element): number => Math.max(0, contentHeight(el) - boxHeight());

const tops = new WeakMap<Element, number>();
const framedTops = new WeakMap<Element, number>();
/** What the page asked the browser to scroll into the middle of the thread, in order. */
const scrolledTo: Array<{ row: string | null; top: number }> = [];

type Watch = { callback: () => void; targets: Map<Element, string> };
const watches: Watch[] = [];
class FakeResizeObserver {
  private readonly watch: Watch;
  constructor(callback: () => void) {
    this.watch = { callback, targets: new Map() };
    watches.push(this.watch);
  }
  observe(target: Element): void {
    this.watch.targets.set(target, '');
  }
  unobserve(target: Element): void {
    this.watch.targets.delete(target);
  }
  disconnect(): void {
    this.watch.targets.clear();
    const at = watches.indexOf(this.watch);
    if (at >= 0) watches.splice(at, 1);
  }
}
const sizeOf = (el: Element): string => (isThread(el) ? `${boxWidth(el)}x${boxHeight()}` : 'fixed');

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let holdCarol = false;
let releaseCarol: (() => void) | undefined;
let hits: SearchHit[] = [];

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let client: QueryClient | undefined;
const queries = new Set<Query>();
const saved: Record<string, PropertyDescriptor | undefined> = {};
const ELEMENT_PROPERTIES = ['scrollHeight', 'clientHeight', 'clientWidth', 'scrollTop'] as const;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : matches.call(this, selector);
  } as typeof matches;
  const proto = window.HTMLDivElement.prototype;
  const original = (key: string): PropertyDescriptor => Object.getOwnPropertyDescriptor(Element.prototype, key)!;
  for (const key of ELEMENT_PROPERTIES) saved[key] = Object.getOwnPropertyDescriptor(proto, key);
  Object.defineProperties(proto, {
    scrollHeight: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? contentHeight(this) : original('scrollHeight').get!.call(this);
      },
    },
    clientHeight: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? boxHeight() : original('clientHeight').get!.call(this);
      },
    },
    clientWidth: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? boxWidth(this) : original('clientWidth').get!.call(this);
      },
    },
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return isThread(this) ? Math.min(tops.get(this) ?? 0, maxTop(this)) : original('scrollTop').get!.call(this);
      },
      set(this: Element, value: number) {
        if (isThread(this)) tops.set(this, Math.max(0, Math.min(value, maxTop(this))));
        else original('scrollTop').set!.call(this, value);
      },
    },
  });
  // The browser centres the row it is asked to show, within what the thread can scroll.
  Element.prototype.scrollIntoView = function (this: Element) {
    const thread = this.closest('.room-messages');
    if (!thread) return;
    const index = Array.from(thread.querySelectorAll('[data-scroll-anchor]')).indexOf(this);
    if (index < 0) return;
    const top = Math.max(0, Math.min(index * ROW_HEIGHT - (boxHeight() - ROW_HEIGHT) / 2, maxTop(thread)));
    tops.set(thread, top);
    scrolledTo.push({ row: this.getAttribute('data-wa-message-id'), top });
  };
  (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json([ALICE, CAROL]));
    if (path.includes('/search?'))
      return Promise.resolve(json({ hits, total: hits.length, tookMs: 1, provider: 'test' }));
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (/\/profile-picture$/.test(path)) return Promise.resolve(json({ url: null }));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    if (path.includes('/messages?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const chatId = params.get('chatId') ?? '';
      const page =
        params.get('offset') === '0'
          ? Array.from({ length: ROWS }, (_, i) => message(chatId, ROWS - i)) // newest first, as the gateway answers
          : [];
      const answer = () => json({ messages: page, total: page.length });
      if (holdCarol && chatId === CAROL.id) {
        return new Promise<Response>(resolve => {
          releaseCarol = () => resolve(answer());
        });
      }
      return Promise.resolve(answer());
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
  releaseCarol?.();
  await rtl.waitFor(() => assert.equal(client?.isFetching() ?? 0, 0));
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
  for (const query of queries) query.destroy();
  queries.clear();
  client = undefined;
  holdCarol = false;
  releaseCarol = undefined;
  hits = [];
  scrolledTo.length = 0;
});

after(() => {
  const proto = window.HTMLDivElement.prototype;
  for (const key of ELEMENT_PROPERTIES) {
    if (saved[key]) Object.defineProperty(proto, key, saved[key]);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
  delete (globalThis as Record<string, unknown>).ResizeObserver;
  window.sessionStorage.clear();
});

/** What a browser does between two commits: the scroll event of a thread that moved, then the size reports. */
function frame(): void {
  rtl.act(() => {
    for (const el of Array.from(document.querySelectorAll('.room-messages'))) {
      const top = (el as HTMLElement).scrollTop;
      if (top === (framedTops.get(el) ?? 0)) continue;
      framedTops.set(el, top);
      el.dispatchEvent(new window.Event('scroll'));
    }
    for (const watch of [...watches]) {
      const changed = [...watch.targets].filter(([el, last]) => sizeOf(el) !== last);
      if (changed.length === 0) continue;
      for (const [el] of changed) watch.targets.set(el, sizeOf(el));
      watch.callback();
    }
  });
}

async function renderPage(): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
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
  await rtl.screen.findByText('Carol', { selector: '.chat-item-name' });
  return container;
}

async function openRow(container: HTMLElement, name: string): Promise<void> {
  const row = rtl.screen.getByText(name, { selector: '.chat-item-name' }).closest('[role="button"]') as HTMLElement;
  rtl.fireEvent.click(row);
  await rtl.waitFor(() => assert.ok(container.querySelector('.room-messages [data-scroll-anchor]')));
  frame();
}

/** Search the messages from the sidebar and pick the hit. */
async function pickSidebarHit(container: HTMLElement): Promise<void> {
  hits = [HIT];
  if (!container.querySelector('.global-search-input')) {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Search messages' }));
  }
  rtl.fireEvent.change(container.querySelector('.global-search-input') as HTMLInputElement, {
    target: { value: 'message' },
  });
  const found = await rtl.waitFor(() => {
    const listed = container.querySelector('.global-search-hit');
    assert.ok(listed, 'the hit is listed');
    return listed as HTMLElement;
  });
  rtl.fireEvent.click(found);
}

// The browser centres the row: the thread is oldest first, so the hit is the HIT_ROW-th row from its top.
const hitTop = (): number => (HIT_ROW - 1) * ROW_HEIGHT - (BOX_HEIGHT - ROW_HEIGHT) / 2;

test('a search hit in a chat that is still loading lands on its message when the loaded thread takes room for a scrollbar', async () => {
  holdCarol = true;
  const container = await renderPage();
  await pickSidebarHit(container);
  await rtl.waitFor(() => assert.ok(container.querySelector('.room-messages .messages-loading')));
  // The browser reports the box of the spinner: no scrollbar yet.
  frame();
  await rtl.act(async () => {
    releaseCarol?.();
  });
  await rtl.waitFor(() => assert.ok(container.querySelector('.room-messages [data-scroll-anchor]')));
  assert.deepEqual(scrolledTo, [{ row: HIT.waMessageId, top: hitTop() }], 'the page did not scroll to the hit');

  // The thread overflows now, and the scrollbar is taken from its width: that is its next look.
  frame();
  const thread = container.querySelector('.room-messages') as HTMLElement;
  assert.equal(thread.scrollTop, hitTop(), `the thread ended at ${thread.scrollTop}, not on the hit`);
});

test('a search hit in a chat whose thread is already loaded lands on its message when the chat left had its in-chat search open', async () => {
  const container = await renderPage();
  await openRow(container, 'Carol');
  await openRow(container, 'Alice');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Search in chat' }));
  // The search takes more of the header: the thread is shorter, and the browser reports it.
  frame();
  assert.equal(
    (container.querySelector('.room-messages') as HTMLElement).clientHeight,
    BOX_HEIGHT - SEARCH_HEADER_GROWTH,
  );

  await pickSidebarHit(container);
  await rtl.waitFor(() =>
    assert.equal(container.querySelector('.room-header .room-contact-name')?.textContent, 'Carol'),
  );
  assert.deepEqual(scrolledTo, [{ row: HIT.waMessageId, top: hitTop() }], 'the page did not scroll to the hit');

  // The header is as tall as it was again, so the thread is taller than when it was last looked at.
  frame();
  const thread = container.querySelector('.room-messages') as HTMLElement;
  assert.equal(thread.scrollTop, hitTop(), `the thread ended at ${thread.scrollTop}, not on the hit`);
});

// The in-chat search scrolls from an event handler, on a box the page has already looked at: it is not undone.
test('a hit and a day picked in the in-chat search keep the thread on their rows', async () => {
  const container = await renderPage();
  await openRow(container, 'Carol');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Search in chat' }));
  frame();
  hits = [HIT];
  const field = rtl.screen.getByLabelText('Search') as HTMLInputElement;
  rtl.fireEvent.change(field, { target: { value: 'message' } });
  rtl.fireEvent.click((await rtl.screen.findAllByRole('option'))[0]);
  frame();
  const thread = container.querySelector('.room-messages') as HTMLElement;
  const searchBox = BOX_HEIGHT - SEARCH_HEADER_GROWTH;
  assert.equal(thread.scrollTop, (HIT_ROW - 1) * ROW_HEIGHT - (searchBox - ROW_HEIGHT) / 2, 'the hit was left behind');

  // The text goes, and the day of the rows is picked: the first row of the day is the thread's first row.
  rtl.fireEvent.change(field, { target: { value: '' } });
  const first = new Date(message(CAROL.id, 1).timestamp! * 1000);
  const day = [first.getFullYear(), first.getMonth() + 1, first.getDate()]
    .map(n => String(n).padStart(2, '0'))
    .join('-');
  rtl.fireEvent.change(container.querySelector('.room-search input[type="date"]') as HTMLInputElement, {
    target: { value: day },
  });
  frame();
  assert.equal(thread.scrollTop, 0, 'the day was left behind');
});
