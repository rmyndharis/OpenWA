// Render tests for the chat sidebar's list states.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Channel, Chat } from '../../services/api.ts';
import type { ChatsTab } from './ChatSidebar.tsx';
import type { ChatListFilter } from '../../utils/chatFilters.ts';

let rtl: typeof import('@testing-library/react');
let ChatSidebar: (typeof import('./ChatSidebar.tsx'))['default'];
let RoleContext: (typeof import('../../hooks/useRole.tsx'))['RoleContext'];
let t: (key: string, options?: Record<string, unknown>) => string;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady, default: i18n } = await import('../../i18n/index.ts');
  await i18nReady;
  t = (key, options) => i18n.t(key, options ?? {});
  rtl = await import('@testing-library/react');
  ({ RoleContext } = await import('../../hooks/useRole.tsx'));
  ({ default: ChatSidebar } = await import('./ChatSidebar.tsx'));
});

afterEach(() => rtl.cleanup());

const chat = (id: string, unreadCount: number): Chat => ({
  id,
  name: id.split('@')[0],
  isGroup: false,
  kind: 'individual',
  unreadCount,
  timestamp: 0,
  archived: false,
  pinned: false,
  muted: false,
});

function renderSidebar(
  activeTab: ChatsTab,
  chats: Chat[],
  channels: { all: Channel[]; shown: Channel[] },
  { filter = 'all' }: { filter?: ChatListFilter } = {},
) {
  const role = {
    role: 'operator' as const,
    setRole: () => undefined,
    isAdmin: false,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'whatsapp-web.js',
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  };
  const query = { isLoading: false, error: null, data: channels.all } as unknown as UseQueryResult<Channel[], Error>;
  return rtl.render(
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(ChatSidebar, {
        sessions: [],
        selectedSessionId: '',
        onSelectSession: () => undefined,
        activeTab,
        onSwitchTab: () => undefined,
        searchQuery: '',
        onSearchQueryChange: () => undefined,
        onComposeStatus: () => undefined,
        formatChatTime: () => '',
        chatsTab: { loading: false, chats, filter, onFilterChange: () => undefined, onSelectChat: () => undefined },
        channelsTab: {
          engineLoading: false,
          supported: true,
          query,
          channels: channels.shown,
          onSelectChannel: () => undefined,
        },
        statusTab: {
          loading: false,
          error: false,
          groups: [],
          activeContactId: null,
          onSelectContact: () => undefined,
        },
      }),
    ),
  );
}

test('a chat marked unread (count -1) shows an unread badge without a number', () => {
  const { container } = renderSidebar('chats', [chat('marked@c.us', -1), chat('read@c.us', 0), chat('new@c.us', 3)], {
    all: [],
    shown: [],
  });
  const badges = Array.from(container.querySelectorAll('.chat-unread-badge'));
  assert.deepEqual(
    badges.map(badge => [badge.textContent, badge.getAttribute('aria-label')]),
    [
      ['', t('chats.markedUnread')],
      ['3', t('chats.unreadBadge', { count: 3 })],
    ],
  );
});

test('a quick filter that leaves no chat says so, while an empty account still reads as having none', () => {
  const filtered = renderSidebar('chats', [], { all: [], shown: [] }, { filter: 'groups' });
  assert.equal(filtered.container.querySelector('.chats-list-empty')?.textContent, t('chats.noFilterResults'));
  rtl.cleanup();

  const empty = renderSidebar('chats', [], { all: [], shown: [] });
  assert.equal(empty.container.querySelector('.chats-list-empty')?.textContent, t('chats.empty'));
});

test('the quick filters show the active one as pressed, on the Chats tab only', () => {
  const { container } = renderSidebar('chats', [], { all: [], shown: [] }, { filter: 'unread' });
  const pressed = Array.from(container.querySelectorAll('.chat-filter-pill[aria-pressed="true"]'));
  assert.deepEqual(
    pressed.map(pill => pill.textContent),
    [t('chats.filters.unread')],
  );
  rtl.cleanup();

  const channels = renderSidebar('channels', [], { all: [], shown: [] });
  assert.equal(channels.container.querySelector('.chat-filters'), null);
});

test('a channel search with no match says so instead of showing a blank list', () => {
  const channel = { id: '1@newsletter', name: 'News' } as Channel;
  const { container } = renderSidebar('channels', [], { all: [channel], shown: [] });
  assert.equal(container.querySelector('.chats-list-empty')?.textContent, t('chats.empty'));
});
