import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindModalA11y } from './modalA11y.ts';

// Minimal DOM doubles — just the surface bindModalA11y touches: event registry, body style,
// activeElement tracking, contains(), and focusable elements with focus() + offsetParent.

interface FakeEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function makeKeyEvent(key: string, shiftKey = false): FakeEvent {
  return {
    key,
    shiftKey,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

function makeWorld(focusableCount = 2) {
  const keydownListeners = new Set<(e: FakeEvent) => void>();
  const attached = new Set<object>();

  const doc = {
    activeElement: null as { focus(): void } | null,
    body: { style: { overflow: '' } },
    addEventListener(_type: string, fn: (e: FakeEvent) => void) {
      keydownListeners.add(fn);
    },
    removeEventListener(_type: string, fn: (e: FakeEvent) => void) {
      keydownListeners.delete(fn);
    },
    contains(el: object) {
      return attached.has(el);
    },
    dispatchKey(event: FakeEvent) {
      for (const fn of [...keydownListeners]) fn(event);
    },
    listenerCount() {
      return keydownListeners.size;
    },
  };

  const makeElement = () => {
    const el = {
      offsetParent: {} as object | null, // non-null → "visible" for the focusable filter
      focus() {
        doc.activeElement = el as never;
      },
    };
    attached.add(el);
    return el;
  };

  const focusables = Array.from({ length: focusableCount }, makeElement);
  const card = {
    focus() {
      doc.activeElement = card as never;
    },
    querySelectorAll: () => focusables,
    contains: (el: unknown) => el === card || focusables.includes(el as (typeof focusables)[number]),
  };
  attached.add(card);

  return {
    doc,
    card,
    focusables,
    makeElement,
    detach(el: object) {
      attached.delete(el);
    },
  };
}

test('locks background scroll while open and restores the previous value on close', () => {
  const { doc, card } = makeWorld();
  assert.equal(doc.body.style.overflow, '');
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  assert.equal(doc.body.style.overflow, 'hidden');
  unbind();
  assert.equal(doc.body.style.overflow, '');
});

test('moves initial focus to the first visible focusable in the dialog', () => {
  const { doc, card, focusables } = makeWorld(3);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  assert.equal(doc.activeElement, focusables[0] as never);
  unbind();
});

test('moves initial focus to the element the dialog names, and records the opener before that', () => {
  const { doc, card, focusables, makeElement } = makeWorld(3);
  const opener = makeElement();
  opener.focus();
  const unbind = bindModalA11y(
    doc as never,
    card as never,
    () => {},
    () => focusables[2] as never,
  );
  assert.equal(doc.activeElement, focusables[2] as never);
  unbind();
  assert.equal(doc.activeElement, opener as never, 'focus did not return to the opener');
});

test('falls back to the first focusable when the named initial focus is not there', () => {
  const { doc, card, focusables } = makeWorld(3);
  const unbind = bindModalA11y(
    doc as never,
    card as never,
    () => {},
    () => null,
  );
  assert.equal(doc.activeElement, focusables[0] as never);
  unbind();
});

test('focuses the card itself when the dialog has nothing focusable', () => {
  const { doc, card } = makeWorld(0);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  assert.equal(doc.activeElement, card as never);
  unbind();
});

test('Escape closes the dialog and stops propagation', () => {
  const { doc, card } = makeWorld();
  let closed = 0;
  const unbind = bindModalA11y(doc as never, card as never, () => closed++);
  const event = makeKeyEvent('Escape');
  doc.dispatchKey(event);
  assert.equal(closed, 1);
  assert.equal(event.propagationStopped, true);
  unbind();
});

test('an Escape that ends an IME composition is left to the field', () => {
  const { doc, card } = makeWorld();
  let closed = 0;
  const unbind = bindModalA11y(doc as never, card as never, () => closed++);
  const event = { ...makeKeyEvent('Escape'), isComposing: true };
  doc.dispatchKey(event);
  assert.equal(closed, 0);
  assert.equal(event.propagationStopped, false);
  unbind();
});

test('returns focus to the trigger element on close', () => {
  const { doc, card, focusables, makeElement } = makeWorld();
  const trigger = makeElement();
  trigger.focus(); // user was on the trigger when the dialog opened
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  assert.equal(doc.activeElement, focusables[0] as never); // focus moved into the dialog
  unbind();
  assert.equal(doc.activeElement, trigger as never); // …and back to the trigger on close
});

test('does not restore focus when the trigger has left the document', () => {
  const { doc, card, focusables, makeElement, detach } = makeWorld();
  const trigger = makeElement();
  trigger.focus();
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  // The row that opened the dialog was deleted while it was open.
  detach(trigger);
  unbind();
  assert.equal(doc.activeElement, focusables[0] as never); // focus stays put, no throw
});

test('Tab on the last focusable wraps to the first; Shift+Tab on the first wraps to the last', () => {
  const { doc, card, focusables } = makeWorld(3);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  const [first, , last] = focusables;

  last.focus();
  const forward = makeKeyEvent('Tab');
  doc.dispatchKey(forward);
  assert.equal(forward.defaultPrevented, true);
  assert.equal(doc.activeElement, first as never);

  first.focus();
  const backward = makeKeyEvent('Tab', true);
  doc.dispatchKey(backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(doc.activeElement, last as never);
  unbind();
});

test('cleanup removes the keydown listener (no stray closes after unmount)', () => {
  const { doc, card } = makeWorld();
  let closed = 0;
  const unbind = bindModalA11y(doc as never, card as never, () => closed++);
  assert.equal(doc.listenerCount(), 1);
  unbind();
  assert.equal(doc.listenerCount(), 0);
  doc.dispatchKey(makeKeyEvent('Escape'));
  assert.equal(closed, 0);
});

test('nested dialogs: Escape closes only the topmost; the parent closes once it is topmost again', () => {
  const { doc, card } = makeWorld();
  let parentClosed = 0;
  let nestedClosed = 0;
  const unbindParent = bindModalA11y(doc as never, card as never, () => parentClosed++);
  const unbindNested = bindModalA11y(doc as never, card as never, () => nestedClosed++);

  const first = makeKeyEvent('Escape');
  doc.dispatchKey(first);
  assert.equal(nestedClosed, 1);
  assert.equal(parentClosed, 0); // the parent's form input survives the nested Escape
  assert.equal(first.propagationStopped, true);

  // React unmounts the closed nested dialog (running its cleanup) — now the parent owns Escape.
  unbindNested();
  doc.dispatchKey(makeKeyEvent('Escape'));
  assert.equal(parentClosed, 1);
  unbindParent();
});

test('a nested dialog still owns Escape when the parent unmounts first', () => {
  const { doc, card } = makeWorld();
  let parentClosed = 0;
  let nestedClosed = 0;
  const unbindParent = bindModalA11y(doc as never, card as never, () => parentClosed++);
  const unbindNested = bindModalA11y(doc as never, card as never, () => nestedClosed++);

  // The parent was closed by an overlay click, unmounting its subtree — including this nested
  // dialog's container in the real DOM; its binder may outlive the parent's.
  unbindParent();
  doc.dispatchKey(makeKeyEvent('Escape'));
  assert.equal(nestedClosed, 1);
  assert.equal(parentClosed, 0);
  unbindNested();
});

// Unmounting a page with a nested dialog open runs the parent's cleanup first (React unmounts a
// deleted subtree parent-first). Each dialog restoring its own saved value left the nested one's
// 'hidden' in place, and the next page could not scroll until a reload.
test('the scroll lock is released once the last dialog closes, whatever the close order', () => {
  const { doc, card } = makeWorld();
  doc.body.style.overflow = 'auto';
  const unbindParent = bindModalA11y(doc as never, card as never, () => {});
  const unbindNested = bindModalA11y(doc as never, card as never, () => {});

  unbindParent();
  assert.equal(doc.body.style.overflow, 'hidden'); // the nested dialog is still open
  unbindNested();
  assert.equal(doc.body.style.overflow, 'auto');
});

test('Tab and Shift+Tab on a control that is neither first nor last are left to the browser', () => {
  const { doc, card, focusables } = makeWorld(3);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  const [first, middle, last] = focusables;

  middle.focus();
  const forward = makeKeyEvent('Tab');
  doc.dispatchKey(forward);
  assert.equal(forward.defaultPrevented, false);
  assert.equal(doc.activeElement, middle as never);

  const backward = makeKeyEvent('Tab', true);
  doc.dispatchKey(backward);
  assert.equal(backward.defaultPrevented, false);
  assert.equal(doc.activeElement, middle as never);

  // Neither end is touched by the other direction either.
  last.focus();
  const backFromLast = makeKeyEvent('Tab', true);
  doc.dispatchKey(backFromLast);
  assert.equal(backFromLast.defaultPrevented, false);
  first.focus();
  const forwardFromFirst = makeKeyEvent('Tab');
  doc.dispatchKey(forwardFromFirst);
  assert.equal(forwardFromFirst.defaultPrevented, false);
  unbind();
});

test('Tab stays on an empty dialog card in either direction', () => {
  const { doc, card } = makeWorld(0);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  try {
    for (const shiftKey of [false, true]) {
      const event = makeKeyEvent('Tab', shiftKey);
      doc.dispatchKey(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(doc.activeElement, card as never);
    }
  } finally {
    unbind();
  }
});

test('a dialog regains focus after its last controls disappear', () => {
  const { doc, card, focusables } = makeWorld(2);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  try {
    focusables.splice(0);
    const event = makeKeyEvent('Tab');
    doc.dispatchKey(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(doc.activeElement, card as never);
  } finally {
    unbind();
  }
});

test('Tab recovers focus from outside the active dialog in either direction', () => {
  const { doc, card, focusables, makeElement } = makeWorld(2);
  const background = makeElement();
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  try {
    for (const shiftKey of [false, true]) {
      background.focus();
      const event = makeKeyEvent('Tab', shiftKey);
      doc.dispatchKey(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(doc.activeElement, focusables[shiftKey ? 1 : 0] as never);
    }
  } finally {
    unbind();
  }
});

test('a lower dialog does not handle Tab while the nested dialog owns focus', () => {
  const { doc, card, makeElement } = makeWorld(0);
  const controls = Array.from({ length: 3 }, makeElement);
  const nested = {
    focus() {
      doc.activeElement = nested as never;
    },
    querySelectorAll: () => controls,
    contains: (el: unknown) => el === nested || controls.includes(el as (typeof controls)[number]),
  };
  const unbindParent = bindModalA11y(doc as never, card as never, () => {});
  const unbindNested = bindModalA11y(doc as never, nested as never, () => {});
  try {
    controls[1].focus();
    const event = makeKeyEvent('Tab');
    doc.dispatchKey(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(doc.activeElement, controls[1] as never);
  } finally {
    unbindNested();
    unbindParent();
  }
});

test('Shift+Tab from the dialog card wraps to the last control, and Tab from it is left to the browser', () => {
  const { doc, card, focusables } = makeWorld(2);
  const unbind = bindModalA11y(doc as never, card as never, () => {});
  try {
    card.focus();
    const back = makeKeyEvent('Tab', true);
    doc.dispatchKey(back);
    assert.equal(back.defaultPrevented, true);
    assert.equal(doc.activeElement, focusables[1] as never);

    card.focus();
    const forward = makeKeyEvent('Tab');
    doc.dispatchKey(forward);
    assert.equal(forward.defaultPrevented, false);
    assert.equal(doc.activeElement, card as never);
  } finally {
    unbind();
  }
});
