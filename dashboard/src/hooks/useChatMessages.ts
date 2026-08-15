import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
 * older history media shows the omitted placeholder. Live/DB payloads that do arrive are additionally
 * bounded per slice: mergeChatMessages/mergeOrAppend run the result through capMediaPayloads, which
 * strips the oldest base64 beyond MEDIA_PAYLOAD_CACHE_LIMIT so a long media-heavy session can't grow
 * the tab's heap without bound. Cache eviction happens 5 min after the chat stops being observed
 * (gcTime), so browsing several media-rich chats doesn't accumulate large slices.
 */
export interface UseChatMessagesResult {
  data: ChatMessageView[];
  isLoading: boolean;
  isError: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  fetchPreviousMessages: () => Promise<void>;
}

export function useChatMessages(sessionId: string, chatId: string | null): UseChatMessagesResult {
  const queryClient = useQueryClient();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const queryKey = messagesQueryKey(sessionId, chatId ?? '');

  const query = useQuery<ChatMessageView[], Error>({
    queryKey,
    queryFn: async () => {
      setHasMore(true);
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, 50, 0),
        sessionApi.getChatHistory(sessionId, chatId!, 50, false),
      ]);
      if (dbRes.status === 'rejected' && historyRes.status === 'rejected') throw dbRes.reason;
      const dbMessages = dbRes.status === 'fulfilled' ? dbRes.value.messages : [];
      const totalInDb = dbRes.status === 'fulfilled' ? dbRes.value.total : 0;
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];

      const merged = mergeChatMessages(dbMessages, history);
      if (merged.length < 50 && totalInDb <= merged.length) {
        setHasMore(false);
      }
      return merged;
    },
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });

  const fetchPreviousMessages = async () => {
    if (!sessionId || !chatId || isLoadingMore || !hasMore) return;
    const current = queryClient.getQueryData<ChatMessageView[]>(queryKey) || [];
    const offset = current.length;
    setIsLoadingMore(true);

    try {
      const res = await sessionApi.getChatMessages(sessionId, chatId, 50, offset);
      if (!res.messages || res.messages.length === 0) {
        setHasMore(false);
      } else {
        if (res.messages.length < 50) {
          setHasMore(false);
        }
        const merged = mergeChatMessages(res.messages, current);
        queryClient.setQueryData(queryKey, merged);
      }
    } catch {
      // Failed to load more, stop further auto-requests until next scroll
    } finally {
      setIsLoadingMore(false);
    }
  };

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    isLoadingMore,
    hasMore,
    fetchPreviousMessages,
  };
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
