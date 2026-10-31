// The sidebar theme button cycles light, dark and "follow the system". The choice is stored, so a button
// that only flipped light and dark lost "System" for good after the first click.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
// Every URL the layout asked for.
const requested: string[] = [];
// What the update check answers, when a test sets it; otherwise it answers 404 like every other route.
let updateCheck: object | null = null;

// The window's width in CSS px. A media query sees it as it is; innerWidth is rounded to a whole pixel.
let cssWidth = 1024;
const changeListeners = new Set<{ query: string; last: boolean; listener: () => void }>();
const answers = (query: string): boolean => {
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  return max !== null && cssWidth <= Number(max[1]);
};
/** Resizes the window as a browser does: innerWidth and resize, and a change on every query whose answer flipped. */
function resizeTo(width: number): void {
  rtl.act(() => {
    cssWidth = width;
    window.innerWidth = Math.round(width);
    window.dispatchEvent(new window.Event('resize'));
    for (const entry of changeListeners) {
      const now = answers(entry.query);
      if (now === entry.last) continue;
      entry.last = now;
      entry.listener();
    }
  });
}

/** The layout for a key of `userRole` (admin by default), restricted to selected sessions when `scoped` is set. */
function renderLayout(
  scoped = false,
  userRole: 'admin' | 'operator' | 'viewer' = 'admin',
): ReturnType<typeof import('@testing-library/react').render> {
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'whatsapp-web.js',
    setEngineType: () => undefined,
    scoped,
    setScoped: () => undefined,
  };
  return rtl.render(
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(MemoryRouter, null, createElement(Layout, { onLogout: () => undefined, userRole })),
    ),
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  // jsdom has no matchMedia; the theme hook reads it for the system preference, and the layout for the phone width.
  window.matchMedia = ((query: string) => ({
    get matches() {
      return answers(query);
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) =>
      changeListeners.add({ query, last: answers(query), listener }),
    removeEventListener: (_type: string, listener: () => void) => {
      for (const entry of changeListeners) if (entry.listener === listener) changeListeners.delete(entry);
    },
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requested.push(String(input));
    if (updateCheck && String(input).includes('/infra/update-check')) {
      return Promise.resolve(new Response(JSON.stringify(updateCheck), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ message: 'unstubbed' }), { status: 404 }));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ Layout } = await import('./Layout.tsx'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  requested.length = 0;
  updateCheck = null;
});

after(() => rtl.cleanup());

test('the theme button can return to following the system', () => {
  localStorage.removeItem('openwa_theme');
  const { container } = renderLayout();
  const button = container.querySelector<HTMLButtonElement>('.appearance-menu .theme-toggle-btn')!;
  const seen = [button.textContent];
  for (let i = 0; i < 3; i++) {
    const shown = button.textContent;
    const announced = button.getAttribute('aria-label');
    rtl.fireEvent.click(button);
    seen.push(button.textContent);
    // The name starts with the mode shown, then names the mode the click selects.
    assert.equal(announced, `${shown}, Switch to ${button.textContent}`);
  }
  assert.deepEqual(seen, ['System', 'Light', 'Dark', 'System']);
  assert.equal(localStorage.getItem('openwa_theme'), 'system');
});

// Collapsing is a desktop preference: the phone drawer has no collapse control, so a flag left over from a wider
// window must not strip its labels, and the window widening again must find the preference where it was left.
test('a collapsed sidebar shows its labels in the phone drawer and collapses again on desktop', () => {
  try {
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    rtl.fireEvent.click(container.querySelector('.collapse-toggle')!);
    assert.ok(sidebar.classList.contains('collapsed'));
    assert.equal(container.querySelectorAll('.nav-item span').length, 0, 'the collapsed desktop sidebar shows labels');

    resizeTo(500);
    assert.ok(sidebar.classList.contains('mobile'));
    assert.ok(!sidebar.classList.contains('collapsed'), 'the phone drawer kept the collapsed class');
    const labels = Array.from(container.querySelectorAll('.nav-item')).map(item => item.textContent);
    assert.ok(labels.length > 0 && labels.every(label => label), `the drawer entries read ${JSON.stringify(labels)}`);
    assert.ok(container.querySelector('.sidebar-brand'), 'the drawer has no brand');
    assert.equal(container.querySelector('.logout-btn')!.textContent, 'Logout');
    assert.ok(!container.querySelector('main')!.classList.contains('expanded'));

    // A drawer left open closes when the window widens, so narrowing it again does not bring back the overlay.
    rtl.fireEvent.click(container.querySelector('.mobile-menu-btn')!);
    assert.ok(sidebar.classList.contains('open'));
    resizeTo(1024);
    assert.ok(sidebar.classList.contains('collapsed'), 'the desktop preference was lost');
    assert.ok(!sidebar.classList.contains('open'), 'the drawer stayed open on desktop');
  } finally {
    resizeTo(1024);
  }
});

