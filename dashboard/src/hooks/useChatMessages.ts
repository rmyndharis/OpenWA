import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type QueryCacheNotifyEvent,
} from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  mergeChatMessages,
  mapEngineHistoryMessage,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from '../utils/chatMessages';
import { upsertIntoPages, nextMessagePageParam, type MessagePage } from '../utils/messagePages';
import { sessionApi } from '../services/api';

export type MessagesQueryKey = readonly ['messages', string, string];

export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey {
  return ['messages', sessionId, chatId] as const;
}

/**
 * How many DB rows one page asks for. The gateway clamps `limit` to 100
 * (`message.service.ts`: `Math.min(Math.max(Math.trunc(rawLimit), 1), 100)`), so this is its
 * maximum. Termination assumes the clamp holds: a page short of THIS value is read as the last one
 * (see `nextMessagePageParam`), so a lower clamp on the server would end paging after page one.
 */
export const MESSAGE_PAGE_SIZE = 100;

export type MessagesData = InfiniteData<MessagePage>;

/**
 * The one flat chronological view of a paged cache. A single page is ascending but partial, so
 * neither a message's position nor its absence can be read from one.
 */
export function flattenMessagePages(data: MessagesData): ChatMessageView[] {
  return mergeChatMessages(
    data.pages.flatMap(page => page.db),
    data.pages.flatMap(page => page.history),
  );
}

/**
 * Fetch a chat's messages a page at a time, newest page first, cached at staleTime: Infinity;
 * realtime updates flow through useChatMessagesActions, not refetches.
 *
 * Engine history comes with the first page only — it is a one-shot backfill of a thread the gateway
 * never captured, with no cursor to page through. Fetched without media to keep the cache small; the
 * DB copy wins in mergeChatMessages, so recent media still renders.
 *
 * Base64 media payloads are bounded twice: `mergeOrAppend` caps each page's `db` as messages land
 * in it (so a media-heavy page 0 can't grow the cache unbounded), and `select` caps the flattened,
 * correctly-ordered thread again for what actually renders — the two bounds cover the cache and the
 * viewport respectively, and neither alone would cover both.
 *
 * `historySupported` is false for an engine that answers 501 to the history read (Baileys): the request is
 * never sent, so every chat opened there does not log a failed call in the browser console.
 */
export function useChatMessages(
  sessionId: string,
  chatId: string | null,
  historySupported = true,
): UseInfiniteQueryResult<ChatMessageView[], Error> {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<MessagePage, Error, ChatMessageView[], MessagesQueryKey, number>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const wantsHistory = pageParam === 0 && historySupported;
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, MESSAGE_PAGE_SIZE, pageParam),
        wantsHistory ? sessionApi.getChatHistory(sessionId, chatId!, 100, false) : Promise.resolve([]),
      ]);
      // Only the first page may fall back to history alone; an older page has no second source, so a
      // rejected DB read there is a real failure and must surface rather than resolve to an empty
      // page that would read as "no more messages".
      if (dbRes.status === 'rejected' && (!wantsHistory || historyRes.status === 'rejected')) throw dbRes.reason;
      const db = dbRes.status === 'fulfilled' ? dbRes.value : { messages: [] };
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];
      // The gateway answers newest-first (createdAt DESC); reversed here so `page.db` is ascending
      // like the flattened thread. mergeOrAppend's cap strips from the front of an ascending list —
      // storing pages in server order would make it strip the newest payloads first.
      return { db: [...db.messages].reverse(), history, fetched: db.messages.length };
    },
    getNextPageParam: (_lastPage, allPages) => nextMessagePageParam(allPages, MESSAGE_PAGE_SIZE),
    // Consumers keep seeing one flat chronological list; paging stays inside the cache.
    select: flattenMessagePages,
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });

  // A page in flight carries a snapshot of `data.pages` taken when it started (TanStack's
  // infiniteQueryBehavior reads `oldPages` in onFetch), so its result overwrites anything written
  // meanwhile — and at staleTime: Infinity no refetch brings it back. An optimistic send during
  // that window would leave the thread for good. writeMessagesCache queues those writes and
  // schedules their replay for the moment the fetch settles (see scheduleReplayOnSettle) — not for
  // whenever this hook next happens to mount, which is too late: another writer (the composer's own
  // send reconciling, a socket event routed through cachedSessionThreads to a chat that is not even
  // open) can land on the cache between the fetch settling and a remount, and a replay fired only on
  // remount would stomp that newer write with the stale queued one. This effect stays as a second
  // chance for the same key in case the fetch had already settled before any write ever queued for
  // it — a normal case, and a no-op here since the queue is empty by then.
  // Gated on `idle`, not on `isFetching`. A fetch the browser parks when it goes offline reports
  // fetchStatus 'paused', which makes `isFetching` false while the request is still going to land:
  // draining here would hand the resumed page a queue that no longer exists to replay. The writer
  // and the settle subscription key on the same value for the same reason.
  const { fetchStatus } = query;
  useEffect(() => {
    if (fetchStatus !== 'idle') return;
    replayWritesLostToFetch(queryClient, messagesQueryKey(sessionId, chatId ?? ''));
  }, [queryClient, fetchStatus, sessionId, chatId]);

  return query;
}

