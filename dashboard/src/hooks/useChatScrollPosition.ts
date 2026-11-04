import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { decideScroll, type ScrollDirection, type ScrollGeometry } from '../utils/scrollDecision.ts';

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
 *   BEFORE the new message is committed and decides whether the thread follows
 *   it; the scroll-to-bottom (if any) is applied by the commit that grows the
 *   thread, so the new message is already in the DOM. A frame is not that
 *   commit: it can run between the cache write and the render.
 * - Pinned-to-bottom: media (`<img>`/`<video>`) has no intrinsic size before it
 *   decodes, so the container's scrollHeight GROWS after the initial restore —
 *   silently un-bottoming the view (the thread looks like it "opened at the
 *   top"). While pinned, each `onMediaLoad` re-pins to the bottom; the pin
 *   releases as soon as the USER scrolls away from the bottom (and re-arms when
 *   they scroll back), so late-decoding media never yanks a reading user.
 * - Reading further back: the same late-decode growth, above a viewport that is
 *   NOT pinned to the bottom, holds the user's position instead of re-pinning.
 *   That is `onMediaLoad`'s third branch. The baseline comes from
 *   `measureMedia`, a ref callback that records each element's box height at
 *   DOM insertion, because a height read inside the load handler is already
 *   post-decode and would measure the growth as zero. It corrects only for
 *   media above the reading position: growth below it moves nothing on screen.
 *
 * Mount the returned `containerRef` on the scroll container (the `.room-messages`
 * div in Chats.tsx). The Map of saved positions lives in a ref so it doesn't
 * trigger renders and is garbage-collected when the host component unmounts. A chat the
 * reader left at the bottom has no entry (it reopens at its newest message), however
 * much arrived after their last scroll. The key names a thread, not just a chat: the
 * caller puts the session into it, since one chat id can have a thread in two sessions.
 */

/** Distance from the bottom (px) within which the user still counts as "at the bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 24;

/** Pure geometry check, exported for tests: is the viewport (nearly) at the container's bottom? */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_PIN_THRESHOLD_PX;
}

/**
 * Whether media that just finished loading sits above the reading position, taking both edges in
 * viewport coordinates. This is the one distinction native scroll anchoring made, and the reason
 * the correction cannot be a bare `scrollHeight` delta: growth BELOW the fold moves nothing on
 * screen, so adding it to `scrollTop` would drag the reader toward the newest messages instead of
 * holding them still. The thread is not virtualized, so every image between the reader and the
 * bottom fires one of these.
 *
 * Media straddling the top edge answers false. Only the part above the edge displaces anything, so
 * a full correction would overshoot, and leaving it uncorrected errs in the direction the reader
 * was already travelling rather than against it.
 */
export function grewAboveReadingPosition(mediaBottom: number, containerTop: number): boolean {
  return mediaBottom <= containerTop;
}

/**
 * How much `scrollTop` must gain to hold the reader still after a media element finished decoding,
 * or null when nothing on screen moved. This is a DELTA, not an absolute target, so the caller adds
 * it to the LIVE scrollTop at apply time: two elements decoding in one frame each contribute their
 * own growth and the reader is held through the sum, where a captured absolute would have the second
 * write overwrite the first with the same value and under-correct.
 *
 * `seededHeight` is the element's box height recorded when it MOUNTED. That matters: by the time a
 * `load` handler runs, the decoded size is already in layout, and every geometry read there flushes
 * it, so a baseline taken in the handler measures the growth as zero and the correction never
 * fires. DOM insertion is the one moment a browser guarantees is pre-decode.
 *
 * The growth is subtracted from the bottom edge before the above/below question is asked, because
 * `mediaBottom` is read post-decode: an element that displaced the reader can already measure below
 * the container's top edge by exactly the amount it grew.
 */
export function correctionForMediaGrowth(
  seededHeight: number,
  currentHeight: number,
  mediaBottom: number,
  containerTop: number,
): number | null {
  const grew = currentHeight - seededHeight;
  if (grew <= 0) return null;
  return grewAboveReadingPosition(mediaBottom - grew, containerTop) ? grew : null;
}

/** Marks the direct children of the scroll container a reader can be held in place by. */
export const SCROLL_ANCHOR_ATTRIBUTE = 'data-scroll-anchor';

