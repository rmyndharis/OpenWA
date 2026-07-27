import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindModalA11y } from './modalA11y.ts';

// Minimal DOM doubles — just the surface bindModalA11y touches: event registry, body style,
// activeElement tracking, contains(), and focusable elements with focus() + offsetParent.

interface FakeEvent {
  key: string;
  shiftKey?: boolean;
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
