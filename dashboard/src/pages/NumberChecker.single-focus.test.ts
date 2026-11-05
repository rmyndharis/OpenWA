// A single check is typed and sent with Enter in the phone field, and the next number is typed into the same field.
// Focus has to be in that field again once the answer is shown, not on the page body.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let rtl: typeof import('@testing-library/react');
let NumberChecker: (typeof import('./NumberChecker.tsx'))['NumberChecker'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let NumberCheckProvider: (typeof import('../components/NumberCheckProvider.tsx'))['NumberCheckProvider'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let queryClient: QueryClient | undefined;
let releaseLookup: () => void = () => {};
let checks = 0;
let refuseLookup = false;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : matches.call(this, selector);
  } as typeof matches;
  // HTML focus fixup rule, as browsers apply it: disabling the focused control drops focus to the document body.
  // jsdom does not run focus fixup when disabled is set (the same emulation as Infrastructure.import-keyboard.test.ts).
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (name.toLowerCase() === 'disabled' && document.activeElement === this) (this as HTMLElement).blur();
    setAttr.call(this, name, value);
  };
  for (const Ctor of [HTMLInputElement, HTMLButtonElement]) {
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'disabled')!;
    Object.defineProperty(Ctor.prototype, 'disabled', {
      ...desc,
      set(this: HTMLElement, value: boolean) {
        if (value && document.activeElement === this) this.blur();
        desc.set!.call(this, value);
      },
    });
  }
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') {
      return Promise.resolve(
        jsonResponse([{ id: 's-main', name: 'main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }]),
      );
    }
    if (path.startsWith('/api/sessions/s-main/contacts/check/')) {
      checks++;
      return new Promise(resolve => {
        releaseLookup = () =>
          resolve(
            refuseLookup
              ? jsonResponse({ message: 'Lookup refused' }, 400)
              : jsonResponse({ number: '15550001111', exists: false, whatsappId: null }),
          );
      });
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ NumberCheckProvider } = await import('../components/NumberCheckProvider.tsx'));
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ NumberChecker } = await import('./NumberChecker.tsx'));
});

afterEach(async () => {
  await rtl.act(async () => releaseLookup());
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  sessionStorage.removeItem('openwa_user_role');
  checks = 0;
  refuseLookup = false;
  releaseLookup = () => {};
});

async function renderPage() {
  sessionStorage.setItem('openwa_user_role', 'operator');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
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
  await rtl.screen.findByRole('option', { name: /main/ });
  const phone = rtl.screen.getByLabelText('Phone Number') as HTMLInputElement;
  phone.focus();
  rtl.fireEvent.change(phone, { target: { value: '15550001111' } });
  return phone;
}

function focused(): string {
  const active = document.activeElement;
  return active === document.body ? 'body' : active?.id || active?.textContent?.trim() || 'none';
}

test('a single check sent with Enter keeps its read-only phone field focused', async () => {
  const phone = await renderPage();
  rtl.fireEvent.keyDown(phone, { key: 'Enter' });
  assert.equal(phone.disabled, false);
  assert.equal(phone.readOnly, true);
  assert.equal(focused(), 'nc-single-phone');
  await rtl.act(async () => releaseLookup());
  await rtl.screen.findByText('Not Registered');
  assert.equal(phone.readOnly, false);
  assert.equal(focused(), 'nc-single-phone');
});

test('a single check started from Check returns focus to the phone field', async () => {
  await renderPage();
  const check = rtl.screen.getByRole('button', { name: 'Check' });
  check.focus();
  rtl.fireEvent.click(check);
  assert.equal((check as HTMLButtonElement).disabled, true);
  await rtl.act(async () => releaseLookup());
  await rtl.screen.findByText('Not Registered');
  assert.equal(focused(), 'nc-single-phone');
});

test('a refused check started from Check returns focus to the phone field', async () => {
  refuseLookup = true;
  await renderPage();
  const check = rtl.screen.getByRole('button', { name: 'Check' });
  check.focus();
  rtl.fireEvent.click(check);
  await rtl.act(async () => releaseLookup());
  await rtl.screen.findByText('Lookup refused');
  assert.equal(focused(), 'nc-single-phone');
});

test('repeated Enter while a lookup runs sends one check and keeps its field focused', async () => {
  const phone = await renderPage();
  rtl.fireEvent.keyDown(phone, { key: 'Enter' });
  rtl.fireEvent.keyDown(phone, { key: 'Enter' });
  assert.equal(checks, 1);
  await rtl.act(async () => releaseLookup());
  assert.equal(focused(), 'nc-single-phone');
});

test('a completed lookup preserves focus moved to another control', async () => {
  const phone = await renderPage();
  rtl.fireEvent.keyDown(phone, { key: 'Enter' });
  rtl.screen.getByLabelText('WhatsApp Session').focus();
  await rtl.act(async () => releaseLookup());
  assert.equal(focused(), 'nc-single-session');
});

test('Enter used to finish an IME composition sends no check', async () => {
  const phone = await renderPage();
  rtl.fireEvent.keyDown(phone, { key: 'Enter', isComposing: true });
  assert.equal(checks, 0);
  assert.equal(focused(), 'nc-single-phone');
});
