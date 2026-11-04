// A control named in two parts, the words it shows and then what it does or sets, joins them as its language writes a
// comma: Chinese with the fullwidth comma and Arabic with the Arabic comma. The sidebar buttons also show that name as
// their tooltip.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let i18n: (typeof import('../i18n/index.ts'))['default'];
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let CustomSelect: (typeof import('./CustomSelect.tsx'))['CustomSelect'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];

const SEPARATORS = [
  ['en', ', '],
  ['zh-CN', '，'],
  ['zh-HK', '，'],
  ['ar', '، '],
] as const;

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
  const i18nModule = await import('../i18n/index.ts');
  await i18nModule.i18nReady;
  i18n = i18nModule.default;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ Layout } = await import('./Layout.tsx'));
  ({ CustomSelect } = await import('./CustomSelect.tsx'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
});

afterEach(() => rtl.cleanup());
after(() => i18n.changeLanguage('en'));

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

test("the sidebar theme and language buttons join their name with the language's own comma", async () => {
  const wrong: string[] = [];
  for (const [lang, separator] of SEPARATORS) {
    await i18n.changeLanguage(lang);
    localStorage.removeItem('openwa_theme');
    const footer = renderSidebar().querySelector('.sidebar-footer')!;
    for (const button of footer.querySelectorAll<HTMLButtonElement>('.theme-toggle-btn')) {
      const shown = button.textContent?.trim() ?? '';
      const name = button.getAttribute('aria-label') ?? '';
      if (!name.startsWith(`${shown}${separator}`) || button.getAttribute('title') !== name)
        wrong.push(`${lang}: shows "${shown}", named "${name}", titled "${button.getAttribute('title')}"`);
    }
    rtl.cleanup();
  }
  assert.deepEqual(wrong, []);
});

test("a select's purpose and shown value are joined with the language's own comma", async () => {
  const wrong: string[] = [];
  for (const [lang, separator] of SEPARATORS) {
    await i18n.changeLanguage(lang);
    const { container } = rtl.render(
      createElement(CustomSelect, {
        value: 'all',
        onChange: () => undefined,
        options: [{ value: 'all', label: i18n.t('logs.severity.all') }],
        ariaLabel: i18n.t('logs.columns.severity'),
      }),
    );
    const name = container.querySelector('.custom-select-trigger')?.getAttribute('aria-label');
    const expected = `${i18n.t('logs.columns.severity')}${separator}${i18n.t('logs.severity.all')}`;
    if (name !== expected) wrong.push(`${lang}: named "${name}", expected "${expected}"`);
    rtl.cleanup();
  }
  assert.deepEqual(wrong, []);
});