interface PendingWrite {
  apply: (data: MessagesData) => MessagesData;
  /** The cache value this write produced — see replayWritesLostToFetch. */
  wrote: MessagesData | undefined;
}

// Module scope because the helpers below are plain functions with no component to hang state on.
const writesLostToFetch = new Map<string, PendingWrite[]>();
// One queryCache subscription per key with a queue outstanding, so replay fires the instant that
// key's fetch settles rather than whenever a consumer next mounts — see scheduleReplayOnSettle.
const settleSubscriptions = new Map<string, () => void>();

const pendingKey = (key: MessagesQueryKey): string => JSON.stringify(key);

const sameQueryKey = (a: readonly unknown[], b: MessagesQueryKey): boolean =>
  a.length === b.length && a.every((part, i) => part === b[i]);

/**
 * Fire replayWritesLostToFetch for `key` the moment its query stops fetching, independent of
 * whether any component watching it is mounted. Self-unsubscribes on that event or on the query
 * being removed from the cache entirely (gcTime elapsed with nothing open) — replaying onto a
 * query that no longer exists would just reseed a phantom entry, which writeMessagesCache's own
 * "never seed a slice" rule exists to prevent.
 *
 * Idempotent to call redundantly: only takes effect while no subscription is already tracked for
 * this key (writeMessagesCache only calls it when the queue transitions from empty to non-empty).
 */
function scheduleReplayOnSettle(queryClient: QueryClient, key: MessagesQueryKey): void {
  const id = pendingKey(key);
  if (settleSubscriptions.has(id)) return;
  const unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (!sameQueryKey(event.query.queryKey, key)) return;
    if (event.type === 'removed') {
      settleSubscriptions.delete(id);
      unsubscribe();
      writesLostToFetch.delete(id);
      return;
    }
    // Settled means `idle`, not merely "not fetching". A fetch the browser pauses when it goes
    // offline reports `paused` and resumes later, so treating that as a settle would drain the
    // queue, unsubscribe, and leave the resumed page free to overwrite those writes for good.
    if (event.query.state.fetchStatus !== 'idle') return;
    settleSubscriptions.delete(id);
    unsubscribe();
    replayWritesLostToFetch(queryClient, key);
  });
  settleSubscriptions.set(id, unsubscribe);
}

/**
 * Apply one change to a chat's paged cache, recording it for replay when a page is in flight.
 *
 * Never seeds a slice: an entry created here would be "fresh" under staleTime: Infinity, so opening
 * the chat would skip the queryFn and show this write alone. A write while the FIRST page is in
 * flight has no data to land on, so it is only queued, then replayed onto that page when it
 * settles; the composer is live before the thread loads, and dropping the write lost the message.
 *
 * `apply` must be idempotent: a replay can re-run it against a cache that already reflects it.
 */
function writeMessagesCache(
  queryClient: QueryClient,
  key: MessagesQueryKey,
  apply: (data: MessagesData) => MessagesData,
): void {
  const state = queryClient.getQueryState<MessagesData>(key);
  if (state === undefined || (state.data === undefined && state.fetchStatus === 'idle')) return;
  queryClient.setQueryData<MessagesData>(key, old => (old === undefined ? undefined : apply(old)));
  // Anything but `idle` still has a page coming that will overwrite this write when it lands, so
  // it has to be queued. `paused` is the case a bare `=== 'fetching'` test misses: the browser
  // parks the fetch when it goes offline and resumes it later.
  if (state.fetchStatus === 'idle') return;
  const id = pendingKey(key);
  const queued = writesLostToFetch.get(id) ?? [];
  const wrote = queryClient.getQueryData<MessagesData>(key);
  writesLostToFetch.set(id, [...queued, { apply, wrote }]);
  if (queued.length === 0) scheduleReplayOnSettle(queryClient, key);
}

