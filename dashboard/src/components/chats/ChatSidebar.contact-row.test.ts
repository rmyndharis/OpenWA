// Render tests for the preview a chat list row draws when its last message is a shared contact. The gateway stores the
// contact's vCard as the message body, so the row reads the contact's name and phone from it, and a placeholder when
// the card holds neither or the row has no text left.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Channel, Chat } from '../../services/api.ts';
import { isolateNumber } from '../../utils/formatPhone.ts';

let rtl: typeof import('@testing-library/react');
let ChatSidebar: (typeof import('./ChatSidebar.tsx'))['default'];
let RoleContext: (typeof import('../../hooks/useRole.tsx'))['RoleContext'];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleContext } = await import('../../hooks/useRole.tsx'));
  ({ default: ChatSidebar } = await import('./ChatSidebar.tsx'));
});

afterEach(() => rtl.cleanup());

const VCARD =
  'BEGIN:VCARD\nVERSION:3.0\nN:;Carlos;;;\nFN:Carlos\nitem1.TEL;waid=5491161862313:+54 9 11 6186-2313\nEND:VCARD';

const chat = (id: string, lastMessage: string | undefined, lastMessageType: Chat['lastMessageType']): Chat => ({
  id,
  name: id.split('@')[0],
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  // A row with no timestamp is a chat with no message at all, which the row says in words.
  timestamp: 1_700_000_000,
  lastMessage,
  lastMessageType,
  archived: false,
  pinned: false,
  muted: false,
});

const noop = () => undefined;

function renderSidebar(chats: Chat[]) {
  const role = {
    role: 'operator' as const,
    setRole: noop,
    isAdmin: false,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'whatsapp-web.js',
    setEngineType: noop,
    scoped: false,
    setScoped: noop,
  };
  const query = { isLoading: false, error: null, data: [] } as unknown as UseQueryResult<Channel[], Error>;
  return rtl.render(
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(ChatSidebar, {
        sessions: [],
        selectedSessionId: '',
        onSelectSession: noop,
        activeTab: 'chats',
        onSwitchTab: noop,
        searchQuery: '',
        onSearchQueryChange: noop,
        onComposeStatus: noop,
        formatChatTime: () => '',
        chatsTab: { loading: false, chats, filter: 'all', onFilterChange: noop, onSelectChat: noop },
        channelsTab: {
          engineLoading: false,
          supported: true,
          query,
          channels: [],
          onSelectChannel: noop,
        },
        statusTab: { loading: false, error: false, groups: [], activeContactId: null, onSelectContact: noop },
      }),
    ),
  ).container;
}

/** What each row's preview says, by the number in the row's chat id. */
const previews = (container: HTMLElement): Record<string, string | null | undefined> =>
  Object.fromEntries(
    [...container.querySelectorAll('.chat-item-card')].map(card => [
      card.getAttribute('data-chat-id')?.split('@')[0],
      card.querySelector('.chat-item-snippet')?.textContent,
    ]),
  );

test('a row whose last message is a shared contact previews the name and the isolated phone, never the vCard text', () => {
  const container = renderSidebar([chat('1@c.us', VCARD, 'contact')]);
  assert.equal(previews(container)['1'], `Carlos · ${isolateNumber('+54 9 11 6186-2313')}`);
});

test('a row whose last message is a contact the gateway sent previews the stored name', () => {
  const container = renderSidebar([chat('1@c.us', '\u{1F4C7} Carol Jones', 'contact')]);
  assert.equal(previews(container)['1'], '\u{1F4C7} Carol Jones');
});

test('a row with a vCard for its text previews it as a contact, whatever type the row carries', () => {
  const container = renderSidebar([chat('1@c.us', VCARD, undefined), chat('2@c.us', VCARD, 'text')]);
  const expected = `Carlos · ${isolateNumber('+54 9 11 6186-2313')}`;
  assert.deepEqual(previews(container), { '1': expected, '2': expected });
});

test('a contact row whose card holds no name or phone, or no text, previews the Contact placeholder', () => {
  const container = renderSidebar([
    chat('1@c.us', 'BEGIN:VCARD\nEND:VCARD', 'contact'),
    chat('2@c.us', '', 'contact'),
    chat('3@c.us', undefined, 'contact'),
  ]);
  assert.deepEqual(previews(container), {
    '1': '\u{1F464} Contact',
    '2': '\u{1F464} Contact',
    '3': '\u{1F464} Contact',
  });
});

test('every other row keeps its text as written, and a cleared row with no type previews nothing', () => {
  const container = renderSidebar([
    chat('1@c.us', 'see you at 5', 'text'),
    chat('2@c.us', 'FN:Mallory TEL:+1 555 000 0000', 'text'),
    chat('3@c.us', '', undefined),
  ]);
  assert.deepEqual(previews(container), { '1': 'see you at 5', '2': 'FN:Mallory TEL:+1 555 000 0000', '3': '' });
});
