// Render test for GlobalSearch under the bare `node --test` runner (jsdom loader hooks, recorded fetch
// stub). Each GET /search is held until the test releases it, so responses can land out of order: a
// slower, earlier query must never replace the results of the one the input now shows.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

const pending = new Map<string, (hits: string[]) => void>();

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const q = url.searchParams.get('q') ?? '';
    return new Promise(resolve => {
      pending.set(q, texts =>
        resolve(
          new Response(
            JSON.stringify({
              hits: texts.map((text, i) => ({
                messageId: `${q}-${i}`,
                sessionId: 'sess-1',
                chatId: 'chat-1@c.us',
                timestamp: 1_767_225_600,
                snippet: text,
              })),
              total: texts.length,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
    });
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let GlobalSearch: (typeof import('./GlobalSearch.tsx'))['GlobalSearch'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ GlobalSearch } = await import('./GlobalSearch.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  pending.clear();
});

async function typeAndWaitForRequest(input: HTMLElement, value: string): Promise<void> {
  rtl.fireEvent.change(input, { target: { value } });
  await rtl.waitFor(() => assert.ok(pending.has(value), `expected a search for "${value}"`));
}

test('a slower earlier query does not overwrite the results of the latest one', async () => {
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = rtl.screen.getByRole('textbox');

  await typeAndWaitForRequest(input, 'inv');
  await typeAndWaitForRequest(input, 'invoice 2026');

  await rtl.act(async () => pending.get('invoice 2026')!(['invoice 2026 paid']));
  await rtl.screen.findByText('invoice 2026 paid');

  // The broader query resolves last.
  await rtl.act(async () => pending.get('inv')!(['inventory count']));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rtl.screen.queryByText('inventory count') === null, true, 'the stale results replaced the latest');
  rtl.screen.getByText('invoice 2026 paid');
});

test('a response for a query the user cleared does not fill the list', async () => {
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = rtl.screen.getByRole('textbox');

  await typeAndWaitForRequest(input, 'refund');
  rtl.fireEvent.change(input, { target: { value: '' } });
  await rtl.act(async () => pending.get('refund')!(['refund issued']));
  // Typing again shows the panel before the next debounce fires: it must not hold the cleared results.
  rtl.fireEvent.change(input, { target: { value: 'r' } });
  rtl.fireEvent.focus(input);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rtl.screen.queryByText('refund issued') === null, true, 'the cleared query filled the list');
});
