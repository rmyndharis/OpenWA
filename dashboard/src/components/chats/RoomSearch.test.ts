import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { SearchHit } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let RoomSearch: (typeof import('./RoomSearch.tsx'))['RoomSearch'];
let wrap: (node: React.ReactNode) => React.ReactNode;

const hit: SearchHit = {
  messageId: 'db-1',
  waMessageId: 'wamid.1',
  sessionId: 'sess-1',
  chatId: 'alice@c.us',
  body: 'hello alice',
  snippet: 'hello <mark>alice</mark>',
  timestamp: 1_700_000_000,
  type: 'text',
  direction: 'incoming',
  from: 'alice@c.us',
};

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoomSearch } = await import('./RoomSearch.tsx'));
  wrap = node => node;
});

afterEach(() => {
  rtl.cleanup();
  mock.restoreAll();
});

after(() => rtl.cleanup());

test('typing a query searches this chat and picking a hit reports it', async () => {
  const calls: string[] = [];
  const onHit = mock.fn();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ hits: [hit], total: 1, tookMs: 1, provider: 'test' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  const { screen, fireEvent, waitFor } = rtl;
  rtl.render(
    wrap(
      createElement(RoomSearch, {
        sessionId: 'sess-1',
        chatId: 'alice@c.us',
        onClose: () => undefined,
        onHit,
      }),
    ),
  );

  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'alice' } });
  await waitFor(() => assert.ok(calls.some(u => u.includes('/search?') && u.includes('chatId=alice'))));
  await screen.findByText('alice', { selector: 'mark' });
  fireEvent.click(screen.getByRole('option'));
  assert.equal(onHit.mock.callCount(), 1);
  assert.equal(onHit.mock.calls[0].arguments[0].waMessageId, 'wamid.1');
});

test('a date alone asks the parent to jump when no text is typed', async () => {
  const onJumpToDate = mock.fn((_bounds: { dateFrom: number; dateTo: number }) => true);
  globalThis.fetch = (() => {
    throw new Error('search must not run without text');
  }) as typeof fetch;

  const { screen, fireEvent } = rtl;
  const { container } = rtl.render(
    wrap(
      createElement(RoomSearch, {
        sessionId: 'sess-1',
        chatId: 'alice@c.us',
        onClose: () => undefined,
        onHit: () => undefined,
        onJumpToDate,
      }),
    ),
  );

  const date = container.querySelector('input[type="date"]') as HTMLInputElement;
  fireEvent.change(date, { target: { value: '2023-11-14' } });
  assert.equal(onJumpToDate.mock.callCount(), 1);
  const bounds = onJumpToDate.mock.calls[0]?.arguments[0];
  assert.ok(bounds && bounds.dateFrom < bounds.dateTo);
  assert.equal(screen.queryByRole('option'), null);
});
