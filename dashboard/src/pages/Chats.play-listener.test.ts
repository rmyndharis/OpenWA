// Starting an audio or video element pauses the others while the Chats page is open (a document-level capture listener
// for `play`). The listener belongs to the page: once the page is closed it must be gone, or every later playback in
// the dashboard keeps running the closed page's handler.
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
const CHAT: Chat = {
  id: '15550001111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage: 'hello',
  lastMessageType: 'text',
  archived: false,
  pinned: false,
  muted: false,
};

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
    if (path === '/api/sessions') return Promise.resolve(json([SESSION]));
    if (/\/chats\?/.test(path)) return Promise.resolve(json([CHAT]));
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

// A page still mounted when an assertion fails would hold the process open until the runner's timeout.
afterEach(() => rtl.cleanup());

after(async () => {
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

test('the page pauses other media while it is open and stops once it is closed', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const view = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  // The list has landed, so no request is left out when the page closes.
  await rtl.screen.findByText('Alice');

  const playing = document.createElement('audio');
  const other = document.createElement('audio');
  let playingPaused = false;
  Object.defineProperty(playing, 'paused', { get: () => playingPaused, configurable: true });
  Object.defineProperty(other, 'paused', { get: () => false, configurable: true });
  playing.pause = () => {
    playingPaused = true;
  };
  document.body.append(playing, other);
  try {
    const PlayEvent = other.ownerDocument.defaultView?.Event ?? Event;
    // The control: with the page open, a play event on one element pauses the other.
    other.dispatchEvent(new PlayEvent('play'));
    assert.equal(playingPaused, true, 'the open page did not pause the other media');

    playingPaused = false;
    view.unmount();
    other.dispatchEvent(new PlayEvent('play'));
    assert.equal(playingPaused, false, 'the closed page still pauses media');
  } finally {
    playing.remove();
    other.remove();
  }
});
