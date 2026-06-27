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