// The phone drawer is opened and closed with the header menu button. The button said "Expand" in both states and did
// not expose whether the drawer was open, and Escape (the one way a keyboard or switch user dismisses an overlay) did
// nothing.
test('the phone menu button names its state and Escape closes the drawer and returns focus to it', () => {
  try {
    resizeTo(390);
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    const button = container.querySelector<HTMLButtonElement>('.mobile-menu-btn')!;
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'Expand');

    rtl.fireEvent.click(button);
    assert.ok(sidebar.classList.contains('open'));
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Close');
    assert.ok(rtl.screen.getByRole('button', { name: 'Close' }) === button);

    rtl.fireEvent.click(button);
    assert.ok(!sidebar.classList.contains('open'));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'Expand');

    // Escape from inside the drawer: it closes, and focus lands on the button rather than on a link now off screen.
    rtl.fireEvent.click(button);
    rtl.screen.getByRole('link', { name: 'Sessions' }).focus();
    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(!sidebar.classList.contains('open'), 'Escape left the drawer open');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.ok(document.activeElement === button, `focus is on ${document.activeElement?.className}`);

    // Closed, Escape is not listened for: it must not pull focus to the button.
    rtl.screen.getByRole('link', { name: 'Sessions' }).focus();
    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(document.activeElement !== button, 'Escape moved focus while the drawer was closed');
  } finally {
    resizeTo(1024);
  }
});

// Closed, the phone drawer is only moved off screen: its links stayed in the tab order, so a keyboard user stepped
// through a dozen invisible stops after the menu button. Inert takes them out until the drawer opens.
test('the closed phone drawer is inert, the open one and the desktop sidebar are not', () => {
  try {
    resizeTo(390);
    const phone = renderLayout();
    const drawer = phone.container.querySelector('aside.sidebar')!;
    assert.ok(drawer.hasAttribute('inert'), 'the closed drawer is still focusable');
    rtl.fireEvent.click(phone.container.querySelector('.mobile-menu-btn')!);
    assert.ok(!drawer.hasAttribute('inert'), 'the open drawer is inert');
    rtl.fireEvent.click(phone.container.querySelector('.mobile-menu-btn')!);
    assert.ok(drawer.hasAttribute('inert'), 'the drawer is focusable again after closing');
    phone.unmount();

    resizeTo(1024);
    const desktop = renderLayout();
    assert.ok(!desktop.container.querySelector('aside.sidebar')!.hasAttribute('inert'), 'the desktop sidebar is inert');
  } finally {
    resizeTo(1024);
  }
});

// Between 767 and 767.5 CSS px (110% zoom of an 844px window, 125% of a 959px one) innerWidth reads 767 while the
// phone styles' (max-width: 767px) does not match. The page draws the desktop sidebar there, and a width test in
// script made it inert: no link, language, theme or logout button could be clicked or reached with Tab.
test('the sidebar follows the phone media query, not the rounded window width', () => {
  try {
    resizeTo(767.27);
    const { container } = renderLayout();
    assert.equal(window.innerWidth, 767);
    const sidebar = container.querySelector('aside.sidebar')!;
    assert.ok(!sidebar.hasAttribute('inert'), 'the desktop sidebar is inert');
    assert.ok(!sidebar.classList.contains('mobile'), 'the desktop sidebar has the phone class');
    assert.ok(container.querySelector('.mobile-header') === null, 'a phone header beside the desktop sidebar');

    resizeTo(766.8);
    assert.equal(window.innerWidth, 767);
    assert.ok(sidebar.classList.contains('mobile'), 'the phone width kept the desktop sidebar');
    assert.ok(sidebar.hasAttribute('inert'), 'the closed phone drawer is focusable');
    assert.ok(container.querySelector('.mobile-header'), 'no phone header at the phone width');
  } finally {
    resizeTo(1024);
  }
});

// The language menu lives in the drawer footer; Escape dismisses the innermost overlay first.
test('Escape closes the open language menu before the phone drawer', () => {
  try {
    resizeTo(390);
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    rtl.fireEvent.click(container.querySelector('.mobile-menu-btn')!);
    rtl.fireEvent.click(container.querySelector('.language-menu .theme-toggle-btn')!);
    assert.ok(container.querySelector('.language-menu-list'));

    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(container.querySelector('.language-menu-list') === null, 'Escape left the language menu open');
    assert.ok(sidebar.classList.contains('open'), 'the same Escape also closed the drawer');

    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(!sidebar.classList.contains('open'), 'a second Escape left the drawer open');
  } finally {
    resizeTo(1024);
  }
});

