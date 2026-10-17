import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BellOff,
  Pin,
  CircleDashed,
  Loader2,
  Megaphone,
  MessageSquarePlus,
  Plus,
  Search,
  TextSearch,
  X,
} from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Channel, Chat, ContactStatusGroup, Session } from '../../services/api';
import { useRole } from '../../hooks/useRole';
import { CHAT_LIST_FILTERS, type ChatListFilter } from '../../utils/chatFilters';
import ChatAvatar from './ChatAvatar';
import SessionPicker from './SessionPicker';
import ChatRowMenu from './ChatRowMenu';
import type { ChatRowActions } from './chatActionItems';

export type ChatsTab = 'chats' | 'channels' | 'status';

interface ChatSidebarProps {
  /** The ready sessions the page can open. */
  sessions: Session[];
  /** Every session the gateway lists, for the switcher to show with its state; defaults to `sessions`. */
  pickerSessions?: Session[];
  selectedSessionId: string;
  onSelectSession: (sessionId: string) => void;
  activeTab: ChatsTab;
  onSwitchTab: (tab: ChatsTab) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onComposeStatus: () => void;
  formatChatTime: (timestamp?: number) => string;
  /** The full-text message search, or null when this key may not search. Shown behind a header toggle. */
  messageSearch?: ReactNode;
  /** Opens the new-chat panel; absent for a key that cannot write. */
  onNewChat?: () => void;
  /** The new-chat panel, rendered in place of the lists while it is open. */
  newChatPanel?: ReactNode;
  chatsTab: {
    loading: boolean;
    chats: Chat[];
    filter: ChatListFilter;
    onFilterChange: (filter: ChatListFilter) => void;
    activeChatId?: string;
    pictures?: Record<string, string | null>;
    onSelectChat: (chat: Chat) => void;
    /** The actions behind the chevron on a group or 1:1 row. */
    rowActions?: ChatRowActions;
    /** The archive: how many chats it holds, whether the list shows it, and the switch between the two. */
    archive?: { count: number; showing: boolean; onToggle: () => void };
  };
  channelsTab: {
    engineLoading: boolean;
    supported: boolean;
    query: UseQueryResult<Channel[], Error>;
    channels: Channel[];
    activeChannelId?: string;
    onSelectChannel: (channel: Channel) => void;
  };
  statusTab: {
    loading: boolean;
    error: boolean;
    groups: ContactStatusGroup[];
    activeContactId: string | null;
    onSelectContact: (contactId: string) => void;
  };
}

