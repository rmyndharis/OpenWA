// An in-flight send in one conversation must not lock the composer of another conversation when the operator
// switches chats while the first request is still pending.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState, type ReactNode } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';
import type { StagedAttachment } from './ChatComposer.tsx';

let rtl: typeof import('@testing-library/react');
let ChatComposer: (typeof import('./ChatComposer.tsx'))['default'];
let wrap: (children: ReactNode) => ReactNode;

const aliceChat: Chat = {
  id: 'alice@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 0,
  archived: false,
  pinned: false,
  muted: false,
};

const carolChat: Chat = {
  id: 'carol@c.us',
  name: 'Carol',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 0,
  archived: false,
  pinned: false,
  muted: false,
};

const pendingResolvers: Array<() => void> = [];
const sentBodies: Array<{ chatId?: string; text?: string }> = [];
const onSentCalls: Array<{ sessionId: string; chatId: string; snippet: string }> = [];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = init?.body ? (JSON.parse(String(init.body)) as { chatId?: string; text?: string }) : {};
    sentBodies.push(parsed);
    const idx = sentBodies.length;
    return new Promise<Response>(resolve => {
      pendingResolvers.push(() =>
        resolve(
          new Response(JSON.stringify({ messageId: `sent-${idx}` }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    });
  }) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  const queryClient = new QueryClient();
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: false,
    isViewer: false,
    canWrite: true,
    engineType: null,
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  };
  wrap = children =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleContext.Provider, { value: role }, createElement(ToastProvider, null, children)),
    );
  ({ default: ChatComposer } = await import('./ChatComposer.tsx'));
});

afterEach(() => {
  while (pendingResolvers.length > 0) pendingResolvers.shift()?.();
  rtl.cleanup();
  sentBodies.length = 0;
  onSentCalls.length = 0;
});

after(() => rtl.cleanup());

function Harness({ activeChat }: { activeChat: Chat }) {
  const [messageInput, setMessageInput] = useState('');
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  return createElement(ChatComposer, {
    selectedSessionId: 'sess-1',
    activeChat,
    replyingTo,
    setReplyingTo,
    onMessageAppended: () => undefined,
    onSent: (sessionId, chatId, snippet) => {
      onSentCalls.push({ sessionId, chatId, snippet });
    },
    messageInput,
    setMessageInput,
    attachment,
    setAttachment,
    previewUrl,
    setPreviewUrl,
  });
}

test('switching to another chat while a send is in flight does not disable the new chat composer', async () => {
  const { screen, fireEvent, waitFor, act } = rtl;
  const { container, rerender } = rtl.render(wrap(createElement(Harness, { activeChat: aliceChat })));

  fireEvent.click(screen.getByRole('button', { name: 'Pick emoji' }));
  assert.equal(container.querySelector('.chats-emoji-picker') !== null, true, 'emoji picker should open in Alice chat');

  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'hello alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.equal(sentBodies.length, 1));

  // Switch to Carol while Alice's send is still in flight.
  rerender(wrap(createElement(Harness, { activeChat: carolChat })));
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'urgent for carol' } });

  const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  const attachButton = screen.getByRole('button', { name: 'Send file / image' }) as HTMLButtonElement;
  assert.equal(sendButton.disabled, false, "Carol's Send button is disabled because Alice's send is still in flight");
  assert.equal(
    attachButton.disabled,
    false,
    "Carol's Attach file button is disabled because Alice's send is still in flight",
  );
  assert.equal(
    container.querySelector('.chats-emoji-picker') === null,
    true,
    'switching chats must close the open emoji picker',
  );

  // Send in Carol's chat while Alice's send is still pending.
  fireEvent.click(sendButton);
  await waitFor(() => assert.equal(sentBodies.length, 2));
  assert.deepEqual(sentBodies, [
    { chatId: 'alice@c.us', text: 'hello alice' },
    { chatId: 'carol@c.us', text: 'urgent for carol' },
  ]);

  // Resolve Alice's send first: Carol's send is still in flight, so Carol's composer stays in sending state until Carol's settles.
  await act(async () => {
    pendingResolvers.shift()?.();
  });
  await waitFor(() =>
    assert.deepEqual(onSentCalls, [{ sessionId: 'sess-1', chatId: 'alice@c.us', snippet: 'hello alice' }]),
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Send file / image' }) as HTMLButtonElement).disabled,
    true,
    "Carol's composer should stay busy while Carol's own send is still in flight",
  );

  await act(async () => {
    pendingResolvers.shift()?.();
  });
  await waitFor(() =>
    assert.equal((screen.getByRole('button', { name: 'Send file / image' }) as HTMLButtonElement).disabled, false),
  );
  assert.deepEqual(onSentCalls, [
    { sessionId: 'sess-1', chatId: 'alice@c.us', snippet: 'hello alice' },
    { sessionId: 'sess-1', chatId: 'carol@c.us', snippet: 'urgent for carol' },
  ]);
});