/**
 * Re-apply, in order, the writes a landed page overwrote.
 *
 * Only if one actually did. A fetch that FAILED leaves the cache exactly as the last queued write
 * left it, so nothing was lost and replaying would apply the whole queue twice. Identity answers
 * that in one comparison — a landed page always produces a new value — and it is a per-QUEUE
 * question, not a per-entry one: either a fetch replaced the data, in which case every queued
 * write went with it, or it did not, in which case none did.
 *
 * Called right as the fetch that could have clobbered the queue settles (scheduleReplayOnSettle),
 * so this identity check is comparing against the immediately-landed page, before any OTHER writer
 * gets a turn — that ordering is what keeps a later, unrelated write from being overwritten by a
 * stale replay that only fired once some consumer happened to remount.
 */
export function replayWritesLostToFetch(queryClient: QueryClient, key: MessagesQueryKey): void {
  const id = pendingKey(key);
  const queue = writesLostToFetch.get(id);
  if (queue === undefined || queue.length === 0) return;
  writesLostToFetch.delete(id);
  if (queue[queue.length - 1].wrote === queryClient.getQueryData<MessagesData>(key)) return;
  queryClient.setQueryData<MessagesData>(key, old =>
    old === undefined ? undefined : queue.reduce((data, write) => write.apply(data), old),
  );
}

/**
 * Apply a list transform to every cached page. Both arrays are transformed: a message the gateway
 * never persisted exists only in `history`, so touching `db` alone would drop its edits and deletes.
 *
 * The transform sees one page at a time, so it must not depend on the thread's order or
 * completeness — `flattenMessagePages` answers those questions.
 */
export function updateCachedMessages(
  queryClient: QueryClient,
  key: MessagesQueryKey,
  transform: (list: ChatMessageView[]) => ChatMessageView[],
): void {
  writeMessagesCache(queryClient, key, data => ({
    ...data,
    pages: data.pages.map(page => ({ ...page, db: transform(page.db), history: transform(page.history) })),
  }));
}

/**
 * Insert or merge one message, optionally dropping an optimistic placeholder by id.
 *
 * Which page receives it matters: `mergeOrAppend` appends when it finds no match, so running it
 * over every page would add a copy to each one. The message is merged into the page that already
 * holds it, and only lands on the newest page when no page does.
 */
export function upsertCachedMessage(
  queryClient: QueryClient,
  key: MessagesQueryKey,
  incoming: ChatMessageView,
  options: { dropId?: string } = {},
): void {
  writeMessagesCache(queryClient, key, data =>
    data.pages.length === 0 ? data : { ...data, pages: upsertIntoPages(data.pages, incoming, options.dropId) },
  );
}

/**
 * The cached chats under one session that hold a matching message, as [key, flat thread] pairs.
 *
 * `matches` is applied to the raw pages first so only a thread that actually holds the message pays
 * for the merge — a realtime event concerns one chat, and flattening every open one per event would
 * sort and cap them all to throw the result away.
 */
export function cachedSessionThreads(
  queryClient: QueryClient,
  sessionId: string,
  matches: (message: ChatMessageView) => boolean,
): Array<[MessagesQueryKey, ChatMessageView[]]> {
  const threads: Array<[MessagesQueryKey, ChatMessageView[]]> = [];
  for (const [key, data] of queryClient.getQueriesData<MessagesData>({ queryKey: ['messages', sessionId] })) {
    if (data === undefined) continue;
    const holds = data.pages.some(page => page.db.some(matches) || page.history.some(matches));
    if (holds) threads.push([key as MessagesQueryKey, flattenMessagePages(data)]);
  }
  return threads;
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
      upsertCachedMessage(qc, messagesQueryKey(sessionId, chatId), msg);
    },
    updateMessage(sessionId: string, chatId: string, id: string, patch: Partial<ChatMessageView>) {
      updateCachedMessages(qc, messagesQueryKey(sessionId, chatId), list => updateMessageById(list, id, patch));
    },
    removeMessage(sessionId: string, chatId: string, id: string) {
      updateCachedMessages(qc, messagesQueryKey(sessionId, chatId), list => removeMessageById(list, id));
    },
  };
}
