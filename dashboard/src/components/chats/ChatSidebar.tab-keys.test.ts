// The Chats, Channels and Status tabs of the chat sidebar are a row of role="tab" buttons: one stop in the Tab order,
// and an arrow key selects another tab and takes focus there.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Channel } from '../../services/api.ts';
import type { ChatsTab } from './ChatSidebar.tsx';

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

const noop = () => undefined;

// The page owns the active tab; the sidebar only reports the one a tab asks for.
function renderSidebar(activeTab: ChatsTab, asked: ChatsTab[]) {
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
        activeTab,
        onSwitchTab: (tab: ChatsTab) => asked.push(tab),
        searchQuery: '',
        onSearchQueryChange: noop,
        onComposeStatus: noop,
        formatChatTime: () => '',
        chatsTab: {
          loading: false,
          chats: [],
          filter: 'all',
          onFilterChange: noop,
          onSelectChat: noop,
          rowActions: undefined,
        },
        channelsTab: { engineLoading: false, supported: true, query, channels: [], onSelectChannel: noop },
        statusTab: { loading: false, error: false, groups: [], activeContactId: null, onSelectContact: noop },
      }),
    ),
  );
}

const focused = () => document.activeElement?.textContent;

test('an arrow key asks for the next sidebar tab and takes focus there, wrapping at the ends', () => {
  const asked: ChatsTab[] = [];
  renderSidebar('chats', asked);
  const [chats, channels, status] = rtl.screen.getAllByRole('tab');
  assert.deepEqual(
    [chats, channels, status].map(tab => tab.textContent),
    ['Chats', 'Channels', 'Status'],
  );
  chats.focus();
  rtl.fireEvent.keyDown(chats, { key: 'ArrowRight' });
  assert.equal(focused(), 'Channels');
  rtl.fireEvent.keyDown(channels, { key: 'End' });
  assert.equal(focused(), 'Status');
  rtl.fireEvent.keyDown(status, { key: 'ArrowRight' });
  assert.equal(focused(), 'Chats');
  rtl.fireEvent.keyDown(chats, { key: 'ArrowLeft' });
  assert.equal(focused(), 'Status');
  assert.deepEqual(asked, ['channels', 'status', 'chats', 'status']);
});

test('only the active sidebar tab is a Tab stop', () => {
  for (const active of ['chats', 'channels', 'status'] as const) {
    renderSidebar(active, []);
    const stops = rtl.screen
      .getAllByRole('tab')
      .filter(tab => tab.getAttribute('tabindex') !== '-1')
      .map(tab => tab.textContent);
    assert.deepEqual(stops, [{ chats: 'Chats', channels: 'Channels', status: 'Status' }[active]]);
    rtl.cleanup();
  }
});
