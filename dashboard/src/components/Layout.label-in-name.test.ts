// A control's spoken name holds the words it shows (WCAG 2.5.3, Label in Name): a speech-input user says what they
// see ("click System", "click EN"), and a screen reader user hears the same words a sighted colleague reads out.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

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

test('the sidebar theme and language buttons are named with the words they show', () => {
  localStorage.removeItem('openwa_theme');
  const footer = renderSidebar().querySelector('.sidebar-footer')!;
  const named = Array.from(footer.querySelectorAll<HTMLButtonElement>('.theme-toggle-btn')).map(button => ({
    shows: button.textContent?.trim() ?? '',
    name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
  }));
  assert.equal(named.length, 2);
  // The name starts with the words shown and goes on to say what a press does.
  const mismatched = named.filter(({ shows, name }) => !name.startsWith(`${shows}, `));
  assert.deepEqual(
    mismatched.map(({ shows, name }) => `shows "${shows}" but is named "${name}"`),
    [],
  );
  assert.deepEqual(
    named.map(({ name }) => name),
    ['EN, Change language', 'System, Switch to Light'],
  );
});
