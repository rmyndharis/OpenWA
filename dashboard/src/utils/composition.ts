/**
 * Whether a keydown belongs to an input method: the Enter that commits the text being composed and the Escape that
 * cancels it are the input method's keys, not the page's. Browsers flag such a keydown with isComposing, or give it
 * keyCode 229, the code for a key the input method processed. A React handler passes `event.nativeEvent`: the
 * synthetic event has no isComposing.
 */
export function isComposingKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}
