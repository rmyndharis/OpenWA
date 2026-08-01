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

export interface ChatListEntry {
  id: string;
  lastMessage?: string;
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
 * `locationLabel` is passed in because the snippet for a location message must not be its body — that
 * is a multi-kilobyte base64 map thumbnail — and the label itself is localised at the callsite.
 */
export function applyIncomingToChatList<T extends ChatListEntry>(
  chats: T[],
  msg: IncomingMessageLike,
  opts: { activeChatId?: string; locationLabel: string },
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
  target.lastMessage = msg.type === 'location' ? opts.locationLabel : msg.body;
  target.timestamp = msg.timestamp;
  if (!msg.fromMe && opts.activeChatId !== target.id) {
    target.unreadCount = (target.unreadCount || 0) + 1;
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
  const target = { ...updated[index], lastMessage: snippet, timestamp };
  updated.splice(index, 1);
  updated.unshift(target);
  return updated;
}
