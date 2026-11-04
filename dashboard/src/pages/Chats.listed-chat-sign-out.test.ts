import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
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

const LID_CHATS: Chat[] = Array.from({ length: 7 }, (_, i) => ({
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

interface Call {
  path: string;
  key: string | null;
}
const calls: Call[] = [];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, key: headers['X-API-Key'] ?? null });
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json(LID_CHATS));
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/contacts/check/')) {
      return Promise.resolve(json({ number: '15550001111', exists: true, whatsappId: '15550001111@c.us' }));
    }
    if (/\/contacts\/[^/]+\/phone$/.test(path)) {
      const id = decodeURIComponent(path.split('/contacts/')[1].split('/phone')[0]);
      if (!headers['X-API-Key']) return Promise.resolve(json({ message: 'API key is required' }, 401));
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

let client: QueryClient | undefined;

after(async () => {
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

for (const nextKey of [null, 'replacement-test-key']) {
  test(`a privacy-id lookup stops when its key is ${nextKey === null ? 'removed' : 'replaced'}`, async () => {
    calls.length = 0;
    window.sessionStorage.setItem('openwa_api_key', 'test-key');
    const { screen, fireEvent, waitFor } = rtl;
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
      ),
    );
    await screen.findByText('Lid 0');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const search = await screen.findByPlaceholderText('Search name or number with country code');
    fireEvent.change(search, { target: { value: '+1 555 000 1111' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    const lookups = () => calls.filter(c => /\/contacts\/[^/]+\/phone$/.test(c.path));
    await waitFor(() => assert.equal(lookups().length, 5));

    if (nextKey === null) window.sessionStorage.removeItem('openwa_api_key');
    else window.sessionStorage.setItem('openwa_api_key', nextKey);
    rtl.cleanup();
    await client.cancelQueries();
    client.clear();
    const signedOutClient = client;

    await new Promise(resolve => setTimeout(resolve, 1_600));
    const keyless = lookups().filter(c => c.key !== 'test-key');
    await signedOutClient.cancelQueries();
    signedOutClient.clear();
    assert.equal(keyless.length, 0, `phone lookups sent after sign-out without a key: ${keyless.length}`);
  });
}
