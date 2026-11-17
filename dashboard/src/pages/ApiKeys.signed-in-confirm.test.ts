// The edit dialog of the key the dashboard is signed in with warns that a change can sign the operator out. Revoking or
// deleting that same key ends the session for certain (the next request answers 401 and the page returns to the sign-in
// form with no reason), so both confirmation dialogs say so, and the dialog of any other key does not.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let rtl: typeof import('@testing-library/react');
let ApiKeys: (typeof import('./ApiKeys.tsx'))['ApiKeys'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

const signedInKey = {
  id: 'key-1',
  name: 'billing-bot',
  keyPrefix: 'owa_k1ab',
  role: 'admin',
  isActive: true,
  usageCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const otherKey = { ...signedInKey, id: 'key-2', name: 'support-bot', keyPrefix: 'owa_k2cd' };

const SIGNED_IN_NOTE = 'This dashboard is signed in with this key. Revoking or deleting it signs you out.';

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = path === '/api/auth/api-keys' ? [signedInKey, otherKey] : path === '/api/sessions' ? [] : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ ApiKeys } = await import('./ApiKeys.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  window.sessionStorage.removeItem('openwa_api_key');
});

/** The confirmation dialog `action` opens on the row of the key called `name`, the dashboard signed in with billing-bot. */
async function openConfirm(action: 'Revoke' | 'Delete', name: string): Promise<HTMLElement> {
  window.sessionStorage.setItem('openwa_api_key', 'owa_k1abXXXXYYYYZZZZ');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(ApiKeys)),
    ),
  );
  await rtl.screen.findByText(name);
  const row = rtl.screen.getByText(name).closest('tr') as HTMLElement;
  rtl.fireEvent.click(rtl.within(row).getByTitle(action));
  return rtl.screen.findByRole('dialog');
}

for (const action of ['Revoke', 'Delete'] as const) {
  test(`${action} on the key the dashboard is signed in with says it ends this session`, async () => {
    const dialog = await openConfirm(action, signedInKey.name);
    assert.equal(rtl.within(dialog).getByRole('note').textContent, SIGNED_IN_NOTE);
    // The regular message and the key's name are still there.
    assert.equal(rtl.within(dialog).getByText(signedInKey.name).tagName, 'STRONG');
    assert.match(dialog.textContent ?? '', action === 'Revoke' ? /It will no longer work/ : /cannot be undone/);
  });

  test(`${action} on another key carries no sign-out note`, async () => {
    const dialog = await openConfirm(action, otherKey.name);
    assert.ok(rtl.within(dialog).queryByRole('note') === null, 'the dialog of another key carries a note');
    assert.equal(rtl.within(dialog).getByText(otherKey.name).tagName, 'STRONG');
  });
}
