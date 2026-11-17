// The sidebar language list is a disclosure of plain buttons, like the room menu on the Chats page. It used to declare
// the menu pattern (aria-haspopup, role="menu", menuitemradio) while focus stayed on the button and the arrow keys did
// nothing, so a screen reader announced keys the list does not answer. Without the role the page behind the list has
// to be told that its Escape was handled: the Chats page and the emoji picker skip a key that is already handled, and
// used to find the open list by its role.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Fragment, type ReactNode } from 'react';

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
let Modal: (typeof import('./Modal.tsx'))['Modal'];

function layoutTree(beside?: ReactNode) {
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'baileys',
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  };
  return createElement(
    Fragment,
    null,
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(MemoryRouter, null, createElement(Layout, { onLogout: () => undefined, userRole: 'admin' })),
    ),
    beside,
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ message: 'unstubbed' }), { status: 404 }))) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ Layout } = await import('./Layout.tsx'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
  ({ Modal } = await import('./Modal.tsx'));
});

afterEach(() => rtl.cleanup());
after(() => rtl.cleanup());

function openLanguageList() {
  const view = rtl.render(layoutTree());
  const { container } = view;
  const button = container.querySelector<HTMLButtonElement>('.language-menu > button')!;
  button.focus();
  rtl.fireEvent.click(button);
  const list = container.querySelector<HTMLElement>('.language-menu-list')!;
  const items = [...list.querySelectorAll<HTMLButtonElement>('button')];
  return { view, container, button, list, items };
}

test('the language list declares no menu pattern it does not keep', () => {
  const { button, list, items } = openLanguageList();
  assert.ok(items.length > 1, 'the list offers the languages');
  const claimsMenu =
    button.getAttribute('aria-haspopup') === 'menu' ||
    list.getAttribute('role') === 'menu' ||
    items.some(item => item.getAttribute('role')?.startsWith('menuitem'));
  assert.equal(claimsMenu, false, 'the list declares the menu pattern but keeps no focus move and no arrow keys');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
});

test('the language list is a labelled group that marks the language in use as current', () => {
  const { list, items } = openLanguageList();
  assert.ok(list === rtl.screen.getByRole('group', { name: 'Language' }), 'the list is not the group named Language');
  const current = items.filter(item => item.getAttribute('aria-current') === 'true');
  assert.deepEqual(
    current.map(item => item.textContent),
    ['English'],
  );
  assert.equal(items.filter(item => item.hasAttribute('aria-checked')).length, 0);
});

// The page behind the sidebar, as Chats.tsx (the open chat, a bubble listener) and the emoji picker in ChatComposer.tsx
// (a capture listener) register theirs before the list opens: each skips a handled key and a dialog or menu surface.
for (const capture of [false, true]) {
  test(`one Escape closes the language list and not what the page behind it closes on Escape (${capture ? 'capture' : 'bubble'})`, () => {
    const closed: string[] = [];
    const behindTheList = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      closed.push('the page');
    };
    document.addEventListener('keydown', behindTheList, capture);
    try {
      const { container, button, items } = openLanguageList();
      items[0].focus();
      rtl.fireEvent.keyDown(items[0], { key: 'Escape' });
      assert.ok(container.querySelector('.language-menu-list') === null, 'Escape left the list open');
      assert.ok(document.activeElement === button, `focus is on ${document.activeElement?.tagName}`);
      assert.deepEqual(closed, [], 'the same Escape also closed what the page behind the list owns');

      // The list gone, the key belongs to the page again (a positive control for the listener above).
      rtl.fireEvent.keyDown(document.body, { key: 'Escape' });
      assert.deepEqual(closed, ['the page']);
    } finally {
      document.removeEventListener('keydown', behindTheList, capture);
    }
  });
}

// A dialog renders above the list and takes Escape for itself (the shared Modal handles it in the capture phase and
// stops it there). The list is taken on window, earlier than that, so it has to leave the key to the dialog.
test('the language list leaves Escape to a dialog above it', () => {
  const { view, container } = openLanguageList();
  let dialogClosed = 0;
  view.rerender(
    layoutTree(
      createElement(Modal, {
        open: true,
        onClose: () => (dialogClosed += 1),
        title: 'A dialog',
        children: 'Some text',
      }),
    ),
  );
  const dialog = rtl.screen.getByRole('dialog');
  assert.ok(container.querySelector('.language-menu-list'), 'the list closed when the dialog opened');

  rtl.fireEvent.keyDown(dialog, { key: 'Escape' });
  assert.equal(dialogClosed, 1, 'the dialog did not get its Escape');
  assert.ok(container.querySelector('.language-menu-list'), 'the same Escape closed the list under the dialog');

  view.rerender(layoutTree());
  rtl.fireEvent.keyDown(document.body, { key: 'Escape' });
  assert.ok(
    container.querySelector('.language-menu-list') === null,
    'Escape left the list open once the dialog closed',
  );
});