// The drawer covers the page, so its Escape is the drawer's alone. The Chats page closes the open chat on an Escape
// nobody prevented, and the emoji picker under the drawer takes the key in the capture phase: one press closed the
// drawer and the chat behind it, or the picker nobody could see while the drawer stayed open.
test('one Escape closes the phone drawer and nothing on the page under it', () => {
  const seen: string[] = [];
  // Registered before the drawer opens, as a picker or menu left open on the page is.
  const pageCapture = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    seen.push('page capture');
  };
  const pageBubble = (event: KeyboardEvent) => {
    if (event.key === 'Escape') seen.push('page bubble');
  };
  document.addEventListener('keydown', pageCapture, true);
  document.addEventListener('keydown', pageBubble);
  try {
    resizeTo(390);
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    rtl.fireEvent.click(container.querySelector('.mobile-menu-btn')!);
    const link = rtl.screen.getByRole('link', { name: 'Sessions' });
    link.focus();

    const notPrevented = rtl.fireEvent.keyDown(link, { key: 'Escape' });
    assert.ok(!sidebar.classList.contains('open'), 'Escape left the drawer open');
    assert.equal(notPrevented, false, 'the drawer took Escape without preventing its default');
    assert.deepEqual(seen, [], 'the page under the drawer handled the same Escape');

    // Closed, the drawer leaves Escape to the page.
    rtl.fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.deepEqual(seen, ['page capture', 'page bubble']);
  } finally {
    document.removeEventListener('keydown', pageCapture, true);
    document.removeEventListener('keydown', pageBubble);
    resizeTo(1024);
  }
});

// A dialog renders above the drawer and dismisses itself on Escape; an Escape that commits an IME composition
// belongs to the composition.
test('the phone drawer leaves Escape to a dialog above it and to a composition', () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  try {
    resizeTo(390);
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    rtl.fireEvent.click(container.querySelector('.mobile-menu-btn')!);

    rtl.fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    assert.ok(sidebar.classList.contains('open'), 'the Escape of a composition closed the drawer');
    rtl.fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 229 });
    assert.ok(sidebar.classList.contains('open'), 'an Escape the input method processed closed the drawer');

    document.body.appendChild(dialog);
    assert.equal(rtl.fireEvent.keyDown(document.body, { key: 'Escape' }), true, 'the drawer took the Escape');
    assert.ok(sidebar.classList.contains('open'), 'Escape closed the drawer under a dialog');

    dialog.remove();
    rtl.fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.ok(!sidebar.classList.contains('open'), 'Escape left the drawer open once the dialog closed');
  } finally {
    dialog.remove();
    resizeTo(1024);
  }
});

// The key management, infrastructure and plugin routes refuse a key restricted to selected sessions, whatever
// its role, and every refusal lands in the audit log as a failed attempt.
test('an admin key scoped to sessions is not offered the pages that refuse it', async () => {
  renderLayout(true);
  const { screen } = rtl;
  assert.equal(screen.queryByRole('link', { name: 'API Keys' }) === null, true);
  assert.equal(screen.queryByRole('link', { name: 'Infrastructure' }) === null, true);
  assert.equal(screen.queryByRole('link', { name: 'Plugins' }) === null, true);
  // The audit read is filtered to the key's sessions, not refused.
  assert.ok(screen.getByRole('link', { name: 'Logs' }));
  await rtl.waitFor(() => assert.ok(requested.some(url => url.includes('/health'))));
  assert.equal(
    requested.some(url => url.includes('/infra/update-check')),
    false,
  );
});

test('an unscoped admin key still checks for a newer release', async () => {
  renderLayout();
  assert.ok(rtl.screen.getByRole('link', { name: 'Plugins' }));
  await rtl.waitFor(() => assert.ok(requested.some(url => url.includes('/infra/update-check'))));
});

// Beside the collapse button a long notice is cut with an ellipsis (Layout.css), so a pointer gets the whole text too.
test('the update notice keeps its whole text in its title as well as its name', async () => {
  updateCheck = { current: '0.26.0', latest: '0.27.0', updateAvailable: true, releaseUrl: 'https://example.test/r' };
  renderLayout();
  const link = await rtl.screen.findByRole('link', { name: 'v0.27.0 available' });
  assert.equal(link.getAttribute('title'), 'v0.27.0 available');
});

// The sidebar offers the Number Checker to every role; a viewer key gets the page with its Check buttons disabled.
for (const userRole of ['admin', 'operator', 'viewer'] as const) {
  test(`the Number Checker is offered to ${userRole} keys`, () => {
    renderLayout(false, userRole);
    assert.equal(rtl.screen.getByRole('link', { name: 'Number Checker' }).getAttribute('href'), '/number-checker');
  });
}
