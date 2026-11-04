// Focus that leaves the search widget closes its results a moment later. Focus that comes back first, a quick Tab
// out and Shift+Tab in, keeps them open: the close that was scheduled no longer describes where focus is.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

const pending = new Map<string, (hits: string[], total?: number) => void>();
// Answers the held search for a query with an HTTP error instead of hits.
const failing = new Map<string, (status: number) => void>();
const offsets: string[] = [];
const scopes: string[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const q = url.searchParams.get('q') ?? '';
    const offset = url.searchParams.get('offset') ?? '0';
    offsets.push(offset);
    scopes.push(url.searchParams.get('sessionId') ?? '');
    return new Promise(resolve => {
      failing.set(q, status => resolve(new Response(JSON.stringify({ message: 'failed' }), { status })));
      pending.set(q, (texts, total = texts.length) =>
        resolve(
          new Response(
            JSON.stringify({
              // A hit's id follows its text, so a page that repeats a text repeats the message.
              hits: texts.map(text => ({
                messageId: `${q}-${text}`,
                sessionId: 'sess-1',
                chatId: 'chat-1@c.us',
                timestamp: 1_767_225_600,
                snippet: text,
              })),
              total,
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
  failing.clear();
  offsets.length = 0;
  scopes.length = 0;
});

async function typeAndWaitForRequest(input: HTMLElement, value: string): Promise<void> {
  rtl.fireEvent.change(input, { target: { value } });
  await rtl.waitFor(() => assert.ok(pending.has(value), `expected a search for "${value}"`));
}

test('focus that returns to the input before the results close keeps them open', async () => {
  const { screen, act } = rtl;
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  try {
    rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
    const input = screen.getByRole('textbox');
    input.focus();
    await typeAndWaitForRequest(input, 'refund');
    await act(async () => pending.get('refund')!(['refund issued']));
    await screen.findByRole('listbox');
    act(() => outside.focus());
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    act(() => input.focus());
    await act(() => new Promise(resolve => setTimeout(resolve, 200)));
    assert.ok(screen.queryByRole('listbox'), 'a close scheduled before focus came back still ran');
  } finally {
    outside.remove();
  }
});
