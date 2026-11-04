import type { ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Bell,
  BellOff,
  Eraser,
  Info,
  LogOut,
  Mail,
  Pin,
  PinOff,
  ShieldCheck,
  Trash2,
  User,
  UserPen,
} from 'lucide-react';
import type { Chat } from '../../services/api';

/** What a chat can be asked to do from its row or its room. Every one but the info views is an operator route. */
export interface ChatRowActions {
  /** A 1:1 chat's menu is opening: what its entries read (the address book) is loaded from here, not at page load. */
  onMenuOpen?: () => void;
  onGroupInfo: (chat: Chat) => void;
  onContactInfo?: (chat: Chat) => void;
  onSaveContact?: (chat: Chat) => void;
  /** Whether the chat has a phone-based id the address book accepts; Save is offered disabled otherwise. */
  canSaveContact?: (chat: Chat) => boolean;
  /** Whether the address book holds the chat's contact as saved, which turns Save into Rename. */
  isSavedContact?: (chat: Chat) => boolean;
  onTogglePin?: (chat: Chat) => void;
  /** Opens the mute dialog for a chat that is not muted, and unmutes one that is. */
  onMute?: (chat: Chat) => void;
  onToggleArchive?: (chat: Chat) => void;
  onMarkUnread?: (chat: Chat) => void;
  onLeaveGroup?: (chat: Chat) => void;
  /** Blocks a contact the blocklist does not hold, and unblocks one it does. */
  onToggleBlock?: (chat: Chat) => void;
  onClear?: (chat: Chat) => void;
  onDelete?: (chat: Chat) => void;
  /** Whether the session's blocklist holds this chat's contact. */
  isBlocked?: (chat: Chat) => boolean;
}

export interface ChatActionItem {
  key: string;
  icon: ReactNode;
  label: string;
  run: (chat: Chat) => void;
  /** Starts the destructive part of the list, after a divider. */
  separated?: boolean;
  /** Shown but not offered, with the reason in `hint`. */
  disabled?: boolean;
  hint?: string;
}

/**
 * The actions a chat offers, in WhatsApp's order: what it is, how it sits in the list, then what cannot
 * be taken back. Group chats get their group actions, 1:1 chats their contact ones; an action whose
 * handler is absent (a read-only key) is left out.
 */
export function chatActionItems(chat: Chat, actions: ChatRowActions, t: (key: string) => string): ChatActionItem[] {
  const group = chat.kind === 'group';
  const direct = chat.kind === 'individual';
  const items: ChatActionItem[] = [];
  const add = (handler: ((chat: Chat) => void) | undefined, item: Omit<ChatActionItem, 'run'>) => {
    if (handler) items.push({ ...item, run: handler });
  };

  if (group) add(actions.onGroupInfo, { key: 'info', icon: <Info size={18} />, label: t('chats.group.info') });
  if (direct) {
    add(actions.onContactInfo, { key: 'contact', icon: <User size={18} />, label: t('chats.contactInfo') });
    const addressable = actions.canSaveContact?.(chat) ?? true;
    add(actions.onSaveContact, {
      key: 'save',
      icon: <UserPen size={18} />,
      label: actions.isSavedContact?.(chat) ? t('chats.rowActions.renameContact') : t('chats.rowActions.saveContact'),
      ...(addressable ? {} : { disabled: true, hint: t('chats.rowActions.saveContactUnavailable') }),
    });
  }
  add(actions.onTogglePin, {
    key: 'pin',
    icon: chat.pinned ? <PinOff size={18} /> : <Pin size={18} />,
    label: chat.pinned ? t('chats.rowActions.unpin') : t('chats.rowActions.pin'),
  });
  add(actions.onMute, {
    key: 'mute',
    icon: chat.muted ? <Bell size={18} /> : <BellOff size={18} />,
    label: chat.muted ? t('chats.rowActions.unmute') : t('chats.rowActions.mute'),
  });
  add(actions.onToggleArchive, {
    key: 'archive',
    icon: chat.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />,
    label: chat.archived ? t('chats.rowActions.unarchive') : t('chats.rowActions.archive'),
  });
  // A chat already unread has nothing to mark.
  if (chat.unreadCount === 0) {
    add(actions.onMarkUnread, { key: 'unread', icon: <Mail size={18} />, label: t('chats.rowActions.markUnread') });
  }

  const destructive: ChatActionItem[] = [];
  const addDestructive = (handler: ((chat: Chat) => void) | undefined, item: Omit<ChatActionItem, 'run'>) => {
    if (handler) destructive.push({ ...item, run: handler });
  };
  if (group) {
    addDestructive(actions.onLeaveGroup, { key: 'leave', icon: <LogOut size={18} />, label: t('chats.group.leave') });
  }
  if (direct) {
    const blocked = actions.isBlocked?.(chat) ?? false;
    addDestructive(actions.onToggleBlock, {
      key: 'block',
      icon: blocked ? <ShieldCheck size={18} /> : <Ban size={18} />,
      label: blocked ? t('chats.rowActions.unblock') : t('chats.rowActions.block'),
    });
    addDestructive(actions.onClear, { key: 'clear', icon: <Eraser size={18} />, label: t('chats.rowActions.clear') });
    addDestructive(actions.onDelete, {
      key: 'delete',
      icon: <Trash2 size={18} />,
      label: t('chats.rowActions.delete'),
    });
  }
  if (destructive.length > 0) destructive[0].separated = true;
  return [...items, ...destructive];
}
