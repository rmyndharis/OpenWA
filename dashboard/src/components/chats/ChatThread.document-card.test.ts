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

const realFetch = globalThis.fetch;

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = realFetch;
  window.sessionStorage.removeItem('openwa_user_role');
  window.sessionStorage.removeItem('openwa_api_key');
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
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
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

// A document the message list left out is fetched when its card is pressed. While the bytes are on their way, and
// after the gateway had none to give, the card is still the document's card: it keeps its padded content box and the
// file name, as it has them before the press. Drawn as a bare spinner or a bare "unavailable" line inside the card's
// border (the card has no padding of its own), it shrinks from the height of a card to a strip and moves the thread,
// and a failed one no longer says which document it is.
const LEFT_OUT = document_('left-out', {
  mimetype: 'application/pdf',
  filename: 'invoice.pdf',
  omitted: true,
  sizeBytes: 2_500_000,
});
const card = (container: HTMLElement) => container.querySelector('button.chat-document-card') as HTMLButtonElement;
const notFound = () =>
  new Response(JSON.stringify({ statusCode: 404, message: 'no bytes' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

test('the card of a document is whole before it is pressed', () => {
  const container = renderThread([LEFT_OUT]);
  assert.ok(card(container), 'the left-out document did not draw a card button');
  assert.ok(card(container).querySelector('.chat-document-card-content'));
  assert.equal(card(container).querySelector('.chat-document-title')?.textContent, 'invoice.pdf');
  assert.equal(card(container).querySelector('.chat-document-meta')?.textContent, '2.4 MB \u2022 PDF');
  assert.ok(
    card(container).querySelector('.chat-document-action svg:not(.animate-spin)'),
    'the download mark is missing',
  );
});

test('the card keeps its content box and its file name while the document is fetched', async () => {
  let release = () => {};
  globalThis.fetch = (() => new Promise<Response>(resolve => (release = () => resolve(notFound())))) as typeof fetch;
  const container = renderThread([LEFT_OUT]);
  rtl.fireEvent.click(card(container));
  const pressed = card(container);
  assert.equal(pressed.disabled, true, 'the card is not busy');
  assert.ok(
    pressed.querySelector('.chat-document-card-content'),
    `the card lost its padded content box: ${pressed.innerHTML}`,
  );
  assert.equal(
    pressed.querySelector('.chat-document-title')?.textContent,
    'invoice.pdf',
    `the card no longer names the file: ${pressed.innerHTML}`,
  );
  // The spinner takes the place of the download mark, so the card does not change size.
  assert.ok(pressed.querySelector('.chat-document-action .animate-spin'), 'the card shows no progress');
  assert.equal(pressed.querySelector('.chat-document-action svg:not(.animate-spin)'), null);
  assert.equal(pressed.querySelector('.chat-document-meta')?.textContent, '2.4 MB \u2022 PDF');
  // Let the held answer land, so no request outlives the test.
  release();
  await rtl.waitFor(() => assert.match(card(container).textContent ?? '', /unavailable/i), { timeout: 10_000 });
});

test('the card keeps its content box and its file name when the gateway has no bytes for it', async () => {
  globalThis.fetch = (() => Promise.resolve(notFound())) as typeof fetch;
  const container = renderThread([LEFT_OUT]);
  rtl.fireEvent.click(card(container));
  await rtl.waitFor(() => assert.match(card(container).textContent ?? '', /unavailable/i), { timeout: 10_000 });
  const failed = card(container);
  assert.ok(
    failed.querySelector('.chat-document-card-content'),
    `the failed card lost its padded content box: ${failed.innerHTML}`,
  );
  assert.equal(
    failed.querySelector('.chat-document-title')?.textContent,
    'invoice.pdf',
    `the failed card no longer names the file: ${failed.innerHTML}`,
  );
  // The failure takes the place of the size line, and the card can be pressed again.
  assert.equal(failed.querySelector('.chat-document-meta')?.textContent, 'Media unavailable');
  assert.equal(failed.disabled, false);
});

test('media that is not a document keeps its plain label while it is fetched and after it failed', async () => {
  globalThis.fetch = (() => Promise.resolve(notFound())) as typeof fetch;
  const container = renderThread([
    {
      ...LEFT_OUT,
      type: 'image',
      metadata: { media: { mimetype: 'image/jpeg', filename: 'photo.jpg', omitted: true, sizeBytes: 10 } },
    },
  ]);
  const button = container.querySelector('button.message-media-omitted') as HTMLButtonElement;
  assert.equal(button.classList.contains('chat-document-card'), false);
  assert.match(button.textContent ?? '', /Media/);
  rtl.fireEvent.click(button);
  await rtl.waitFor(() => assert.match(button.textContent ?? '', /Media unavailable/), { timeout: 10_000 });
  assert.equal(button.querySelector('.chat-document-card-content'), null);
});
