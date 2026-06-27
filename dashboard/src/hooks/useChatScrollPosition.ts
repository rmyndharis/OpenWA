import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { decideScroll, isAwayFromBottom, type ScrollDirection } from '../utils/scrollDecision.ts';

/**
 * Decide where to place the scroll when entering a chat (or when its content first loads):
 *   - 'saved'  → a remembered scrollTop exists for this chat: restore it
 *   - 'bottom' → first visit (no saved position): jump to the latest message
 *   - null     → nothing to do yet (no chat selected, or content not loaded)
 *
 * Note: this no longer decides whether to SAVE the leaving chat's position. That position is
 * captured continuously by the hook's scroll handler, so it never depends on reading scrollTop
 * after the DOM has already swapped to the next chat — the bug that left returned-to chats stuck
 * at the top (the old layout-effect save read the incoming chat's / spinner's scrollTop ≈ 0).
 *
 * Pure function so it can be unit-tested without React.
 */
export type RestoreTarget = 'saved' | 'bottom' | null;

export function decideRestoreTarget(
  nextChatId: string | null,
  isLoaded: boolean,
  savedScrollTop: number | undefined,
): RestoreTarget {
  if (nextChatId === null || !isLoaded) return null;
  // A saved value of 0 is a real position (user was at the top) — only `undefined` means "first visit".
  return savedScrollTop !== undefined ? 'saved' : 'bottom';
}

/**
 * Per-chat scroll-position memory + auto-scroll heuristic + "jump to bottom" affordance.
 *
 * - `onScroll` (attach to the scroll container) records the active chat's scrollTop on every scroll,
 *   so switching away always has an accurate position to restore later, and toggles the jump button
 *   based on how far the user has scrolled up.
 * - On chat switch / first load: restores the entering chat's remembered scrollTop, or jumps to
 *   bottom on first visit — synchronously before paint via useLayoutEffect.
 * - `onMessageAppended(direction)`: scrolls to bottom when appropriate (the user's own message, or an
 *   arrival while they were already near the bottom), deferred to the next frame so the new node is
 *   in the DOM. Preserves position when the user has scrolled up to read history.
 * - `scrollToBottom()`: smooth-scrolls to the latest message (the jump button's action).
 *
 * Mount `containerRef` on the scroll container (`.room-messages`). The Map of saved positions lives
 * in a ref so it doesn't trigger renders and is garbage-collected when the host component unmounts.
 */
export function useChatScrollPosition(
  activeChatId: string | null,
  isLoaded: boolean,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onMessageAppended: (direction: ScrollDirection) => void;
  showJumpToBottom: boolean;
  scrollToBottom: () => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollMap = useRef<Map<string, number>>(new Map());

  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const syncJumpButton = useCallback((el: HTMLDivElement) => {
    setShowJumpToBottom(
      isAwayFromBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }),
    );
  }, []);

  // Recreated whenever the active chat changes, so the position is always recorded under the chat
  // currently on screen — React swaps the listener on the container, never leaving a stale closure.
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (activeChatId !== null) scrollMap.current.set(activeChatId, el.scrollTop);
    syncJumpButton(el);
  }, [activeChatId, syncJumpButton]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const next = activeChatId;
    const target = decideRestoreTarget(
      next,
      isLoaded,
      next !== null ? scrollMap.current.get(next) : undefined,
    );

    if (el && next !== null) {
      if (target === 'saved') {
        const saved = scrollMap.current.get(next);
        if (saved !== undefined) el.scrollTop = saved;
      } else if (target === 'bottom') {
        el.scrollTop = el.scrollHeight;
        // Media can grow the content a frame after open; re-pin to the bottom next frame so the chat
        // reliably lands on the latest message instead of mid-thread.
        requestAnimationFrame(() => {
          const cur = containerRef.current;
          if (cur) cur.scrollTop = cur.scrollHeight;
        });
      }
      if (target !== null) syncJumpButton(el);
    }
  }, [activeChatId, isLoaded, syncJumpButton]);

  const onMessageAppended = useCallback((direction: ScrollDirection) => {
    const el = containerRef.current;
    if (!el) return;
    const action = decideScroll(direction, {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (action === 'preserve') return;
    requestAnimationFrame(() => {
      const cur = containerRef.current;
      if (cur) cur.scrollTop = cur.scrollHeight;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  return { containerRef, onScroll, onMessageAppended, showJumpToBottom, scrollToBottom };
}
