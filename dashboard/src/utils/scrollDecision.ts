export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ScrollDirection = 'incoming' | 'outgoing';
export type ScrollAction = 'bottom' | 'preserve';

const DEFAULT_NEAR_BOTTOM_THRESHOLD = 100;

/**
 * Decide whether to scroll to bottom after a new message is appended.
 *
 * - Outgoing (user sent it) always scrolls — the user wants to see their own message.
 * - Incoming scrolls only when the user is already near the bottom (i.e. they're
 *   following the conversation). When the user has scrolled up to read older messages,
 *   we preserve their position so a new arrival doesn't yank them away.
 *
 * `geometry` should be captured BEFORE the new message has been committed to the DOM,
 * so `scrollHeight` reflects the pre-append state and the "near bottom" question
 * answers the user's current intent.
 */
export function decideScroll(
  direction: ScrollDirection,
  geometry: ScrollGeometry,
  nearBottomThreshold: number = DEFAULT_NEAR_BOTTOM_THRESHOLD,
): ScrollAction {
  if (direction === 'outgoing') return 'bottom';
  const gap = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return gap < nearBottomThreshold ? 'bottom' : 'preserve';
}

// Larger than the near-bottom auto-scroll threshold: the "jump to bottom" affordance should appear
// only once the user has deliberately scrolled up a meaningful amount, not on tiny offsets.
export const DEFAULT_JUMP_VISIBILITY_THRESHOLD = 240;

/**
 * Whether the user has scrolled far enough from the bottom to warrant showing a "jump to bottom"
 * button. `gap` is the distance (px) between the current viewport bottom and the content bottom.
 */
export function isAwayFromBottom(
  geometry: ScrollGeometry,
  threshold: number = DEFAULT_JUMP_VISIBILITY_THRESHOLD,
): boolean {
  const gap = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return gap > threshold;
}

// How close to the top (px) the user must scroll before we fetch the next older page.
export const DEFAULT_NEAR_TOP_THRESHOLD = 120;

/** Whether the user has scrolled near the top of the thread — the cue to load older messages. */
export function isNearTop(scrollTop: number, threshold: number = DEFAULT_NEAR_TOP_THRESHOLD): boolean {
  return scrollTop <= threshold;
}

/**
 * New scrollTop that keeps the currently-visible messages in place after older ones are prepended.
 * Prepending grows the content above the viewport by (newScrollHeight - prevScrollHeight), so the
 * scroll offset must grow by the same amount — otherwise the view jumps up to the new top.
 */
export function anchorScrollTopAfterPrepend(
  prevScrollTop: number,
  prevScrollHeight: number,
  newScrollHeight: number,
): number {
  return prevScrollTop + (newScrollHeight - prevScrollHeight);
}