/**
 * The first anchor element the reader can see, with its offset inside the thread's content (from the
 * top of what scrolls, not from the visible top edge): the thing an older page landing above must hold
 * still, whatever grew elsewhere in the thread meanwhile. In content coordinates the element's offset
 * changes only when something above it grew, so a reader who scrolls while the page is in flight is not
 * counted as the content moving.
 */
function firstVisibleAnchor(container: HTMLElement): { node: Element; top: number } | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const child of Array.from(container.children)) {
    if (!child.hasAttribute(SCROLL_ANCHOR_ATTRIBUTE)) continue;
    const rect = child.getBoundingClientRect();
    if (rect.bottom > containerTop) return { node: child, top: rect.top - containerTop + container.scrollTop };
  }
  return null;
}

/**
 * Where a saved spot is in the thread now: its offset, moved down by whatever sits above the row that was first in the
 * thread when it was saved. An older page asked for before the reader left a chat can land while they are in another
 * one, above everything the offset was measured against. With nothing new above that row the shift is zero and the
 * offset is written as saved; it is read live, as the images of such a page decode after the chat is shown again.
 */
function savedSpotTop(container: HTMLElement, spot: { top: number; first: string | null }): number {
  const first = container.querySelector(`[${SCROLL_ANCHOR_ATTRIBUTE}]`);
  const saved =
    spot.first === null
      ? undefined
      : Array.from(container.children).find(row => row.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) === spot.first);
  if (!first || !saved) return spot.top;
  return spot.top + saved.getBoundingClientRect().top - first.getBoundingClientRect().top;
}

