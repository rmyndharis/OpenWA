// The sidebar theme button cycles light, dark and "follow the system". The choice is stored, so a button
// that only flipped light and dark lost "System" for good after the first click.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  // jsdom has no matchMedia; the theme hook reads it for the system preference.
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
});

after(() => rtl.cleanup());

test('the theme button can return to following the system', () => {
  localStorage.removeItem('openwa_theme');
  const { container } = rtl.render(
    createElement(MemoryRouter, null, createElement(Layout, { onLogout: () => undefined, userRole: 'admin' })),
  );
  const button = container.querySelector<HTMLButtonElement>('.appearance-menu .theme-toggle-btn')!;
  const seen = [button.textContent];
  for (let i = 0; i < 3; i++) {
    const announced = button.getAttribute('aria-label');
    rtl.fireEvent.click(button);
    seen.push(button.textContent);
    // The label names the state the click selects.
    assert.equal(announced, `Switch to ${button.textContent}`);
  }
  // XenWA starts dark (the XenAI look); the cycle still reaches System.
  assert.deepEqual(seen, ['Dark', 'System', 'Light', 'Dark']);
  assert.equal(localStorage.getItem('openwa_theme'), 'dark');
});
