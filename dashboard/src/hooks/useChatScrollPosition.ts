import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
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
  const prevLoadedRef = useRef<boolean>(false);
  const pinnedRef = useRef<boolean>(true);
  const scrollListenerElRef = useRef<HTMLDivElement | null>(null);

  const pinToBottom = useCallback((el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
  }, []);

  // Track the pin state from scroll geometry alone: any scroll that lands at the bottom (ours or the
  // user's) pins; any scroll away (only ever the user's) unpins — no programmatic/user distinction
  // needed. Attached once the container exists; the element is stable for the component's lifetime.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || scrollListenerElRef.current === el) return undefined;
    scrollListenerElRef.current = el;
    const onScroll = () => {
      pinnedRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

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
        if (saved !== undefined) {
          el.scrollTop = saved;
          pinnedRef.current = false; // a saved spot is (almost always) not the bottom
        }
      } else if (decision.restore === 'bottom') {
        pinToBottom(el);
      }
    }

    prevChatIdRef.current = next;
    prevLoadedRef.current = isLoaded;
  }, [activeChatId, isLoaded, pinToBottom]);

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

  // Media has no layout box before it decodes; while pinned, each decode re-pins to the bottom so
  // late-loading images/video can't silently un-bottom a freshly opened (or freshly appended-to)
  // thread. A user scroll away from the bottom clears the pin, so this never fights the reader.
  const onMediaLoad = useCallback(() => {
    if (!pinnedRef.current) return;
    requestAnimationFrame(() => {
      const cur = containerRef.current;
      if (cur && pinnedRef.current) pinToBottom(cur);
    });
  }, [pinToBottom]);

  return { containerRef, onMessageAppended, onMediaLoad };
}
