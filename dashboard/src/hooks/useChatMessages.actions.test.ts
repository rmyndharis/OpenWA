import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let rtl: typeof import('@testing-library/react');
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let useToastActions: (typeof import('../hooks/useToast.ts'))['useToastActions'];
let useChatMessagesActions: (typeof import('./useChatMessages.ts'))['useChatMessagesActions'];
let hasCachedSessionMessage: (typeof import('./useChatMessages.ts'))['hasCachedSessionMessage'];
let messagesQueryKey: (typeof import('./useChatMessages.ts'))['messagesQueryKey'];

const clients: QueryClient[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ useToastActions } = await import('../hooks/useToast.ts'));
  ({ useChatMessagesActions, hasCachedSessionMessage, messagesQueryKey } = await import('./useChatMessages.ts'));
});

afterEach(() => {
  rtl.cleanup();
  for (const c of clients.splice(0)) c.clear();
});

test('useToastActions and useChatMessagesActions stay referentially stable when toasts change', () => {
  const client = new QueryClient();
  clients.push(client);
  const capturedToastActions: Array<ReturnType<typeof useToastActions>> = [];
  const capturedChatActions: Array<ReturnType<typeof useChatMessagesActions>> = [];

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, children));

  const { result } = rtl.renderHook(
    () => {
      const toastActions = useToastActions();
      const chatActions = useChatMessagesActions();
      capturedToastActions.push(toastActions);
      capturedChatActions.push(chatActions);
      return { toastActions, chatActions };
    },
    { wrapper },
  );

  rtl.act(() => {
    result.current.toastActions.success('Saved');
  });
  rtl.act(() => {
    result.current.toastActions.error('Warned');
  });

  assert.ok(capturedToastActions.length >= 3);
  for (const inst of capturedToastActions) {
    assert.equal(inst, capturedToastActions[0]);
  }
  for (const inst of capturedChatActions) {
    assert.equal(inst, capturedChatActions[0]);
  }
});

test('hasCachedSessionMessage detects matching message ID or waMessageId across session chats', () => {
  const client = new QueryClient();
  clients.push(client);
  const msg = {
    id: 'db-10',
    waMessageId: 'wamid.10',
    chatId: 'alice@c.us',
    from: 'alice@c.us',
    to: 'me',
    body: 'hi',
    type: 'text',
    direction: 'incoming' as const,
    status: 'delivered',
    timestamp: 1_700_000_010,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'db' as const,
    ts: 1_700_000_010,
    sortKey: '000001700000010_db-10',
  };
  const data = {
    pages: [{ db: [msg], history: [], dbTotal: 1, nextOffset: 100 }],
    pageParams: [0],
  };
  client.setQueryData(messagesQueryKey('s1', 'alice@c.us'), data);

  assert.equal(
    hasCachedSessionMessage(client, 's1', m => m.id === 'db-10'),
    true,
  );
  assert.equal(
    hasCachedSessionMessage(client, 's1', m => m.waMessageId === 'wamid.10'),
    true,
  );
  assert.equal(
    hasCachedSessionMessage(client, 's1', m => m.id === 'missing'),
    false,
  );
  assert.equal(
    hasCachedSessionMessage(client, 's2', m => m.id === 'db-10'),
    false,
  );
});
