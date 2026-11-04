// The severity filter is a button that shows the option picked. A screen reader user tabbing to it hears only that
// option ("Warning, collapsed"), with nothing saying it filters the table by severity, so its name has to say what it
// sets, not only what it is set to.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let rtl: typeof import('@testing-library/react');
let Logs: (typeof import('./Logs.tsx'))['Logs'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } }),
    )) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Logs } = await import('./Logs.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

test('the severity filter is named for what it filters, whichever severity it shows', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Logs)),
    ),
  );
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching(), 0));
  const trigger = document.querySelector<HTMLButtonElement>('.custom-select-trigger')!;
  const nameOf = () => trigger.getAttribute('aria-label') ?? trigger.textContent ?? '';
  assert.equal(nameOf(), 'Severity, All Severities');
  rtl.fireEvent.click(trigger);
  // The list of choices is named for what it sets alone.
  assert.equal(rtl.screen.getByRole('listbox').getAttribute('aria-label'), 'Severity');
  rtl.fireEvent.click(rtl.screen.getByRole('option', { name: 'Warning' }));
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching(), 0));
  // The name keeps the shown value too, the words a voice user says to press it.
  assert.equal(nameOf(), 'Severity, Warning', `the filter is announced as "${nameOf()}"`);
});
