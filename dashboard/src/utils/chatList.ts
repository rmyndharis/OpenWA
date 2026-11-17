/**
 * Sidebar chat-list reducers.
 *
 * These decide how the conversation list reorders when a message arrives or is sent: which chat moves
 * to the top, what snippet it shows, and when an unread badge increments. They were inline `setChats`
 * updaters, which made them unreachable from a test and let a side effect sit inside one — see
 * `applyIncomingToChatList` below.
 *
 * Generic over the chat shape so the caller keeps its own `Chat` type; only the four fields these
 * reducers actually touch are constrained.
 */

import { contactSnippet } from './vcard.ts';

export interface ChatListEntry {
  id: string;
  lastMessage?: string;
  lastMessageType?: string;
  timestamp?: number;
  unreadCount?: number;
}

interface IncomingMessageLike {
  chatId?: string;
  body?: string;
  type?: string;
  timestamp?: number;
  fromMe?: boolean;
}

export interface ChatListUpdate<T> {
  chats: T[];
  /**
   * The message belongs to a chat the sidebar does not have, so the caller should refetch.
   *
   * Returned rather than acted on: this used to be a `void loadChats(...)` INSIDE the `setChats`
   * updater, and React double-invokes updaters under StrictMode, so every message for an unknown chat
   * refetched the list twice. A reducer that reports what is needed lets the caller fire it once,
   * outside.
   */
  needsSidebarRefetch: boolean;
}

/**
 * Fold an arriving message into the sidebar: move its chat to the top, refresh the snippet and
 * timestamp, and bump the unread badge when the chat is not the one on screen.
 *
 * `locationLabel` / `contactLabel` are passed in because those snippets must not be the raw body —
 * a location's body is a multi-kilobyte base64 map thumbnail, and a contact's body is the vCard text
 * the API stores — and the labels themselves are localised at the callsite.
 *
 * A contact's snippet is its name and phone, as the row reads after a reload; the label stands in when
 * the card holds neither.
 */
export function applyIncomingToChatList<T extends ChatListEntry>(
  chats: T[],
  msg: IncomingMessageLike,
  opts: { activeChatId?: string; locationLabel: string; contactLabel: string },
): ChatListUpdate<T> {
  const index = chats.findIndex(c => c.id === msg.chatId);
  if (index === -1) {
    // Suppress the refetch ONLY for an outgoing echo addressed as `@lid`: a LID-migrated contact
    // echoes back `@lid` while the user sent to `@c.us`, and the sent bubble is already reconciled in
    // the active chat, so refetching on every such send just churns the chat list (#583 R2). Incoming
    // messages and ordinary outgoing sends to a genuinely new chat still refetch.
    const isMigratedEcho = (msg.fromMe ?? false) && (msg.chatId?.endsWith('@lid') ?? false);
    return { chats, needsSidebarRefetch: !isMigratedEcho };
  }

  const updated = [...chats];
  const target = { ...updated[index] };
  target.lastMessage =
    msg.type === 'location'
      ? opts.locationLabel
      : msg.type === 'contact'
        ? contactSnippet(msg.body, opts.contactLabel)
        : msg.body;
  target.lastMessageType = msg.type;
  target.timestamp = msg.timestamp;
  if (!msg.fromMe && opts.activeChatId !== target.id) {
    // A chat marked unread carries -1; the first message into it counts as 1, not 0.
    target.unreadCount = Math.max(target.unreadCount ?? 0, 0) + 1;
  }
  updated.splice(index, 1);
  updated.unshift(target);
  return { chats: updated, needsSidebarRefetch: false };
}

/**
 * Move a chat to the top with a new snippet after the user sends into it. Unknown chat = no change:
 * the send path never creates a sidebar row, it only promotes one that exists.
 */
export function promoteChatWithSnippet<T extends ChatListEntry>(
  chats: T[],
  chatId: string,
  snippet: string,
  timestamp: number,
): T[] {
  const index = chats.findIndex(c => c.id === chatId);
  if (index === -1) return chats;
  const updated = [...chats];
  const target = { ...updated[index], lastMessage: snippet, lastMessageType: undefined, timestamp };
  updated.splice(index, 1);
  updated.unshift(target);
  return updated;
}
