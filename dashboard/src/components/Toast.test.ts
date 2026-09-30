// An unreachable backend fails every in-flight call at once, so the provider collapses those errors
// into one "connection lost" toast. Each browser words a failed fetch differently, and an error that
// merely resembles one must keep its own toast.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { ToastContextValue } from '../hooks/useToast.ts';

let rtl: typeof import('@testing-library/react');
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];
let useToast: (typeof import('../hooks/useToast.ts'))['useToast'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('./Toast.tsx'));
  ({ useToast } = await import('../hooks/useToast.ts'));
});

afterEach(() => rtl.cleanup());

/** Raise each [title, message] as an error toast and return the titles on screen. */
function raise(errors: [string, string?][]): string[] {
  let toast!: ToastContextValue;
  function Probe() {
    toast = useToast();
    return null;
  }
  const { container } = rtl.render(createElement(ToastProvider, null, createElement(Probe)));
  rtl.act(() => {
    for (const [title, message] of errors) toast.error(title, message);
  });
  return Array.from(container.querySelectorAll('.toast-title'), el => el.textContent ?? '');
}

const CONNECTION_LOST = 'Server Connection Lost';

test("WebKit's 'Load failed' collapses into one connection-lost toast", () => {
  assert.deepEqual(
    raise([
      ['Could not load chats', 'Load failed'],
      ['Could not load sessions', 'Load failed'],
    ]),
    [CONNECTION_LOST],
  );
  rtl.cleanup();
  assert.deepEqual(raise([['Load failed'], ['Load failed']]), [CONNECTION_LOST]);
});

test('a proxy 502 or 503 collapses into one connection-lost toast, a 504 keeps its own', () => {
  // A 504 is a proxy that stopped waiting on a reachable backend: the request may still be running.
  assert.deepEqual(
    raise([
      ['Import failed', 'HTTP 504'],
      ['Refresh failed', 'HTTP 504'],
    ]),
    ['Import failed', 'Refresh failed'],
  );
  rtl.cleanup();
  assert.deepEqual(
    raise([
      ['A', 'HTTP 502'],
      ['B', 'HTTP 503'],
    ]),
    [CONNECTION_LOST],
  );
});

test('an error that only mentions a failed load or a gateway status keeps its own toast', () => {
  const download = 'Failed to download plugin from URL: download failed with status 404';
  const upstream = 'Upstream answered HTTP 502 for the media URL';
  assert.deepEqual(
    raise([
      ['Install failed', download],
      ['Send failed', upstream],
    ]),
    ['Install failed', 'Send failed'],
  );
});
