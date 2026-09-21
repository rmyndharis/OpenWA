import '../test-helpers/register-hooks.ts';
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let ThemeLogo: (typeof import('./ThemeLogo.tsx'))['ThemeLogo'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ ThemeLogo } = await import('./ThemeLogo.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

test('renders only the asset selected for the resolved theme', async () => {
  localStorage.setItem('openwa_theme', 'dark');
  const { container, findByRole } = rtl.render(createElement(ThemeLogo, { alt: 'Marca OpenWA' }));

  const image = await findByRole('img', { name: 'Marca OpenWA' });
  assert.equal(container.querySelectorAll('img').length, 1);
  assert.match((image as HTMLImageElement).src, /openwa_logo\.webp/);
});
