import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { decideScroll, type ScrollDirection } from '../utils/scrollDecision.ts';

/**
 * Decide the restore target on a chat switch or load-resolve.
 *
 * Inputs:
 *   - nextChatId: chat we are ENTERING (or null if no chat selected)
 *   - isLoaded:   is the next chat's content rendered now?
 *   - savedScrollTop: previously-saved scrollTop for nextChatId (or undefined)
 *
 * Output: { restore: 'saved' | 'bottom' | null }
 *   - restore: 'saved' = write scrollTop = the saved value; 'bottom' = scrollHeight;
 *              null = do nothing (still loading / deselected).
 *
 * NOTE: there is deliberately no "save the leaving chat's scrollTop" step here. A layout effect
 * runs AFTER React has already swapped the container's content to the NEW chat, so a post-swap
 * read captures the NEW content's (possibly clamped) scrollTop, not the leaving chat's position —
 * saving then restores the returning chat to the TOP. Instead the scroll listener saves the live
 * scrollTop continuously (see below), so the map always holds each chat's last REAL position.
 *
 * This is a pure function so it can be unit-tested without React.
 */
export interface RestoreDecision {
  restore: 'saved' | 'bottom' | null;
}

export function decideRestoreTarget(
  nextChatId: string | null,
  isLoaded: boolean,
  savedScrollTop: number | undefined,
): RestoreDecision {
  const restore: 'saved' | 'bottom' | null =
    nextChatId !== null && isLoaded ? (savedScrollTop !== undefined ? 'saved' : 'bottom') : null;

  return { restore };
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
 * - Pinned-to-bottom: media (`<img>`/`<video>`) has no intrinsic size before it
 *   decodes, so the container's scrollHeight GROWS after the initial restore —
 *   silently un-bottoming the view (the thread looks like it "opened at the
 *   top"). While pinned, each `onMediaLoad` re-pins to the bottom; the pin
 *   releases as soon as the USER scrolls away from the bottom (and re-arms when
 *   they scroll back), so late-decoding media never yanks a reading user.
 *
 * Mount the returned `containerRef` on the scroll container (the `.room-messages`
 * div in Chats.tsx). The Map of saved positions lives in a ref so it doesn't
 * trigger renders and is garbage-collected when the host component unmounts.
 */

/** Distance from the bottom (px) within which the user still counts as "at the bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 24;

/** Pure geometry check, exported for tests: is the viewport (nearly) at the container's bottom? */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_PIN_THRESHOLD_PX;
}

export function useChatScrollPosition(
  activeChatId: string | null,
  isLoaded: boolean,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  onMessageAppended: (direction: ScrollDirection) => void;
  onMediaLoad: () => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollMap = useRef<Map<string, number>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);
  const pinnedRef = useRef<boolean>(true);
  // A 'saved' restore writes scrollTop BEFORE media decodes — the browser clamps the write to the
  // still-short scrollHeight and the thread lands at the top. The saved value lives here and is
  // re-applied on every media decode until the user scrolls (any genuine scroll cancels it).
  const pendingRestoreRef = useRef<number | null>(null);
  // Marks our own writes so the scroll listener can skip them (a genuine user scroll both updates
  // the pin state / position map AND cancels pendingRestore; our writes must do neither).
  const programmaticWriteRef = useRef<boolean>(false);

  const writeScrollTop = useCallback((el: HTMLDivElement, top: number) => {
    const before = el.scrollTop;
    programmaticWriteRef.current = true;
    el.scrollTop = top;
    // No scroll event fires when the value doesn't change (or clamps to the same value) — don't
    // leave the flag set to swallow the next genuine user scroll.
    if (el.scrollTop === before) programmaticWriteRef.current = false;
  }, []);

  const pinToBottom = useCallback(
    (el: HTMLDivElement) => {
      writeScrollTop(el, el.scrollHeight);
      pinnedRef.current = true;
    },
    [writeScrollTop],
  );

  // Track pin state from scroll geometry: any scroll that lands at the bottom (ours or the user's)
  // pins; any scroll away (only ever the user's) unpins. The SAME listener saves the visible
  // chat's scrollTop on every genuine user scroll, so the per-chat position map always holds the
  // last REAL user position — saving at switch time would read post-swap (clamped) geometry and
  // restore garbage.
  // NOTE: an effect without a dep array re-runs on EVERY render, and React runs the previous
  // cleanup first — so the listener must be (re)attached unconditionally each run.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      if (programmaticWriteRef.current) {
        programmaticWriteRef.current = false;
        return;
      }
      // A genuine user scroll: cancels any pending restore, then updates pin + position map.
      pendingRestoreRef.current = null;
      pinnedRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
      const visibleChatId = prevChatIdRef.current;
      if (visibleChatId) scrollMap.current.set(visibleChatId, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  useLayoutEffect(() => {
    const next = activeChatId;
    const el = containerRef.current;
    // A new restore decision supersedes any pending one (it belongs to a different chat/visit).
    pendingRestoreRef.current = null;

    const decision = decideRestoreTarget(next, isLoaded, next !== null ? scrollMap.current.get(next) : undefined);

    if (el) {
      if (decision.restore === 'saved' && next !== null) {
        const saved = scrollMap.current.get(next);
        if (saved !== undefined) {
          pendingRestoreRef.current = saved; // re-applied on media loads until the user scrolls
          writeScrollTop(el, saved);
          pinnedRef.current = false; // a saved spot is (almost always) not the bottom
        }
      } else if (decision.restore === 'bottom') {
        pinToBottom(el);
      }
    }

    prevChatIdRef.current = next;
  }, [activeChatId, isLoaded, pinToBottom, writeScrollTop]);

  const onMessageAppended = useCallback(
    (direction: ScrollDirection) => {
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
        if (cur) pinToBottom(cur);
      });
    },
    [pinToBottom],
  );

  // Media has no layout box before it decodes. While pinned, each decode re-pins to the bottom;
  // while a 'saved' restore is pending, each decode RE-APPLIES the saved scrollTop (the first write
  // was clamped to the pre-decode scrollHeight). A user scroll clears both, so late-decoding media
  // never yanks a reading user.
  const onMediaLoad = useCallback(() => {
    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      requestAnimationFrame(() => {
        const cur = containerRef.current;
        if (cur && pendingRestoreRef.current !== null) writeScrollTop(cur, pending);
      });
      return;
    }
    if (!pinnedRef.current) return;
    requestAnimationFrame(() => {
      const cur = containerRef.current;
      if (cur && pinnedRef.current) pinToBottom(cur);
    });
  }, [pinToBottom, writeScrollTop]);

  return { containerRef, onMessageAppended, onMediaLoad };
}
