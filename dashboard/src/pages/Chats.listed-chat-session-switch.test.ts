import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const base = { status: 'ready' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const SESSION_1: Session = { ...base, id: 'session-1', name: 'Main', phone: '15551234567' };
const SESSION_2: Session = { ...base, id: 'session-2', name: 'Second', phone: '15559876543' };

const LID_CHATS: Chat[] = Array.from({ length: 3 }, (_, i) => ({
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

const calls: string[] = [];
let releaseSecondList: (() => void) | null = null;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

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
    if (path.startsWith('/api/sessions/session-1/chats?')) return Promise.resolve(json(LID_CHATS));
    if (path.startsWith('/api/sessions/session-2/chats?')) {
      return new Promise(resolve => {
        releaseSecondList = () => resolve(json([]));
      });
    }
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/contacts/check/')) {
      return Promise.resolve(json({ number: '15550001111', exists: true, whatsappId: '15550001111@c.us' }));
    }
    if (/\/contacts\/[^/]+\/phone$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/phone')[0]);
      return Promise.resolve(json({ contactId: id, phone: null }));
    }
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    return Promise.resolve(json({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

after(async () => {
  releaseSecondList?.();
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

test('a number typed while a switched-to session still loads its list is not looked up among the other account chats', async () => {
  const { screen, fireEvent, within } = rtl;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  await screen.findByText('Lid 0');

  fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  const list = container.querySelector('[role="listbox"]') as HTMLElement;
  fireEvent.click(within(list).getByRole('option', { name: /Second/ }));
  await rtl.waitFor(() =>
    assert.equal(
      calls.some(p => p.startsWith('/api/sessions/session-2/chats?')),
      true,
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  const search = await screen.findByPlaceholderText('Search name or number with country code');
  fireEvent.change(search, { target: { value: '+1 555 000 1111' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  await rtl.waitFor(() =>
    assert.equal(
      calls.some(p => p.startsWith('/api/sessions/session-2/contacts/check/')),
      true,
    ),
  );
  await new Promise(resolve => setTimeout(resolve, 300));

  const crossAccount = calls.filter(p =>
    LID_CHATS.some(chat => p === `/api/sessions/session-2/contacts/${encodeURIComponent(chat.id)}/phone`),
  );
  assert.equal(
    crossAccount.length,
    0,
    `the second account was asked for the phone of ${crossAccount.length} of the first account's chats`,
  );
});
