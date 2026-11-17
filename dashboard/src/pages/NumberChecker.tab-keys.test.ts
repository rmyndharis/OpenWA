// The mode tabs of the Number Checker are a row of role="tab" buttons: one stop in the Tab order, and an arrow key
// selects the other mode and takes focus there.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let NumberChecker: typeof import('./NumberChecker.tsx').NumberChecker;
let ToastProvider: typeof import('../components/Toast.tsx').ToastProvider;
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
let NumberCheckProvider: typeof import('../components/NumberCheckProvider.tsx').NumberCheckProvider;
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
let queryClient: QueryClient | undefined;

const sessions = [{ id: 's1', name: 'Primary Session', status: 'ready', phone: '919876543210' }];

function renderPage() {
  sessionStorage.setItem('openwa_user_role', 'operator');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(NumberCheckProvider, null, createElement(MemoryRouter, null, createElement(NumberChecker))),
        ),
      ),
    ),
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(sessions), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ NumberCheckProvider } = await import('../components/NumberCheckProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ NumberChecker } = await import('./NumberChecker.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  sessionStorage.clear();
  queryClient?.clear();
  queryClient = undefined;
});

const tabNames = () => rtl.screen.getAllByRole('tab').map(tab => tab.textContent?.trim());

test('an arrow key moves focus from the selected mode tab to the next one and selects it', async () => {
  renderPage();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const tabs = rtl.screen.getAllByRole('tab');
  assert.deepEqual(tabNames(), ['Single Check', 'Bulk Number Checker']);
  tabs[0].focus();
  rtl.fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
  await rtl.waitFor(() =>
    assert.equal(
      document.activeElement?.textContent?.trim(),
      'Bulk Number Checker',
      'ArrowRight did not reach the tab',
    ),
  );
  assert.deepEqual(
    tabs.map(tab => tab.getAttribute('aria-selected')),
    ['false', 'true'],
  );

  rtl.fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' });
  await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Single Check'));
  assert.deepEqual(
    tabs.map(tab => tab.getAttribute('aria-selected')),
    ['true', 'false'],
  );
});

test('only the selected mode tab is a Tab stop', async () => {
  renderPage();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const stops = () =>
    rtl.screen
      .getAllByRole('tab')
      .filter(tab => tab.getAttribute('tabindex') !== '-1')
      .map(tab => tab.textContent?.trim());
  assert.deepEqual(stops(), ['Single Check']);
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/ }));
  assert.deepEqual(stops(), ['Bulk Number Checker']);
});
