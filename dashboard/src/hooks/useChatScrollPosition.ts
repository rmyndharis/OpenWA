import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { decideScroll, type ScrollDirection } from '../utils/scrollDecision';

/**
 * Per-chat scroll-position memory + auto-scroll heuristic.
 *
 * - On chat switch: saves the leaving chat's scrollTop, restores the entering
 *   chat's scrollTop (or jumps to bottom on first visit) BEFORE paint via
 *   useLayoutEffect — no visible "jump" or smooth-scroll animation.
 * - On message append: `onMessageAppended(direction)` snapshots the geometry
 *   BEFORE the new message is committed, then defers the scroll-to-bottom (if
 *   any) to the next frame so the new message is already in the DOM.
 *
 * Mount the returned `containerRef` on the scroll container (the `.messages-list`
 * div). The Map of saved positions lives in a ref so it doesn't trigger renders
 * and is garbage-collected when the host component unmounts.
 */
export function useChatScrollPosition(activeChatId: string | null): {
  containerRef: RefObject<HTMLDivElement | null>;
  onMessageAppended: (direction: ScrollDirection) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollMap = useRef<Map<string, number>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const prev = prevChatIdRef.current;
    const next = activeChatId;
    const el = containerRef.current;

    if (prev && el) scrollMap.current.set(prev, el.scrollTop);
    if (next && el) {
      const saved = scrollMap.current.get(next);
      el.scrollTop = saved !== undefined ? saved : el.scrollHeight;
    }
    prevChatIdRef.current = next;
  }, [activeChatId]);

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

  return { containerRef, onMessageAppended };
}
