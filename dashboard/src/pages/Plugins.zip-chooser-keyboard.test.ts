// The Upload tab of the install dialog takes a plugin .zip from a file chooser. A keyboard user reaches a
// control by Tab and opens it with Enter or Space, so the file input has to stay in the tab order: hidden
// from sight under the drop zone, not removed, and named by the drop zone's text.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') return Promise.resolve(jsonResponse([]));
    if (method === 'GET' && path === '/api/plugins/catalog') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

/** In the sequential focus order: not disabled, no negative tabindex, and not inside a `hidden` subtree. */
function inTabOrder(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.tabIndex < 0) return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none') return false;
  }
  return true;
}

/** The text of the label of the focused field, or what has focus instead. */
function focusedLabel(): string {
  const active = document.activeElement as HTMLInputElement | null;
  if (!active || active === document.body) return 'body';
  return active.labels?.[0]?.textContent?.trim() || `${active.tagName.toLowerCase()} without a label`;
}

/** Renders the page and opens the install dialog on its Upload tab. */
async function openUploadTab(): Promise<{ dialog: HTMLElement; chooser: HTMLInputElement }> {
  const { screen, fireEvent, waitFor } = rtl;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Install plugin' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => assert.ok(dialog.querySelector('input[type="file"]')));
  return { dialog, chooser: dialog.querySelector<HTMLInputElement>('input[type="file"]')! };
}

test('the plugin .zip chooser can be opened from the keyboard', async () => {
  const { chooser } = await openUploadTab();
  assert.ok(inTabOrder(chooser), 'the .zip chooser is out of the tab order and its label takes no focus');
  // Named by the drop zone's text, so a screen reader says what Space or Enter opens.
  rtl.screen.getByLabelText('Choose a .zip file…').focus();
  assert.equal(focusedLabel(), 'Choose a .zip file…');
});
