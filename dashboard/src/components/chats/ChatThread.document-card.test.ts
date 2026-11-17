// Render tests for the document card in the chat thread: the held document's link and the button of one the message
// list left out.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let ChatThread: typeof import('./ChatThread.tsx').default;
let RoleProvider: typeof import('../RoleProvider.tsx').RoleProvider;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../RoleProvider.tsx'));
  ({ default: ChatThread } = await import('./ChatThread.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  window.sessionStorage.removeItem('openwa_user_role');
});

const CHAT: Chat = {
  id: '15551234567@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
};

const document_ = (id: string, media: NonNullable<ChatMessageView['metadata']>['media']): ChatMessageView => ({
  id,
  waMessageId: `wamid.${id}`,
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: '',
  type: 'document',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  metadata: { media },
});

function renderThread(messages: ChatMessageView[]): HTMLElement {
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  const noop = () => {};
  return rtl.render(
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 's1',
        activeChat: CHAT,
        messages,
        loadingMessages: false,
        messagesError: false,
        messagesContainerRef: createRef<HTMLDivElement>(),
        hasMoreMessages: false,
        loadingOlderMessages: false,
        onLoadOlderMessages: noop,
        onMediaLoad: noop,
        measureMedia: noop,
        onOpenImage: noop,
        onReply: noop,
        onReact: noop,
        onDelete: noop,
        onClickButton: async () => {},
      }),
    ),
  ).container;
}

const FILENAME = 'Annual_Financial_Report_Q3_2026_final_v2_REVISED_by_accounting_dept.pdf';

// The card cuts a name longer than its width with an ellipsis, and it is the only place the page shows the file's
// name, so the whole name stays reachable: the chat name, the room heading and the session name carry a title too.
test('a document card cut by its width still names the file in full', () => {
  const container = renderThread([
    document_('held', { mimetype: 'application/pdf', filename: FILENAME, data: 'JVBERi0=' }),
    document_('left-out', { mimetype: 'application/pdf', filename: FILENAME, omitted: true, sizeBytes: 2_000_000 }),
    document_('unnamed', { mimetype: 'application/pdf', data: 'JVBERi0=' }),
  ]);
  const titles = [...container.querySelectorAll('.chat-document-title')];
  assert.equal(titles.length, 3, 'every document should draw a card');
  for (const title of titles) {
    assert.equal(
      title.getAttribute('title'),
      title.textContent,
      `the file name is cut with no title: ${title.outerHTML}`,
    );
  }
  assert.equal(titles[0].textContent, FILENAME);
});
