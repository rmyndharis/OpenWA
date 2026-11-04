import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let MessageTester: typeof import('./MessageTester.tsx').MessageTester;
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
let client: QueryClient | undefined;
const forwards: unknown[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/sessions')) {
      return Promise.resolve(json([{ id: 's1', name: 'Main', status: 'ready', phone: '15550000000' }]));
    }
    if (url.endsWith('/messages/forward') || url.endsWith('/messages/send-text')) {
      forwards.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json({ messageId: '', timestamp: 1_700_000_000 }, 201));
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ MessageTester } = await import('./MessageTester.tsx'));
});

test('an accepted text send with an empty message id is reported as sent', async () => {
  const { screen, fireEvent } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(QueryClientProvider, { client }, createElement(RoleProvider, null, createElement(MessageTester))),
  );
  await screen.findByRole('option', { name: /Main/ });
  fireEvent.change(screen.getByPlaceholderText('+62812345678'), { target: { value: '15551112222@c.us' } });
  fireEvent.change(screen.getByPlaceholderText('Enter your message here...'), { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send Message' }));

  await screen.findByText('Timestamp');
  assert.equal(forwards.length, 1);
  assert.ok(screen.queryByText('Success'));
  assert.equal(screen.queryByText('Failed'), null);
});

afterEach(async () => {
  rtl.cleanup();
  await client?.cancelQueries();
  client?.clear();
  client = undefined;
  forwards.length = 0;
  window.sessionStorage.removeItem('openwa_user_role');
});

test('a forward the gateway accepted without the copy id is reported as sent, not failed', async () => {
  const { screen, fireEvent } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(QueryClientProvider, { client }, createElement(RoleProvider, null, createElement(MessageTester))),
  );
  await screen.findByRole('option', { name: /Main/ });
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
  const set = (selector: string, value: string) =>
    fireEvent.change(container.querySelector(selector) as HTMLInputElement, { target: { value } });
  set('#mt-17', '15551112222@c.us');
  set('#mt-9', '15553334444@c.us');
  set('#mt-10', 'true_15551112222@c.us_3EB0AAAA');

  const send = screen.getByRole('button', { name: 'Send Message' }) as HTMLButtonElement;
  assert.equal(send.disabled, false);
  fireEvent.click(send);

  await screen.findByText('Timestamp');
  assert.equal(forwards.length, 1, 'the forward reached the gateway once');
  assert.equal(screen.queryByText('Failed') === null, true, 'a 201 forward must not be reported as failed');
  assert.equal(screen.queryByText('Success') !== null, true, 'the accepted forward is reported as sent');
});
