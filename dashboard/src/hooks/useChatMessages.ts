import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  mergeChatMessages,
  mapEngineHistoryMessage,
  mergeOrAppend,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from '../utils/chatMessages';
import { sessionApi } from '../services/api';

export type MessagesQueryKey = readonly ['messages', string, string];

export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey {
  return ['messages', sessionId, chatId] as const;
}

/**
 * Fetch messages for one (sessionId, chatId) and keep them cached (staleTime: Infinity); realtime
 * updates flow through useChatMessagesActions, not refetches. Engine history is fetched WITHOUT media
 * to keep the cache small — a single 50 MiB message would otherwise sit in heap as base64 (held twice
 * as a `data:` URI). Recent media still renders from the DB copy (which wins in mergeChatMessages);
 * older history media shows the omitted placeholder. Cache eviction happens 5 min after the chat stops
 * being observed (gcTime), so browsing several media-rich chats doesn't accumulate large slices.
 */
export function useChatMessages(sessionId: string, chatId: string | null): UseQueryResult<ChatMessageView[], Error> {
  return useQuery<ChatMessageView[], Error>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    queryFn: async () => {
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, 100),
        sessionApi.getChatHistory(sessionId, chatId!, 100, false),
      ]);
      if (dbRes.status === 'rejected' && historyRes.status === 'rejected') throw dbRes.reason;
      const dbMessages = dbRes.status === 'fulfilled' ? dbRes.value.messages : [];
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];
      return mergeChatMessages(dbMessages, history);
    },
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Mutation helpers that write directly to the React Query cache. Use these
 * from the WebSocket subscriber, the optimistic-send flow, and ACK handlers
 * instead of calling setMessages locally.
 */
export function useChatMessagesActions() {
  const qc = useQueryClient();

  return {
    appendMessage(sessionId: string, chatId: string, msg: ChatMessageView) {
      // Only append to a slice that already exists (a chat that has been opened). Do NOT seed a slice
      // for a never-opened chat: with staleTime: Infinity that phantom slice would be "fresh", so
      // opening the chat would skip the full-history queryFn and show only this one message (truncated
      // history). Returning undefined from the updater is a no-op when there is no cached data.
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), old =>
        old === undefined ? undefined : mergeOrAppend(old, msg),
      );
    },
    updateMessage(sessionId: string, chatId: string, id: string, patch: Partial<ChatMessageView>) {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), (old = []) =>
        updateMessageById(old, id, patch),
      );
    },
    removeMessage(sessionId: string, chatId: string, id: string) {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), (old = []) => removeMessageById(old, id));
    },
  };
}
