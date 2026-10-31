import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// No phone number has more than 15 digits (E.164). A pasted line holding two numbers separated by a space folds into
// one longer run of digits; it is refused with a reason, never looked up as a number nobody typed. The bound applies
// to the number as checked, so a 00 exit code in front of a full-length number still passes.

let rtl: typeof import('@testing-library/react');
let NumberChecker: typeof import('./NumberChecker.tsx').NumberChecker;
let ToastProvider: typeof import('../components/Toast.tsx').ToastProvider;
let NumberCheckProvider: typeof import('../components/NumberCheckProvider.tsx').NumberCheckProvider;
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
let queryClient: QueryClient | undefined;
const lookups: string[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      const number = decodeURIComponent(url.split('/contacts/check/')[1]);
      lookups.push(number);
      return Promise.resolve(jsonResponse({ number, exists: false, whatsappId: null }));
    }
    if (url.endsWith('/api/sessions')) {
      return Promise.resolve(
        jsonResponse([{ id: 'sess-1', name: 'Primary Session', status: 'ready', phone: '6281200000000' }]),
      );
    }
    return Promise.resolve(jsonResponse({ message: 'unstubbed' }, 404));
  }) as typeof fetch;
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ NumberCheckProvider } = await import('../components/NumberCheckProvider.tsx'));
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ NumberChecker } = await import('./NumberChecker.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  lookups.length = 0;
  sessionStorage.clear();
});

function renderPage(): void {
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
}

const TWO_NUMBERS = '6281234567890 6289876543210';
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

async function singleField(): Promise<HTMLInputElement> {
  renderPage();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  return rtl.screen.getByPlaceholderText(/919876543210 or 6281234567890/i) as HTMLInputElement;
}

async function checkSingle(value: string): Promise<HTMLButtonElement> {
  const input = await singleField();
  rtl.fireEvent.change(input, { target: { value } });
  const check = rtl.screen.getByRole('button', { name: /^Check/i }) as HTMLButtonElement;
  if (!check.disabled) rtl.fireEvent.click(check);
  await settle();
  return check;
}

test('a bulk line holding two space-separated numbers is refused with a reason, and the other lines still run', async () => {
  renderPage();
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const textarea = rtl.screen.getByPlaceholderText(/9612345678/i) as HTMLTextAreaElement;
  rtl.fireEvent.change(textarea, { target: { value: `${TWO_NUMBERS}\n628111222333` } });
  assert.ok(
    rtl.screen.getByText('Left out, more than 15 digits (not one number): 1. Put each number on its own line.'),
  );
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('Completed checking 1 number.', {}, { timeout: 3000 });
  assert.deepEqual(lookups, ['628111222333']);
});

test('the single check refuses two space-separated numbers with a reason and looks nothing up', async () => {
  const input = await singleField();
  rtl.fireEvent.change(input, { target: { value: TWO_NUMBERS } });
  const reason = 'More than 15 digits is not one phone number. Check one number at a time.';
  assert.ok(rtl.screen.getByText(reason));
  assert.equal((rtl.screen.getByRole('button', { name: /^Check/i }) as HTMLButtonElement).disabled, true);
  // Enter bypasses the disabled button and gets the same answer.
  rtl.fireEvent.keyDown(input, { key: 'Enter' });
  await settle();
  assert.equal(rtl.screen.getAllByText(reason).length, 2, 'Enter gave no reason');
  assert.deepEqual(lookups, []);
});

test('a sixteen-digit single number is refused', async () => {
  const check = await checkSingle('1234567890123456');
  assert.equal(check.disabled, true);
  assert.deepEqual(lookups, []);
});

test('a fifteen-digit single number is still looked up', async () => {
  await checkSingle('123456789012345');
  assert.deepEqual(lookups, ['123456789012345']);
});

test('a 00 exit code in front of a fifteen-digit number is still looked up as that number', async () => {
  await checkSingle('00123456789012345');
  assert.deepEqual(lookups, ['123456789012345']);
});
