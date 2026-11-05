import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const base = { status: 'ready' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const SESSION_1: Session = { ...base, id: 'session-1', name: 'Main', phone: '15551234567' };
const SESSION_2: Session = { ...base, id: 'session-2', name: 'Second', phone: '15559876543' };

const chat = (id: string, name: string): Chat => ({
  id,
  name,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
});

// The number a case looks up; both accounts may list a conversation under it.
const TARGET = '15550001111@c.us';
const FILLER = chat('1000000000001@lid', 'Filler');

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

const calls: string[] = [];
let firstList: Chat[] = [];
let secondList: Chat[] = [];
let answerSecondList: (() => void) | undefined;
let answerNumberCheck: (() => void) | undefined;

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
    if (path === '/api/sessions') return Promise.resolve(json([SESSION_1, SESSION_2]));
    if (path.startsWith('/api/sessions/session-1/chats?')) return Promise.resolve(json(firstList));
    // The second account's list and the number check each answer when the case lets them.
    if (path.startsWith('/api/sessions/session-2/chats?')) {
      return new Promise(resolve => (answerSecondList = () => resolve(json(secondList))));
    }
    if (path.includes('/contacts/check/')) {
      return new Promise(
        resolve =>
          (answerNumberCheck = () => resolve(json({ number: '15550001111', exists: true, whatsappId: TARGET }))),
      );
    }
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/profile-picture')) return Promise.resolve(json({ url: null }));
    if (/\/contacts\/[^/]+\/phone$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/phone')[0]);
      return Promise.resolve(json({ contactId: id, phone: null }));
    }
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
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
  answerSecondList = undefined;
  answerNumberCheck = undefined;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
});

afterEach(async () => {
  answerSecondList?.();
  answerNumberCheck?.();
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

// A number typed in the New chat panel of the second account is checked while that account's list is still loading.
// The list then commits with a conversation under the checked number, and only after that does the check answer: the
// chat that opens has to come from the second account's rows, not from the rows the page held when the check began.
for (const firstListsIt of [false, true]) {
  test(`a number checked before the list of the selected account commits opens the row of that list (the previous account listed it too: ${firstListsIt})`, async () => {
    firstList = [firstListsIt ? chat(TARGET, 'First account label') : FILLER];
    secondList = [chat(TARGET, 'Second account label')];
    const { screen, fireEvent, waitFor, within } = rtl;
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    const { container } = rtl.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
      ),
    );
    await screen.findByText(firstListsIt ? 'First account label' : 'Filler');

    fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
    const options = container.querySelector('[role="listbox"]') as HTMLElement;
    fireEvent.click(within(options).getByRole('option', { name: /Second/ }));
    await waitFor(() => assert.ok(answerSecondList, 'the list of the second account was requested'));

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const search = await screen.findByPlaceholderText('Search name or number with country code');
    fireEvent.change(search, { target: { value: '+1 555 000 1111' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => assert.ok(answerNumberCheck, 'the number was checked'));

    // The list commits; the profile picture request of the second account follows the committed rows.
    await rtl.act(async () => {
      answerSecondList?.();
    });
    await waitFor(() =>
      assert.ok(calls.some(path => path.startsWith('/api/sessions/session-2/contacts/profile-pictures'))),
    );
    await rtl.act(async () => {
      answerNumberCheck?.();
    });
    await waitFor(() => assert.ok(container.querySelector('.room-header')));

    assert.equal(container.querySelectorAll('.chat-item-card').length, 1, 'the listed conversation appears once');
    assert.equal(container.querySelector('.chat-item-name')?.textContent, 'Second account label');
    assert.equal(container.querySelector('.room-header .room-contact-name')?.textContent, 'Second account label');
  });
}
