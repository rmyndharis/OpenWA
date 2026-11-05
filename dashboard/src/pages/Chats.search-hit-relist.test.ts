import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, SearchHit, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const session = (id: string, name: string): Session => ({
  id,
  name,
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const FIRST = session('session-a', 'First');
const SECOND = session('session-b', 'Second');
const THIRD = session('session-c', 'Third');

const CHAT_ID = '15550001111@c.us';
const row = (name: string): Chat => ({
  id: CHAT_ID,
  name,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
});
// A stored message of the second account, whose session the page did not list when it was loaded.
const HIT: SearchHit = {
  messageId: 'db-1',
  waMessageId: 'wa-1',
  sessionId: SECOND.id,
  chatId: CHAT_ID,
  body: 'sample',
  snippet: 'sample result',
  timestamp: 1_700_000_000,
  type: 'text',
  direction: 'incoming',
  from: CHAT_ID,
};

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

let sessionReads = 0;
let answerRelist: (() => void) | undefined;

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
    if (path === '/api/sessions') {
      // The page lists two sessions at load; the list it reads again for the hit answers when the case lets it.
      if (++sessionReads === 1) return Promise.resolve(json([FIRST, THIRD]));
      return new Promise(resolve => (answerRelist = () => resolve(json([FIRST, SECOND, THIRD]))));
    }
    if (path.startsWith('/api/search?')) return Promise.resolve(json({ hits: [HIT], total: 1 }));
    const chats = /^\/api\/sessions\/(session-[abc])\/chats\?/.exec(path);
    if (chats) return Promise.resolve(json([row(`${chats[1]} contact`)]));
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/profile-picture')) return Promise.resolve(json({ url: null }));
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
  sessionReads = 0;
  answerRelist = undefined;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
});

afterEach(async () => {
  answerRelist?.();
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

// A search hit of a session the page has not listed waits for the session list to be read again. The user can choose
// another session meanwhile, and that choice stands when the list comes back.
test('a search hit waiting for the session list yields to the session the user chose meanwhile', async () => {
  const { screen, fireEvent, waitFor, within, act } = rtl;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  await screen.findByText('session-a contact');

  fireEvent.click(screen.getByRole('button', { name: 'Search messages' }));
  fireEvent.change(container.querySelector('.global-search-input') as HTMLInputElement, {
    target: { value: 'sample' },
  });
  const result = await waitFor(() => {
    const found = container.querySelector('.global-search-hit');
    assert.ok(found, 'the hit is listed');
    return found;
  });
  fireEvent.click(result);
  await waitFor(() => assert.ok(answerRelist, 'the session list was read again for the hit'));

  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  fireEvent.click(
    within(container.querySelector('[role="listbox"]') as HTMLElement).getByRole('option', { name: /Third/ }),
  );
  await screen.findByText('session-c contact');
  assert.equal(container.querySelector('.session-switcher-btn .session-name')?.textContent, 'Third');

  await act(async () => {
    answerRelist?.();
  });

  assert.equal(container.querySelector('.session-switcher-btn .session-name')?.textContent, 'Third');
  assert.notEqual(container.querySelector('.room-header .room-contact-name')?.textContent, 'session-b contact');
});
