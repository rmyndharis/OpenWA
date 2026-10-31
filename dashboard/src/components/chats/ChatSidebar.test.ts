// Render tests for the chat sidebar's list states.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Channel, Chat } from '../../services/api.ts';
import type { ChatsTab } from './ChatSidebar.tsx';
import type { ChatRowActions } from './chatActionItems.tsx';
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

// Stable across renders, as the page passes them (formatChatTime is a useCallback, onSelectChat a state setter), so a
// memoized row is drawn again only for what it shows.
const noop = () => undefined;
const noTime = () => '';

function sidebarElement(
  activeTab: ChatsTab,
  chats: Chat[],
  channels: { all: Channel[]; shown: Channel[] },
  { filter = 'all', rowActions }: { filter?: ChatListFilter; rowActions?: ChatRowActions } = {},
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
  return createElement(
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
      formatChatTime: noTime,
      chatsTab: { loading: false, chats, filter, onFilterChange: noop, onSelectChat: noop, rowActions },
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
  );
}

function renderSidebar(...args: Parameters<typeof sidebarElement>) {
  return rtl.render(sidebarElement(...args));
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
  // A label on an element with no role is not announced: each badge is an image named by it, as the pin and mute are.
  for (const name of [t('chats.markedUnread'), t('chats.unreadBadge', { count: 3 })]) {
    assert.equal(rtl.screen.queryAllByRole('img', { name }).length, 1, `${name} is not announced`);
  }
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
  assert.equal(channels.container.querySelectorAll('.chat-filters').length, 0);
});

test('a channel search with no match says so instead of showing a blank list', () => {
  const channel = { id: '1@newsletter', name: 'News' } as Channel;
  const { container } = renderSidebar('channels', [], { all: [channel], shown: [] });
  assert.equal(container.querySelector('.chats-list-empty')?.textContent, t('chats.empty'));
});

test('a Retry that is running is dimmed and shows the progress cursor', () => {
  // The button stays focusable while it runs (aria-disabled, not disabled), so only a rule on that attribute
  // tells a sighted operator it is busy.
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  const rule = css.match(/\.chats-page \.btn-secondary\[aria-disabled=['"]true['"]\]\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /opacity:\s*0?\.[0-9]+/);
  assert.match(rule, /cursor:\s*progress/);
});

// What a page render passes: new functions each time, with the address book answer of that render.
function rowActionsOf(saved: boolean, picked: boolean[]): ChatRowActions {
  return {
    onMenuOpen: noop,
    onGroupInfo: noop,
    onContactInfo: noop,
    onSaveContact: () => picked.push(saved),
    canSaveContact: () => true,
    isSavedContact: () => saved,
  };
}

const noChannels = { all: [], shown: [] };
const trigger = (name: string) => rtl.screen.getByRole('button', { name: t('chats.rowActions.actionsFor', { name }) });
const popovers = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.chat-row-menu-popover'));

test("opening a row's menu closes any other, and the open one follows the page's actions", () => {
  const chats = [chat('111111111@c.us', 0), chat('222222222@c.us', 0)];
  const picked: boolean[] = [];
  const view = renderSidebar('chats', chats, noChannels, { rowActions: rowActionsOf(false, picked) });
  // Enter on a chevron is a click with no mousedown, so no press outside closes the menu opened first.
  rtl.fireEvent.click(trigger('111111111'));
  rtl.fireEvent.click(trigger('222222222'));
  assert.equal(popovers(view.container).length, 1, 'two row menus are open at once');
  assert.deepEqual(
    [trigger('111111111').getAttribute('aria-expanded'), trigger('222222222').getAttribute('aria-expanded')],
    ['false', 'true'],
  );

  // The address book answers: the page renders again with actions that call the contact saved.
  view.rerender(sidebarElement('chats', chats, noChannels, { rowActions: rowActionsOf(true, picked) }));
  const rename = t('chats.rowActions.renameContact');
  rtl.fireEvent.click(rtl.within(popovers(view.container)[0]).getByRole('button', { name: rename }));
  assert.deepEqual(picked, [true], "the entry ran an earlier render's handler");
  assert.equal(popovers(view.container).length, 0, 'picking an entry left the menu open');

  // The first row's menu opens on the page's current actions too, and its chevron closes it again.
  rtl.fireEvent.click(trigger('111111111'));
  assert.ok(rtl.within(popovers(view.container)[0]).queryByRole('button', { name: rename }), 'Save is still offered');
  rtl.fireEvent.click(trigger('111111111'));
  assert.equal(popovers(view.container).length, 0, 'the chevron did not close its menu');
});

test('a row menu open when the list is swapped out is closed when the list comes back', () => {
  const chats = [chat('111111111@c.us', 0)];
  const rowActions = rowActionsOf(false, []);
  const view = renderSidebar('chats', chats, noChannels, { rowActions });
  rtl.fireEvent.click(trigger('111111111'));
  assert.equal(popovers(view.container).length, 1, 'the menu did not open');

  view.rerender(sidebarElement('channels', chats, noChannels, { rowActions }));
  view.rerender(sidebarElement('chats', chats, noChannels, { rowActions }));
  assert.equal(popovers(view.container).length, 0, 'the menu came back open with the list');
  assert.equal(trigger('111111111').getAttribute('aria-expanded'), 'false');
});
