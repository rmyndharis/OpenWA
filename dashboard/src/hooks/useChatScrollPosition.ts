import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { decideScroll, type ScrollDirection } from '../utils/scrollDecision.ts';

/**
 * Decide what to do with the scroll container on a chat switch or load-resolve.
 *
 * Inputs:
 *   - prevChatId: chat we are LEAVING (or null if first render)
 *   - nextChatId: chat we are ENTERING (or null if no chat selected)
 *   - prevLoaded: was the previous chat's content rendered when we last ran?
 *   - isLoaded:   is the next chat's content rendered now?
 *   - savedScrollTop: previously-saved scrollTop for nextChatId (or undefined)
 *
 * Output: { save: 'previous' | null, restore: 'saved' | 'bottom' | null }
 *   - save:    instructs the hook to write the CURRENT scrollTop into the
 *              map under prevChatId BEFORE doing the restore
 *   - restore: instructs the hook to write scrollTop = (the saved value)
 *              or = scrollHeight (bottom); null means do nothing
 *
 * This is a pure function so it can be unit-tested without React.
 */
export interface RestoreDecision {
  save: 'previous' | null;
  restore: 'saved' | 'bottom' | null;
}

export function decideRestoreTarget(
  prevChatId: string | null,
  nextChatId: string | null,
  prevLoaded: boolean,
  isLoaded: boolean,
  savedScrollTop: number | undefined,
): RestoreDecision {
  // Only save the previous chat's scrollTop when we're switching to ANOTHER
  // chat (not when deselecting back to nothing) and when its content was
  // actually rendered (not a spinner snapshot).
  const save: 'previous' | null =
    prevChatId !== null &&
    nextChatId !== null &&
    prevChatId !== nextChatId &&
    prevLoaded
      ? 'previous'
      : null;

  const restore: 'saved' | 'bottom' | null =
    nextChatId !== null && isLoaded
      ? savedScrollTop !== undefined ? 'saved' : 'bottom'
      : null;

  return { save, restore };
}

/**
 * Per-chat scroll-position memory + auto-scroll heuristic.
 *
 * - On chat switch (and once content for the new chat has actually rendered):
 *   saves the leaving chat's scrollTop, restores the entering chat's saved
 *   scrollTop, or jumps to bottom on first visit. All synchronously, before
 *   paint, via useLayoutEffect — no visible "jump" or smooth-scroll animation.
 * - The hook depends on BOTH activeChatId AND isLoaded so that a cold-open
 *   (spinner first, then data) correctly waits to restore until the messages
 *   list is mounted with non-zero scrollHeight.
 * - On message append: `onMessageAppended(direction)` snapshots the geometry
 *   BEFORE the new message is committed, then defers the scroll-to-bottom (if
 *   any) to the next frame so the new message is already in the DOM.
 *
 * Mount the returned `containerRef` on the scroll container (the `.room-messages`
 * div in Chats.tsx). The Map of saved positions lives in a ref so it doesn't
 * trigger renders and is garbage-collected when the host component unmounts.
 */
export function useChatScrollPosition(
  activeChatId: string | null,
  isLoaded: boolean,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  onMessageAppended: (direction: ScrollDirection) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollMap = useRef<Map<string, number>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);
  const prevLoadedRef = useRef<boolean>(false);

  useLayoutEffect(() => {
    const prev = prevChatIdRef.current;
    const next = activeChatId;
    const el = containerRef.current;
    const prevLoaded = prevLoadedRef.current;

    const decision = decideRestoreTarget(
      prev,
      next,
      prevLoaded,
      isLoaded,
      next !== null ? scrollMap.current.get(next) : undefined,
    );

    if (el) {
      if (decision.save === 'previous' && prev !== null) {
        scrollMap.current.set(prev, el.scrollTop);
      }
      if (decision.restore === 'saved' && next !== null) {
        const saved = scrollMap.current.get(next);
        if (saved !== undefined) el.scrollTop = saved;
      } else if (decision.restore === 'bottom') {
        el.scrollTop = el.scrollHeight;
      }
    }

    prevChatIdRef.current = next;
    prevLoadedRef.current = isLoaded;
  }, [activeChatId, isLoaded]);

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
