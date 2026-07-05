/**
 * Compute the contiguous block of page numbers to show in a numbered paginator, centered on the
 * current page and clamped to the valid range. Replaces a frozen `[1..5]` window that left pages
 * beyond 5 unreachable by number and lost the active highlight.
 *
 * @param current    1-based current page (clamped into range).
 * @param totalPages total number of pages.
 * @param size       max page buttons to show (default 5).
 */
export function pageWindow(current: number, totalPages: number, size = 5): number[] {
  if (totalPages <= 0) return [];
  const clamped = Math.min(Math.max(current, 1), totalPages);
  const count = Math.min(size, totalPages);
  // Center the window on the current page, then slide it back inside [1, totalPages].
  let start = clamped - Math.floor(count / 2);
  start = Math.max(1, Math.min(start, totalPages - count + 1));
  return Array.from({ length: count }, (_, i) => start + i);
}
