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
 * Fetch messages for one (sessionId, chatId) and keep them cached forever
 * (staleTime: Infinity). Realtime updates flow through useChatMessagesActions,
 * not through refetches. Cache eviction happens 30 min after the chat stops
 * being observed (gcTime).
 */
export function useChatMessages(
  sessionId: string,
  chatId: string | null,
): UseQueryResult<ChatMessageView[], Error> {
  return useQuery<ChatMessageView[], Error>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    queryFn: async () => {
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, 100),
        sessionApi.getChatHistory(sessionId, chatId!, 100, true),
      ]);
      if (dbRes.status === 'rejected' && historyRes.status === 'rejected') throw dbRes.reason;
      const dbMessages = dbRes.status === 'fulfilled' ? dbRes.value.messages : [];
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];
      const merged = mergeChatMessages(dbMessages, history);
      // The DB stores ONLY incoming messages, and its page can reach further back than the engine
      // history page (which carries both directions). Those extra older DB rows render as a confusing
      // "only the other person" band at the top of the thread. Trim the thread to the history's range
      // so the initial view is balanced; older messages (both directions) lazy-load via deep history on
      // scroll-up. (When there's no history — e.g. a fresh session — keep the DB rows as-is.)
      if (history.length === 0) return merged;
      const ts = (m: { timestamp?: number; createdAt: string }): number =>
        m.timestamp ?? (Math.floor(Date.parse(m.createdAt) / 1000) || 0);
      const oldestHistoryTs = Math.min(...history.map(ts));
      return merged.filter(m => ts(m) >= oldestHistoryTs);
    },
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
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
      qc.setQueryData<ChatMessageView[]>(
        messagesQueryKey(sessionId, chatId),
        (old = []) => updateMessageById(old, id, patch),
      );
    },
    removeMessage(sessionId: string, chatId: string, id: string) {
      qc.setQueryData<ChatMessageView[]>(
        messagesQueryKey(sessionId, chatId),
        (old = []) => removeMessageById(old, id),
      );
    },
    /**
     * Load older messages by fetching a deeper slice of the engine history (both directions, metadata
     * only — no media for the deeper portion) and merging it into the cached thread. `limit` is the new,
     * larger ceiling; the engine returns the most-recent `limit`, so a bigger limit reveals older ones.
     * Returns how many genuinely-new (older) messages were added, so the caller knows whether more remain.
     */
    async loadOlderHistory(sessionId: string, chatId: string, limit: number): Promise<number> {
      const history = await sessionApi.getChatHistory(sessionId, chatId, limit, false, true);
      const older = history.map(mapEngineHistoryMessage);
      const key = messagesQueryKey(sessionId, chatId);
      const before = qc.getQueryData<ChatMessageView[]>(key) ?? [];
      // `before` FIRST so the already-loaded rows win the dedup — mergeChatMessages lets the first arg
      // overwrite the second, and the cached rows carry real delivery status + media that the
      // metadata-only deep copies lack. The deep rows only contribute the genuinely-older messages.
      const merged = mergeChatMessages(before, older);
      qc.setQueryData<ChatMessageView[]>(key, merged);
      return merged.length - before.length;
    },
  };
}