// LEFT SIDEBAR: session switcher, header actions, Chats/Channels/Status tab bar, search, quick filters,
// and the per-tab lists. The page owns all queries/state; this component renders them and reports
// interactions up.
function ChatSidebar({
  sessions,
  pickerSessions,
  selectedSessionId,
  onSelectSession,
  activeTab,
  onSwitchTab,
  searchQuery,
  onSearchQueryChange,
  onComposeStatus,
  formatChatTime,
  messageSearch,
  onNewChat,
  newChatPanel,
  chatsTab,
  channelsTab,
  statusTab,
}: ChatSidebarProps) {
  const { t } = useTranslation();
  // Posting a status needs an operator key; a read-only key would only reach a 403.
  const { canWrite } = useRole();
  const [showMessageSearch, setShowMessageSearch] = useState(false);

  const formatLastMessageSnippet = (chat: Chat) => chat.lastMessage || '';

  // Row markup for the Chats list: a plain function (not memoized) since it closes over
  // render-scoped props (chatsTab.activeChatId, chatsTab.pictures) that already change every
  // render.
  const renderChatRow = (chat: Chat) => {
    const isActive = chatsTab.activeChatId === chat.id;
    return (
      <div
        key={chat.id}
        role="button"
        tabIndex={0}
        aria-current={isActive ? 'true' : undefined}
        className={`chat-item-card ${isActive ? 'active' : ''} ${chat.unreadCount !== 0 ? 'unread' : ''}`}
        onClick={() => chatsTab.onSelectChat(chat)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            chatsTab.onSelectChat(chat);
          }
        }}
      >
        <ChatAvatar chatId={chat.id} pictureUrl={chatsTab.pictures?.[chat.id]} kind={chat.kind} />

        <div className="chat-item-info">
          <div className="chat-item-top">
            <span className="chat-item-name" title={chat.name || chat.id}>
              {chat.name || chat.id.split('@')[0]}
            </span>
            {chat.kind !== 'individual' && chat.kind !== 'unknown' && (
              <span className={`chat-kind-badge kind-${chat.kind}`}>{t(`chats.kind.${chat.kind}`)}</span>
            )}
            {/* Ternary, not `&&`: a chat with no messages carries timestamp 0, and React
                renders the number 0 as text — so `0 && <span/>` painted a literal "0"
                where the time belongs, on every such row. */}
            {chat.timestamp ? <span className="chat-item-time">{formatChatTime(chat.timestamp)}</span> : null}
          </div>
          <div className="chat-item-bottom">
            {/* An empty snippet with a timestamp is a message with no text (a voice note, a sticker,
                an uncaptioned photo), not an empty chat. */}
            <span className="chat-item-snippet" title={formatLastMessageSnippet(chat)}>
              {formatLastMessageSnippet(chat) ||
                (!chat.timestamp && <span className="no-message">{t('chats.noMessageYet')}</span>)}
            </span>
            {(chat.muted || chat.pinned) && (
              <span className="chat-item-flags">
                {chat.muted && <BellOff size={15} role="img" aria-label={t('chats.rowActions.mutedLabel')} />}
                {chat.pinned && <Pin size={15} role="img" aria-label={t('chats.rowActions.pinnedLabel')} />}
              </span>
            )}
            {/* A negative count is a chat marked unread (Baileys reports -1): a badge with no number. */}
            {chat.unreadCount < 0 ? (
              <span
                className="chat-unread-badge"
                title={t('chats.markedUnread')}
                aria-label={t('chats.markedUnread')}
              />
            ) : chat.unreadCount > 0 ? (
              <span
                className="chat-unread-badge"
                title={t('chats.unreadBadge', { count: chat.unreadCount })}
                aria-label={t('chats.unreadBadge', { count: chat.unreadCount })}
              >
                {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  if (newChatPanel) {
    return <aside className="chats-sidebar">{newChatPanel}</aside>;
  }

  return (
    <aside className="chats-sidebar">
      <header className="sidebar-header">
        <SessionPicker
          sessions={pickerSessions ?? sessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
          canAddSession={canWrite}
        />

        <div className="sidebar-header-actions">
          {messageSearch && (
            <button
              type="button"
              className={`icon-btn ${showMessageSearch ? 'active' : ''}`}
              onClick={() => setShowMessageSearch(open => !open)}
              title={t('chats.searchMessages')}
              aria-label={t('chats.searchMessages')}
              aria-pressed={showMessageSearch}
            >
              <TextSearch size={22} />
            </button>
          )}
          {onNewChat && (
            <button
              type="button"
              className="icon-btn"
              onClick={onNewChat}
              title={t('chats.newChat.title')}
              aria-label={t('chats.newChat.title')}
            >
              <MessageSquarePlus size={22} />
            </button>
          )}
        </div>
      </header>

      {/* Full-text search over the stored messages of every session, collapsed by default. */}
      {messageSearch && showMessageSearch && <div className="sidebar-message-search">{messageSearch}</div>}

      <div className="sidebar-header-box">
        {/* Chats / Channels / Status tabs */}
        <div className="chats-tabs" role="tablist">
          {(['chats', 'channels', 'status'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`chats-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => onSwitchTab(tab)}
            >
              {t(`chats.tab.${tab}`)}
            </button>
          ))}
        </div>

        {/* Search bar */}
        <div className="chat-search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('chats.searchPlaceholder')}
            value={searchQuery}
            onChange={e => onSearchQueryChange(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear"
              onClick={() => onSearchQueryChange('')}
              aria-label={t('chats.clearSearch')}
              title={t('chats.clearSearch')}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Compose a new status — only meaningful on the Status tab. */}
        {activeTab === 'status' && canWrite && (
          <button type="button" className="btn-primary status-compose-trigger" onClick={onComposeStatus}>
            <Plus size={16} />
            {t('chats.status.compose')}
          </button>
        )}
      </div>

      {/* Quick filters over the chat list. Toggle buttons, not tabs: the tab bar above already is one. */}
      {activeTab === 'chats' && (
        <div className="chat-filters" role="group" aria-label={t('chats.filters.label')}>
          {CHAT_LIST_FILTERS.map(filter => (
            <button
              key={filter}
              type="button"
              aria-pressed={chatsTab.filter === filter}
              className={`chat-filter-pill ${chatsTab.filter === filter ? 'active' : ''}`}
              onClick={() => chatsTab.onFilterChange(filter)}
            >
              {t(`chats.filters.${filter}`)}
            </button>
          ))}
        </div>
      )}

      {/* Chat list */}
      {activeTab === 'chats' && (
        <div className="chats-list">
          {/* The archive's entry heads the list, and its view says where it is and leads back. */}
          {!chatsTab.loading && chatsTab.archive && (chatsTab.archive.showing || chatsTab.archive.count > 0) && (
            <button type="button" className="chat-archive-entry" onClick={chatsTab.archive.onToggle}>
              {chatsTab.archive.showing ? <ArrowLeft size={20} /> : <Archive size={20} />}
              <span>
                {chatsTab.archive.showing ? t('chats.rowActions.archivedTitle') : t('chats.rowActions.archivedEntry')}
              </span>
              {!chatsTab.archive.showing && <span className="chat-archive-count">{chatsTab.archive.count}</span>}
            </button>
          )}
          {chatsTab.loading ? (
            <div className="chats-list-loading">
              <Loader2 className="animate-spin" size={24} />
              <span>{t('chats.loadingChats')}</span>
            </div>
          ) : chatsTab.chats.length === 0 ? (
            <div className="chats-list-empty">
              <span>
                {chatsTab.archive?.showing
                  ? t('chats.rowActions.archiveEmpty')
                  : chatsTab.filter === 'all'
                    ? t('chats.empty')
                    : t('chats.noFilterResults')}
              </span>
            </div>
          ) : (
            chatsTab.chats.map(chat =>
              chatsTab.rowActions && (chat.kind === 'group' || chat.kind === 'individual') ? (
                <div key={chat.id} className="chat-item-wrap has-menu">
                  {renderChatRow(chat)}
                  <ChatRowMenu chat={chat} actions={chatsTab.rowActions} />
                </div>
              ) : (
                renderChatRow(chat)
              ),
            )
          )}
        </div>
      )}

      {/* Channels list — wwjs-only (newsletter/channel API isn't implemented on Baileys, which
          throws 501 for both listing and reading). channelsQuery is gated off entirely on that
          engine, so the branch order below never depends on a request having actually run. */}
      {activeTab === 'channels' && (
        <div className="chats-list">
          {channelsTab.engineLoading ? (
            <div className="chats-list-loading">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : !channelsTab.supported ? (
            <div className="chats-list-empty">
              <span>{t('chats.channels.notSupported')}</span>
            </div>
          ) : channelsTab.query.isLoading ? (
            <div className="chats-list-loading">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : channelsTab.query.error ? (
            <div className="chats-list-empty">
              <AlertCircle size={24} className="text-warn" />
              <span>{t('chats.channels.notReady')}</span>
            </div>
          ) : (channelsTab.query.data?.length ?? 0) === 0 ? (
            <div className="chats-list-empty">
              <span>{t('chats.channels.empty')}</span>
            </div>
          ) : channelsTab.channels.length === 0 ? (
            // Subscribed, but the search matches none of them.
            <div className="chats-list-empty">
              <span>{t('chats.empty')}</span>
            </div>
          ) : (
            channelsTab.channels.map(ch => (
              <div
                key={ch.id}
                role="button"
                tabIndex={0}
                aria-current={channelsTab.activeChannelId === ch.id ? 'true' : undefined}
                className={`chat-item-card ${channelsTab.activeChannelId === ch.id ? 'active' : ''}`}
                onClick={() => channelsTab.onSelectChannel(ch)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    channelsTab.onSelectChannel(ch);
                  }
                }}
              >
                <div className="chat-avatar avatar-md">
                  <Megaphone size={22} strokeWidth={1.75} />
                </div>
                <div className="chat-item-info">
                  <div className="chat-item-top">
                    <span className="chat-item-name">{ch.name}</span>
                  </div>
                  {ch.subscriberCount != null && (
                    <div className="chat-item-bottom">
                      <span className="chat-item-snippet">
                        {t('chats.channels.subscribers', { count: ch.subscriberCount })}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Status list — per-contact status groups read from the 24h store. Not engine-gated:
          both engines now have status content. */}
      {activeTab === 'status' && (
        <div className="chats-list">
          {statusTab.loading ? (
            <div className="chats-list-loading">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : statusTab.error ? (
            <div className="chats-list-empty">
              <AlertCircle size={24} className="text-warn" />
              <span>{t('chats.status.loadError')}</span>
            </div>
          ) : statusTab.groups.length === 0 ? (
            <div className="chats-list-empty">
              <span>{t('chats.status.empty')}</span>
            </div>
          ) : (
            statusTab.groups.map(group => (
              <div
                key={group.contact.id}
                role="button"
                tabIndex={0}
                aria-current={statusTab.activeContactId === group.contact.id ? 'true' : undefined}
                className={`chat-item-card ${statusTab.activeContactId === group.contact.id ? 'active' : ''}`}
                onClick={() => statusTab.onSelectContact(group.contact.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    statusTab.onSelectContact(group.contact.id);
                  }
                }}
              >
                <div className="chat-avatar avatar-md">
                  <CircleDashed size={22} strokeWidth={1.75} />
                </div>
                <div className="chat-item-info">
                  <div className="chat-item-top">
                    <span className="chat-item-name">
                      {group.contact.name ?? group.contact.pushName ?? group.contact.id}
                    </span>
                    <span className="chat-item-time">
                      {formatChatTime(Math.floor(new Date(group.latest).getTime() / 1000))}
                    </span>
                  </div>
                  <div className="chat-item-bottom">
                    <span className="chat-item-snippet">
                      {t('chats.status.itemCount', { count: group.items.length })}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

export default ChatSidebar;
