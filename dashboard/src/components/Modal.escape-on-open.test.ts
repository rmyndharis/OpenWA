// A dialog opened by an update outside any user event (a save request that answered) is on screen as soon as React
// has inserted it. An Escape pressed from then on must close it: one pressed before its key handling was bound would
// be lost, and the dialog would stay up until the key was pressed again.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';

let rtl: typeof import('@testing-library/react');
let Modal: (typeof import('./Modal.tsx'))['Modal'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // jsdom lays nothing out, so no control would count as shown and focus could only go to the card.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  rtl = await import('@testing-library/react');
  ({ Modal } = await import('./Modal.tsx'));
});

afterEach(() => rtl.cleanup());

test('an Escape pressed the moment a dialog is inserted closes it', async () => {
  let setOpen: (open: boolean) => void = () => undefined;
  let closes = 0;
  function Page() {
    const [open, set] = useState(false);
    setOpen = set;
    return createElement(Modal, {
      open,
      onClose: () => closes++,
      title: 'Restart now?',
      children: createElement('button', { type: 'button' }, 'Restart later'),
    });
  }
  rtl.render(createElement(Page));

  const pressed = new Promise<void>(resolve => {
    const observer = new MutationObserver(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return;
      observer.disconnect();
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  // Outside act(), as a request that answered opens it.
  const warn = console.error;
  console.error = () => undefined;
  try {
    setOpen(true);
    await pressed;
  } finally {
    console.error = warn;
  }

  assert.equal(closes, 1, 'the Escape pressed as the dialog appeared was lost');
});

test('a dialog moves focus in and gives it back to its opener as before', async () => {
  function Page() {
    const [open, setOpen] = useState(false);
    return createElement(
      'div',
      null,
      createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open'),
      createElement(Modal, {
        open,
        onClose: () => setOpen(false),
        title: 'Restart now?',
        children: createElement('button', { type: 'button' }, 'Restart later'),
      }),
    );
  }
  rtl.render(createElement(Page));
  const opener = rtl.screen.getByRole('button', { name: 'Open' });
  opener.focus();

  rtl.fireEvent.click(opener);
  const dialog = rtl.screen.getByRole('dialog');
  assert.ok(dialog.contains(document.activeElement), 'focus did not move into the dialog');
  assert.ok(
    document.activeElement === rtl.screen.getByRole('button', { name: 'Close' }),
    'focus is not on the first control',
  );

  rtl.fireEvent.keyDown(dialog, { key: 'Escape' });
  assert.equal(rtl.screen.queryByRole('dialog'), null);
  assert.ok(document.activeElement === opener, 'focus did not return to the opener');
});