export function useChatScrollPosition(
  activeChatId: string | null,
  isLoaded: boolean,
  isFetchingOlderMessages: boolean,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  onMessageAppended: (direction: ScrollDirection) => void;
  /** Pass the load event through: which element grew decides whether the reader moved at all. */
  onMediaLoad: (event?: { currentTarget: Element | null }) => void;
  /** Ref callback for every inline media element; seeds the pre-decode height onMediaLoad needs. */
  measureMedia: (el: Element | null) => void;
  /** Call when an older page is requested; the reading position is held once it lands. */
  onOlderMessagesRequested: () => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Each chat's saved offset, with the anchor key of the row that was first in its thread then (see savedSpotTop).
  const scrollMap = useRef<Map<string, { top: number; first: string | null }>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);
  const pinnedRef = useRef<boolean>(true);
  // Whether the visible chat's messages have rendered. While a chat loads, the container shows only a
  // spinner and the browser clamps scrollTop to it; that clamp arrives as a scroll event and is not a
  // position to remember.
  const loadedRef = useRef<boolean>(false);
  // A 'saved' restore writes scrollTop BEFORE media decodes — the browser clamps the write to the
  // still-short scrollHeight and the thread lands at the top. The saved value lives here and is
  // re-applied on every media decode until the user scrolls (any genuine scroll cancels it).
  const pendingRestoreRef = useRef<{ top: number; first: string | null } | null>(null);
  // Where our own last write left the thread, so the scroll listener can skip the event it raised (a genuine
  // user scroll both updates the pin state / position map AND cancels pendingRestore; our writes must do
  // neither). That event reports the position by value, and so does the clamp event a content swap queued
  // before a write that then moved nothing. A browser raises one event per frame however many writes the
  // frame held, so a flag cleared by a write that moved nothing handed the frame's one event to the reader.
  const programmaticTopRef = useRef<number | null>(null);
  // A live message the thread is to follow, until the commit that adds its row applies it (see the layout effect
  // after the older-page landing). `duringPage`: announced while an older page was out.
  const pendingFollowRef = useRef<{
    chat: string | null;
    direction: ScrollDirection;
    geometry: ScrollGeometry;
    duringPage: boolean;
  } | null>(null);
  // See the layout effect below.
  const prevScrollHeightRef = useRef<number>(0);
  const awaitingOlderPageRef = useRef<boolean>(false);
  const wasFetchingOlderRef = useRef<boolean>(false);
  // The row the landing holds the reader by, with its offset: taken when the older page is requested, and again on each
  // genuine scroll (the last one kept when none is in view), on a return to the chat with the page still out, and
  // after a pending restore's write while it is out; a correction for an image above it moves the offset by as much.
  // See the landing effect.
  const olderAnchorRef = useRef<{ node: Element; top: number } | null>(null);
  // The chat whose thread was still loading when the reader sent a message in it, until its restore decision.
  const sentWhileLoadingRef = useRef<string | null>(null);
  // Box height of each mounted media element, recorded at DOM insertion: the one moment a browser
  // guarantees is before the decode. A WeakMap so entries die with the nodes on a chat switch.
  const mediaHeights = useRef(new WeakMap<Element, number>());
  // Media whose load arrived since the last frame, for the reading-position correction in onMediaLoad.
  const decodedMediaRef = useRef<Element[]>([]);
  const mediaFramesRef = useRef(new Set<number>());
  const mediaVisitRef = useRef(0);

  // Each visit owns its frames and queue, including a return to the same chat.
  const retireMediaFrames = useCallback(() => {
    for (const frame of mediaFramesRef.current) cancelAnimationFrame(frame);
    mediaFramesRef.current.clear();
    decodedMediaRef.current = [];
    mediaVisitRef.current += 1;
  }, []);
  const scheduleMediaFrame = useCallback((apply: () => void) => {
    const visit = mediaVisitRef.current;
    const frame = requestAnimationFrame(() => {
      mediaFramesRef.current.delete(frame);
      if (mediaVisitRef.current === visit) apply();
    });
    mediaFramesRef.current.add(frame);
  }, []);

  useEffect(() => () => retireMediaFrames(), [retireMediaFrames]);

  const writeScrollTop = useCallback((el: HTMLDivElement, top: number) => {
    el.scrollTop = top;
    // The read-back, not `top`: the browser clamps a write to the content.
    programmaticTopRef.current = el.scrollTop;
  }, []);

  const pinToBottom = useCallback(
    (el: HTMLDivElement) => {
      writeScrollTop(el, el.scrollHeight);
      pinnedRef.current = true;
    },
    [writeScrollTop],
  );

  // A pin that follows the thread (a live message, a decoded image) forgets the chat's remembered offset too: the
  // reader is at the bottom again, and the offset from before the thread grew would bring them back above it. For
  // the same reason a saved spot still waiting for media is no longer theirs to be put back on.
  const followBottom = useCallback(
    (el: HTMLDivElement) => {
      pinToBottom(el);
      pendingRestoreRef.current = null;
      if (prevChatIdRef.current !== null) scrollMap.current.delete(prevChatIdRef.current);
    },
    [pinToBottom],
  );

  // Remember where the reader is in a chat, by the one rule every writer of the map follows: at the bottom is a
  // state, not an offset, because the thread keeps growing under a reader who follows it.
  const rememberPosition = useCallback((chatId: string, el: HTMLDivElement) => {
    if (isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) scrollMap.current.delete(chatId);
    else {
      const first = el.querySelector(`[${SCROLL_ANCHOR_ATTRIBUTE}]`)?.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) || null;
      scrollMap.current.set(chatId, { top: el.scrollTop, first });
    }
  }, []);

  // Holds the reader through the media whose load arrived since this last ran (see onMediaLoad's third branch): sorted by
  // document order, each element is read, re-seeded and corrected for before the next, so every one is classified
  // against a layout in which the growth above it is already corrected. With an older page out, a correction for an
  // element above the landing's anchor row moves that row's recorded offset by as much, so the landing does not count
  // the same pixels again; this runs before the anchor is taken and before the landing measures it, so each growth is
  // in either the recorded offset or a correction, never both.
  const applyMediaGrowth = useCallback(() => {
    const batch = decodedMediaRef.current
      .splice(0)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const cur = containerRef.current;
    if (!cur || batch.length === 0) return;
    const containerTop = cur.getBoundingClientRect().top;
    let moved = false;
    for (const grown of batch) {
      const seeded = mediaHeights.current.get(grown);
      if (seeded === undefined) continue;
      const rect = grown.getBoundingClientRect();
      // The element has finished growing, so its current box is the baseline for any later change (a re-decode
      // on a src swap, a lazy dimension arriving).
      mediaHeights.current.set(grown, rect.height);
      const grew = correctionForMediaGrowth(seeded, rect.height, rect.bottom, containerTop);
      if (grew === null) continue;
      // Added to the LIVE scrollTop, so each correction stacks on the ones applied above it.
      writeScrollTop(cur, cur.scrollTop + grew);
      moved = true;
      const anchor = olderAnchorRef.current;
      if (anchor && anchor.node.compareDocumentPosition(grown) & Node.DOCUMENT_POSITION_PRECEDING) anchor.top += grew;
      prevScrollHeightRef.current += grew;
    }
    if (moved && prevChatIdRef.current !== null) rememberPosition(prevChatIdRef.current, cur);
  }, [rememberPosition, writeScrollTop]);

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
      // Any event ends the marker's use: a reader who lands on the same offset later is the reader.
      const ours = el.scrollTop === programmaticTopRef.current;
      programmaticTopRef.current = null;
      if (ours) return;
      // A genuine user scroll: cancels any pending restore, then updates pin + position map.
      pendingRestoreRef.current = null;
      const atBottom = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
      pinnedRef.current = atBottom;
      const visibleChatId = prevChatIdRef.current;
      if (visibleChatId && loadedRef.current) rememberPosition(visibleChatId, el);
      // With an older page out, the landing holds the row the reader is on now, not the one they asked for the page on.
      if (awaitingOlderPageRef.current) {
        applyMediaGrowth();
        olderAnchorRef.current = firstVisibleAnchor(el) ?? olderAnchorRef.current;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  useLayoutEffect(() => {
    const next = activeChatId;
    const el = containerRef.current;
    // A new restore decision supersedes any pending one (it belongs to a different chat/visit).
    pendingRestoreRef.current = null;
    // Same for a page still in flight: its delta belongs to the thread being left. This effect is
    // declared before the height tracker, so the flag is gone before the tracker could act on it.
    if (next !== prevChatIdRef.current) {
      awaitingOlderPageRef.current = false;
      retireMediaFrames();
    }

    const decision = decideRestoreTarget(next, isLoaded, next !== null ? scrollMap.current.get(next)?.top : undefined);
    // A message the reader sent while this chat loaded opens it at that message, the way a send in a loaded chat
    // scrolls to it. Only in the chat it was sent in: the next restore decision, in whichever chat, forgets it.
    const sentWhileLoading = sentWhileLoadingRef.current === next;
    if (decision.restore !== null) sentWhileLoadingRef.current = null;

    if (el) {
      if (decision.restore !== null && sentWhileLoading) {
        followBottom(el);
      } else if (decision.restore === 'saved' && next !== null) {
        const saved = scrollMap.current.get(next);
        if (saved !== undefined) {
          pendingRestoreRef.current = saved; // re-applied on media loads until the user scrolls
          writeScrollTop(el, savedSpotTop(el, saved));
          pinnedRef.current = false; // a saved spot is (almost always) not the bottom
        }
      } else if (decision.restore === 'bottom') {
        pinToBottom(el);
      }
    }

    prevChatIdRef.current = next;
    loadedRef.current = isLoaded;
  }, [activeChatId, isLoaded, followBottom, pinToBottom, writeScrollTop, retireMediaFrames]);

  const onOlderMessagesRequested = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    applyMediaGrowth();
    prevScrollHeightRef.current = el.scrollHeight;
    olderAnchorRef.current = firstVisibleAnchor(el);
    awaitingOlderPageRef.current = true;
  }, [applyMediaGrowth]);

  // Older messages are prepended ABOVE the viewport, so the thread grows upward and what the user
  // was reading is pushed down by however much taller it just got. Left alone the view jumps
  // backwards at the exact moment they asked for more.
  //
  // The reader's row and its offset are read when the page is REQUESTED and read again while it is out (each
  // genuine scroll of the reader, a return to the chat, a restore write), so the row is the one the reader is on
  // when the page lands, or the last one in view when none is. The delta is how far that row moved down, applied
  // on the commit where the in-flight flag falls, not on the first commit whose height changed, which may be a
  // live message or a preview decoding while the page is out. The older-page indicator is not one of those: it
  // takes no room in the thread (Chats.css), so it moves nothing when it appears. `scrollTop` is read live at
  // apply time, so a deliberate reposition made during the fetch survives. The pin/restore machinery above is
  // not reused: it writes an ABSOLUTE target, which is unknowable here.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const wasFetching = wasFetchingOlderRef.current;
    wasFetchingOlderRef.current = isFetchingOlderMessages;
    // A chat shown again with its older page still out (leaving does not cancel it): the switch dropped what the
    // request recorded, so the page is held against where the restore has just put the reader instead.
    if (isFetchingOlderMessages && !awaitingOlderPageRef.current) onOlderMessagesRequested();
    // The FALLING edge, not merely "not fetching": the request is made in a scroll handler and the
    // query only reports itself in flight a turn later, so any commit in between — a live message,
    // a media decode, another query resolving — would otherwise consume the pending correction.
    if (!el || isFetchingOlderMessages || !wasFetching || !awaitingOlderPageRef.current) return;
    applyMediaGrowth(); // a decode whose frame has not run yet is counted there, not in the anchor's move
    awaitingOlderPageRef.current = false;
    // A follow still armed belongs to a message announced before the reader went back for history; the page that
    // lands is not its row, and consuming it here would take the reader from the message they were held on to the
    // bottom. A message the reader sent while the page was out is the exception: its row can land in this same commit,
    // and the follow below takes them to it.
    const follow = pendingFollowRef.current;
    if (!(follow?.direction === 'outgoing' && follow.duringPage)) pendingFollowRef.current = null;
    // How far the element the reader was on moved down. Measured on the element, not as a change of the
    // whole thread's height: a preview that swapped in below the reader, or a live message at the
    // bottom, while the page was in flight is inside that height delta and moves nothing on screen, so
    // adding it dragged the reader down the thread. Without a surviving anchor (a chat that had no
    // visible message, or one re-rendered under another key) the height delta is all there is.
    const anchor = olderAnchorRef.current;
    olderAnchorRef.current = null;
    const grew =
      anchor && el.contains(anchor.node)
        ? anchor.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - anchor.top
        : el.scrollHeight - prevScrollHeightRef.current;
    if (grew > 0) {
      // The offset a pending restore wants is from before the page; the reader is held on their message now, and
      // a decode that applied it again would take them to the top of what just landed.
      pendingRestoreRef.current = null;
      const corrected = el.scrollTop + grew;
      writeScrollTop(el, corrected);
      // writeScrollTop marks this as a programmatic write, so the scroll listener's own
      // scrollMap.set skips it — without saving it here too, the map keeps whatever the user's
      // last REAL scroll left there, which is necessarily above the paging threshold (that is
      // what triggered this fetch). Leaving without scrolling again and coming back would restore
      // to that stale, too-high spot instead of the corrected one actually being read.
      if (activeChatId !== null) rememberPosition(activeChatId, el);
    }
  });

  // Applies a live message's follow on the first commit that grows the thread (see onMessageAppended): the row
  // is in the DOM, and no frame can have run between the commit and the pin. The reader may have scrolled away
  // while the row was on its way, so the follow question is asked again, against where they are now.
  useLayoutEffect(() => {
    const follow = pendingFollowRef.current;
    const el = containerRef.current;
    if (!follow || !el) return;
    // The chat the message was announced in is not the one on screen any more, or the message is not the reader's own
    // and the chat is on its way to a saved spot.
    if (
      follow.chat !== prevChatIdRef.current ||
      (follow.direction === 'incoming' && pendingRestoreRef.current !== null)
    ) {
      pendingFollowRef.current = null;
      return;
    }
    if (el.scrollHeight <= follow.geometry.scrollHeight) return;
    pendingFollowRef.current = null;
    if (decideScroll(follow.direction, { ...follow.geometry, scrollTop: el.scrollTop }) === 'bottom') followBottom(el);
  });

  // A commit that shrinks a thread pinned to its bottom (a sent message's placeholder dropped after its echo added a
  // row) has the browser clamp scrollTop to the new bottom and report that as a scroll. The clamp is the thread's own
  // move: an image that decodes in the same frame grows the thread before the event is handled, and the listener would
  // take the clamped position for the reader leaving the bottom, dropping the pin the decode was to follow.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !pinnedRef.current || el.scrollTop === programmaticTopRef.current) return;
    if (el.scrollHeight - el.clientHeight - el.scrollTop <= 1) programmaticTopRef.current = el.scrollTop;
  });

  const onMessageAppended = useCallback((direction: ScrollDirection) => {
    const el = containerRef.current;
    // A chat that has not rendered its thread has nothing to follow: the restore decides where it opens. Nor has one
    // that is still on its way to a saved spot, for a message that arrives: the short, undecoded thread reads as at
    // the bottom, and following it would drop the saved spot the next decode puts the reader back on. A message the
    // reader sends themselves always scrolls, saved spot or not, and one sent while the thread loads opens it there.
    if (!el || !loadedRef.current) {
      if (direction === 'outgoing') sentWhileLoadingRef.current = prevChatIdRef.current;
      return;
    }
    if (direction === 'incoming' && pendingRestoreRef.current !== null) return;
    const geometry = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    if (decideScroll(direction, geometry) === 'preserve') return;
    pendingFollowRef.current = {
      chat: prevChatIdRef.current,
      direction,
      geometry,
      duringPage: awaitingOlderPageRef.current,
    };
  }, []);

  // Media has no layout box before it decodes. While pinned, each decode re-pins to the bottom;
  // while a 'saved' restore is pending, each decode RE-APPLIES the saved scrollTop (the first write
  // was clamped to the pre-decode scrollHeight). A user scroll clears both, so late-decoding media
  // never yanks a reading user.
  //
  // Reading further back through media-heavy history is the third case: not pinned, nothing
  // pending. A decode above the viewport still grows the thread with no reserved box (there is no
  // width/height in the media metadata to size one from up front), pushing what the user is
  // reading down exactly like an unabsorbed older-page prepend, and it is held the same way. The
  // decode has no request event to hang a snapshot on, so its load event only names the element and
  // queues it; the next frame reads the element against the height `measureMedia` seeded at insertion
  // (applyMediaGrowth), and that says whether the reader moved at all.
  /** Attach to every inline media element: seeds its pre-decode height for onMediaLoad. */
  const measureMedia = useCallback((el: Element | null) => {
    if (el) mediaHeights.current.set(el, el.getBoundingClientRect().height);
  }, []);

  const onMediaLoad = useCallback(
    (event?: { currentTarget: Element | null }) => {
      // The container is reused across chats, so a switch between the event and its frame would apply the frame's
      // write to a different thread, and save it under that thread's id. prevChatIdRef holds whichever chat is
      // actually on screen, set by the restore effect above.
      const onScreen = () => prevChatIdRef.current === activeChatId;
      if (!onScreen()) return;
      const media = event?.currentTarget ?? null;
      if (media && (!containerRef.current?.contains(media) || !mediaHeights.current.has(media))) return;
      const pending = pendingRestoreRef.current;
      if (pending !== null) {
        scheduleMediaFrame(() => {
          const cur = containerRef.current;
          if (!cur || !onScreen() || pendingRestoreRef.current !== pending) return;
          writeScrollTop(cur, savedSpotTop(cur, pending));
          // What grew above the spot is absorbed by this write: a page still out is held from where it put the reader.
          if (awaitingOlderPageRef.current) onOlderMessagesRequested();
        });
        return;
      }
      if (pinnedRef.current) {
        scheduleMediaFrame(() => {
          const cur = containerRef.current;
          if (cur && onScreen() && pinnedRef.current) followBottom(cur);
        });
        return;
      }
      if (!containerRef.current) return;
      // Which element grew, and by how much, decides whether the reader moved at all.
      if (!media) return;
      // Measured in the frame, top to bottom, each after the corrections above it: read when its load event fires,
      // an element can sit below another that grew in the same frame and was not corrected yet, and then reads as
      // below the reader by that growth.
      const decoded = decodedMediaRef.current;
      decoded.push(media);
      if (decoded.length > 1) return;
      scheduleMediaFrame(() => {
        if (onScreen()) applyMediaGrowth();
        else decoded.length = 0;
      });
    },
    [activeChatId, applyMediaGrowth, followBottom, onOlderMessagesRequested, writeScrollTop, scheduleMediaFrame],
  );

  return { containerRef, onMessageAppended, onMediaLoad, measureMedia, onOlderMessagesRequested };
}
