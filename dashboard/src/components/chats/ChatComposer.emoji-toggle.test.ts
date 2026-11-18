// The emoji button opens and closes a panel above the message field. It tells assistive technology which of the two the
// panel is in, as the other disclosure buttons of the page do.
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
let queryClient: import('@tanstack/react-query').QueryClient;

const chat: Chat = {
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

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() =>
    Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
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

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient.isFetching(), 0));
  rtl.cleanup();
  queryClient.clear();
});

after(() => {
  rtl.cleanup();
  queryClient.clear();
});

function Harness() {
  const [messageInput, setMessageInput] = useState('');
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  return createElement(ChatComposer, {
    selectedSessionId: 'sess-1',
    activeChat: chat,
    replyingTo,
    setReplyingTo,
    onMessageAppended: () => undefined,
    onSent: () => undefined,
    messageInput,
    setMessageInput,
    attachment,
    setAttachment,
    previewUrl,
    setPreviewUrl,
  });
}

const expanded = (): string | null =>
  rtl.screen.getByRole('button', { name: 'Pick emoji' }).getAttribute('aria-expanded');

test('the emoji button says whether its panel is open', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  rtl.render(wrap(createElement(Harness)));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Pick emoji' })));
  assert.equal(expanded(), 'false', 'the closed panel is not announced as closed');

  fireEvent.click(screen.getByRole('button', { name: 'Pick emoji' }));
  assert.ok(document.querySelector('.chats-emoji-picker'), 'the panel did not open');
  assert.equal(expanded(), 'true', 'the open panel is not announced as open');

  fireEvent.click(screen.getByRole('button', { name: 'Pick emoji' }));
  assert.ok(document.querySelector('.chats-emoji-picker') === null, 'the panel stayed open');
  assert.equal(expanded(), 'false');
});

test('the emoji button says closed again once an emoji is picked', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  rtl.render(wrap(createElement(Harness)));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Pick emoji' })));
  fireEvent.click(screen.getByRole('button', { name: 'Pick emoji' }));
  assert.equal(expanded(), 'true');
  fireEvent.click(document.querySelector('.chats-emoji-picker .emoji-btn') as HTMLElement);
  assert.ok(document.querySelector('.chats-emoji-picker') === null, 'the panel stayed open');
  assert.equal(expanded(), 'false', 'the panel closed and the button still says it is open');
});
