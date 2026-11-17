import type { KeyboardEvent } from 'react';
import { isComposingKey } from './composition.ts';

/**
 * The keys of a row of role="tab" buttons that select as they take focus: ArrowRight and ArrowLeft move to the next and
 * previous tab and wrap, in the reading direction of the row (a right-to-left row swaps them), and Home and End go to
 * the first and last. The tab is focused and clicked, so the page selects it as a pointer press does. Put it on the
 * tablist and give each tab tabIndex={selected ? 0 : -1}, so the row is one stop in the Tab order.
 */
export function onTabListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isComposingKey(event.nativeEvent)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const from = tabs.indexOf((event.target as HTMLElement).closest<HTMLElement>('[role="tab"]') as HTMLElement);
  if (from < 0) return;
  const [forward, backward] =
    getComputedStyle(event.currentTarget).direction === 'rtl'
      ? ['ArrowLeft', 'ArrowRight']
      : ['ArrowRight', 'ArrowLeft'];
  const to =
    event.key === forward
      ? (from + 1) % tabs.length
      : event.key === backward
        ? (from + tabs.length - 1) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : -1;
  if (to < 0) return;
  event.preventDefault();
  if (to === from) return;
  tabs[to].focus();
  tabs[to].click();
}
