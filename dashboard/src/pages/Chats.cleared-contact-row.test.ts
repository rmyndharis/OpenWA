// Clearing a chat deletes its messages, so its row has no preview left. The row is emptied in place (the list is not
// read again), and a row whose last message was a shared contact must come out as empty as any other: its
// placeholder is drawn from the row's last message type, which the clear has to take back with the text.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const VCARD = 'BEGIN:VCARD\nVERSION:3.0\nFN:Carlos\nTEL;waid=34600000000:+34 600 000 000\nEND:VCARD';

const chat = (id: string, name: string, lastMessageType: Chat['lastMessageType'], lastMessage: string): Chat => ({
  id,
  name,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage,
  lastMessageType,
  archived: false,
  pinned: false,
  muted: false,
});
const CONTACT_CHAT = chat('15550001111@c.us', 'Alice', 'contact', VCARD);
const IMAGE_CHAT = chat('15550002222@c.us', 'Bob', 'image', 'holiday photo');

const calls: Array<{ method: string; path: string }> = [];
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
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json([CONTACT_CHAT, IMAGE_CHAT]));
    if (method === 'DELETE' && /\/chats\/[^/]+\/messages$/.test(path)) return Promise.resolve(json({ success: true }));
    if (/\/messages\?/.test(path)) return Promise.resolve(json({ messages: [], total: 0 }));
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/contacts/blocked')) return Promise.resolve(json([]));
    if (path.includes('/contacts?')) return Promise.resolve(json([]));
    return Promise.resolve(json({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  window.sessionStorage.setItem('openwa_api_key_id', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

after(async () => {
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

test('a cleared chat whose last message was a shared contact shows no preview, as a cleared chat of any other type does', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  await screen.findByText('Alice');
  const snippet = (id: string) => container.querySelector(`[data-chat-id="${id}"] .chat-item-snippet`)?.textContent;
  assert.match(
    snippet(CONTACT_CHAT.id) ?? '',
    /Carlos/,
    'the row does not preview the shared contact before the clear',
  );

  for (const target of [IMAGE_CHAT, CONTACT_CHAT]) {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${target.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear chat' }));
    await waitFor(() =>
      assert.ok(
        calls.some(c => c.method === 'DELETE' && c.path.includes(encodeURIComponent(target.id))),
        `${target.name} was not cleared`,
      ),
    );
    await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  }

  assert.equal(snippet(IMAGE_CHAT.id), '', 'the control row kept a preview');
  assert.equal(
    snippet(CONTACT_CHAT.id),
    '',
    `the cleared chat of a shared contact still previews: ${JSON.stringify(snippet(CONTACT_CHAT.id))}`,
  );
});
