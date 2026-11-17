// Render tests for a shared contact in the chat thread. The number on a card and in a quote of one is the number a
// reader copies to dial: its plus sign and the spaces between its digit groups are neutral to the bidi algorithm, so
// left to the direction of the page, or of an Arabic or Hebrew name before it, it is drawn with the plus at the wrong
// end and the groups in reverse order. Every other number the chat page draws is kept one left-to-right run.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';
import { isolateNumber } from '../../utils/formatPhone.ts';

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
  document.documentElement.dir = 'ltr';
});

const CHAT: Chat = {
  id: '971501234567@c.us',
  name: 'Ali',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
};

const PHONE = '+971 50 123 4567';
const vcard = (name: string, phone: string): string =>
  `BEGIN:VCARD\nVERSION:3.0\nN:;${name};;;\nFN:${name}\nitem1.TEL;waid=${phone.replace(/\D/g, '')}:${phone}\nEND:VCARD`;

const message = (over: Partial<ChatMessageView>): ChatMessageView => ({
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: '',
  type: 'contact',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  ...over,
});

function renderThread(messages: ChatMessageView[], dir: 'ltr' | 'rtl' = 'ltr'): HTMLElement {
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  document.documentElement.dir = dir;
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

test('the phone on a shared contact card is one left-to-right run in a right-to-left page', () => {
  // A number typed without spaces reverses as much as one with them, and the name beside it changes nothing.
  for (const [name, phone] of [
    ['Ali', PHONE],
    ['علي أحمد', PHONE],
    ['Ali', '+971501234567'],
  ]) {
    const container = renderThread([message({ body: vcard(name, phone) })], 'rtl');
    const field = container.querySelector('.message-contact-phone');
    assert.ok(field, `the card of ${name} drew no phone`);
    assert.equal(
      field.querySelector('bdi[dir="ltr"]')?.textContent,
      phone,
      `the phone is left to the page's direction: ${field.outerHTML}`,
    );
    // The number is isolated by markup, so what a reader selects and copies carries no invisible character.
    assert.equal(field.textContent, phone);
    rtl.cleanup();
  }
});

test('a quote of a shared contact keeps the phone one left-to-right run after an Arabic name', () => {
  const container = renderThread(
    [
      message({
        type: 'text',
        body: 'see above',
        metadata: { quotedMessage: { id: 'wamid.0', body: vcard('علي أحمد', PHONE) } },
      }),
    ],
    'ltr',
  );
  const quote = container.querySelector('.quote-body');
  assert.ok(quote, 'the quote did not render');
  assert.equal(
    quote.textContent?.includes(`علي أحمد · ${isolateNumber(PHONE)}`),
    true,
    `the quoted phone is left to the direction of the name: ${JSON.stringify(quote.textContent)}`,
  );
});

const LONG_NAME = 'Maria Fernanda de los Angeles Gutierrez Rodriguez Hernandez del Valle Montes';

// The card cuts a name longer than its width with an ellipsis, and it is the only place the page shows the contact's
// name, so the whole name stays reachable: the chat name, the room heading and the session name carry a title too.
test('a contact card cut by its width still names the contact in full', () => {
  const container = renderThread([
    message({ body: vcard(LONG_NAME, PHONE) }),
    message({ id: 'db-2', waMessageId: 'wamid.2', body: 'BEGIN:VCARD\nEND:VCARD' }),
  ]);
  const names = [...container.querySelectorAll('.message-contact-name')];
  assert.equal(names.length, 2);
  assert.equal(names[0].textContent, LONG_NAME);
  for (const name of names) {
    assert.equal(name.getAttribute('title'), name.textContent, `the name is cut with no title: ${name.outerHTML}`);
  }
});
