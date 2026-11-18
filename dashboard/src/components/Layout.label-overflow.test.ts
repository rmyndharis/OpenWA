// The browser's text size grows the labels but not the 260px sidebar: from 125% (Spanish, French, Portuguese, Italian,
// Turkish) and 150% (English) a label such as "Verificador de numeros" or "Number Checker" was cut mid-letter with
// nothing to say so. A label too long for its row now ends in an ellipsis, as the update notice does, and its link or
// button carries the whole text in its title. The text still names the control, so its accessible name is unchanged.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { decl, readRules } from '../test-helpers/css-rules.ts';

const rules = readRules(new URL('./Layout.css', import.meta.url));
const bodyOf = (selector: string): string =>
  rules
    .filter(r => r.media === '' && r.selectors.includes(selector))
    .map(r => r.body)
    .join(';');

test('a sidebar label too long for its row ends in an ellipsis instead of being cut', () => {
  for (const selector of ['.nav-item > span', '.theme-toggle-btn > span', '.logout-btn > span']) {
    const body = bodyOf(selector);
    assert.equal(decl(body, 'min-width'), '0', `${selector} cannot shrink below its text`);
    assert.equal(decl(body, 'overflow'), 'hidden', `${selector} does not clip`);
    assert.equal(decl(body, 'text-overflow'), 'ellipsis', `${selector} does not end in an ellipsis`);
  }
  const brand = bodyOf('.brand-name');
  assert.equal(decl(brand, 'overflow'), 'hidden');
  assert.equal(decl(brand, 'text-overflow'), 'ellipsis');
});

// The name and the version are Latin text. In an Arabic or Hebrew page the line runs right to left, so an ellipsis at its
// end stood in front of the tail ("...nWA") and the head was what got cut. They are cut by their own direction, with a
// box as wide as the text so that what fits stays at the edge the page puts it; a label of a row that is written in
// Latin script (Sessions, Webhooks in Hebrew) is cut the same way.
test('the brand and the row labels are cut by their own direction, not the page', () => {
  for (const selector of ['.brand-name', '.brand-version']) {
    const body = bodyOf(selector);
    assert.equal(decl(body, 'unicode-bidi'), 'plaintext', `${selector} takes the page direction`);
    assert.equal(decl(body, 'overflow'), 'hidden', `${selector} does not clip`);
    assert.equal(decl(body, 'text-overflow'), 'ellipsis', `${selector} does not end in an ellipsis`);
    assert.equal(decl(body, 'width'), 'fit-content', `${selector} is not as wide as its text`);
    assert.equal(decl(body, 'max-width'), '100%', `${selector} can outgrow the brand`);
  }
  for (const selector of ['.nav-item > span', '.theme-toggle-btn > span', '.logout-btn > span']) {
    assert.equal(decl(bodyOf(selector), 'unicode-bidi'), 'plaintext', `${selector} takes the page direction`);
  }
});

// The ellipsis has to begin where the row would have cut the label, not an end padding sooner: a label that the row
// holds whole is not shortened. Nothing follows a label in these rows, so the end padding is taken off, after the rule
// that sets the padding (the collapsed rail has no label and sets its own).
test('a label has the room up to the edge of its row, so one the row holds whole stays whole', () => {
  for (const row of ['.nav-item', '.theme-toggle-btn', '.logout-btn']) {
    const own = rules.filter(r => r.media === '' && r.selectors.includes(row));
    const shorthand = own.findIndex(r => decl(r.body, 'padding') !== undefined);
    const noEnd = own.findIndex(r => decl(r.body, 'padding-inline-end') === '0');
    assert.ok(shorthand >= 0, `${row} no longer sets its padding: drop this check`);
    assert.ok(noEnd > shorthand, `${row} keeps an end padding that its label cannot use`);
  }
});

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ message: 'unstubbed' }), { status: 404 }))) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ Layout } = await import('./Layout.tsx'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
});

afterEach(() => rtl.cleanup());

function renderSidebar(): HTMLElement {
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: false,
    isViewer: false,
    canWrite: true,
    engineType: 'baileys',
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  };
  return rtl.render(
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(MemoryRouter, null, createElement(Layout, { onLogout: () => undefined, userRole: 'admin' })),
    ),
  ).container;
}

// What each control of the sidebar shows or is named: a link and the logout button by their text, the two footer
// buttons by the name they already carry (the language button shows only its code).
const names = (sidebar: HTMLElement): string[] =>
  Array.from(sidebar.querySelectorAll<HTMLElement>('.sidebar-nav .nav-item, .sidebar-footer button')).map(
    control => control.getAttribute('title') ?? '(no title)',
  );

test('an expanded sidebar row carries its whole text in its title', () => {
  const sidebar = renderSidebar();
  const rows = Array.from(sidebar.querySelectorAll<HTMLElement>('.sidebar-nav .nav-item, .sidebar-footer .logout-btn'));
  assert.ok(rows.length >= 8, `expected the navigation and the logout button, found ${rows.length} rows`);
  const untitled = rows.filter(row => row.getAttribute('title') !== row.textContent?.trim());
  assert.deepEqual(
    untitled.map(row => row.textContent?.trim()),
    [],
  );
  // The footer buttons' titles were already their whole names; they stay.
  for (const button of sidebar.querySelectorAll<HTMLElement>('.sidebar-footer .theme-toggle-btn')) {
    assert.equal(button.getAttribute('title'), button.getAttribute('aria-label'));
  }
});

test('a collapsed sidebar keeps the titles its icons depend on', () => {
  const sidebar = renderSidebar();
  const expanded = names(sidebar);
  rtl.fireEvent.click(sidebar.querySelector('.collapse-toggle')!);
  assert.ok(sidebar.querySelector('.sidebar.collapsed'), 'the sidebar did not collapse');
  assert.deepEqual(names(sidebar), expanded);
});
