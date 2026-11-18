// The in-chat search lists pages of hits like the sidebar's. A next page keeps the listed hits and puts the loading
// line under them; a new search shows the loading line alone; a failed next page keeps what is listed. An answer for
// text the reader has moved on from is dropped, a hit that a page repeats is listed once, and a gateway without search
// is said to be unavailable.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { SearchHit } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let RoomSearch: (typeof import('./RoomSearch.tsx'))['RoomSearch'];

const hitNo = (n: number): SearchHit => ({
  messageId: `db-${n}`,
  waMessageId: `wamid.${n}`,
  sessionId: 'sess-1',
  chatId: 'alice@c.us',
  body: `message ${n}`,
  snippet: `<mark>message</mark> ${n}`,
  timestamp: 1_700_000_000 + n,
  type: 'text',
  direction: 'incoming',
  from: 'alice@c.us',
});
const page = (from: number, count: number): SearchHit[] => Array.from({ length: count }, (_, i) => hitNo(from + i));
let release: (() => void) | undefined;
// A search goes out after the bar's debounce: a condition that depends on it is waited for up to this long, so a
// loaded machine makes the test slower and not wrong.
const DEADLINE = { timeout: 10_000 };

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoomSearch } = await import('./RoomSearch.tsx'));
});
afterEach(async () => {
  await rtl.act(async () => release?.());
  release = undefined;
  rtl.cleanup();
});
after(() => rtl.cleanup());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify({ ...(body as object), tookMs: 1, provider: 'test' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const param = (input: RequestInfo | URL, name: string): string =>
  new URL(String(input), 'http://localhost').searchParams.get(name) ?? '';

async function listFirstPage(): Promise<void> {
  const { screen, fireEvent, waitFor } = rtl;
  rtl.render(
    createElement(RoomSearch, {
      sessionId: 'sess-1',
      chatId: 'alice@c.us',
      onClose: () => undefined,
      onHit: () => true,
    }),
  );
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'message' } });
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 20), DEADLINE);
}

test('the loading line of a next page is under the hits, and a second page is not offered meanwhile', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (param(input, 'offset') === '0') return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    return new Promise<Response>(resolve => {
      release = () => resolve(json({ hits: page(21, 20), total: 45 }));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await screen.findByText('Searching…');
  assert.equal(screen.queryAllByRole('option').length, 20, 'the hits already listed were taken off the screen');
  assert.equal(
    screen.getByRole('listbox').lastElementChild?.textContent,
    'Searching…',
    'the loading line is not under the hits',
  );
  assert.ok(
    screen.queryByRole('button', { name: /Show more/ }) === null,
    'a second page was offered while one is coming',
  );

  await rtl.act(async () => release?.());
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 40));
  assert.ok(screen.queryByText('Searching…') === null);
});

test('a new search shows the loading line alone, not the hits of the text before it', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (param(input, 'q') === 'message') return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    return new Promise<Response>(resolve => {
      release = () => resolve(json({ hits: [], total: 0 }));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'messages' } });
  await screen.findByText('Searching…');
  assert.equal(screen.queryAllByRole('option').length, 0, 'the hits of the text before were offered for the new one');
  await waitFor(() => assert.ok(release, 'the search for the new text was not made'), DEADLINE);
  await rtl.act(async () => release?.());
  await waitFor(() => assert.ok(screen.getByText('No messages found.')));
});

test('typing while a next page is coming shows the loading line of the new search alone', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const held: Array<() => void> = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (param(input, 'q') === 'message' && param(input, 'offset') === '0') {
      return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    }
    return new Promise<Response>(resolve => {
      held.push(() => resolve(json({ hits: [], total: 0 })));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await waitFor(() => assert.equal(held.length, 1, 'the next page was not asked for'));
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'messages' } });
  assert.equal(screen.queryAllByRole('option').length, 0, 'the hits of the text before were offered for the new one');
  assert.equal(screen.getByRole('listbox').children.length, 1, 'something besides the loading line is listed');
  await waitFor(() => assert.equal(held.length, 2, 'the search for the new text was not made'), DEADLINE);
  await rtl.act(async () => held.forEach(answer => answer()));
  await waitFor(() => assert.ok(screen.getByText('No messages found.')));
});

test('a failed next page keeps the hits already listed and offers Show more again', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (param(input, 'offset') === '0') return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    return Promise.resolve(json({ message: 'boom' }, 500));
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /Show more/ })));
  assert.equal(screen.queryAllByRole('option').length, 20, 'the listed hits were lost with the failed page');
  assert.ok(screen.getByText('Search failed. Try again.'), 'the failure is not shown');
  // The reader pressed Show more at the end of the list: the failure is said there, where they are, not above the hits.
  const children = Array.from(screen.getByRole('listbox').children);
  const failedAt = children.findIndex(child => child.textContent === 'Search failed. Try again.');
  const lastHitAt = children.map(child => child.getAttribute('role')).lastIndexOf('option');
  assert.ok(failedAt > lastHitAt, 'the failure is above the hits, out of sight of a reader at the end of the list');
});

test('an answer for the text before the last keystroke is dropped, also when it arrives last', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  let slow: (() => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (param(input, 'q') !== 'mess') return Promise.resolve(json({ hits: page(10, 1), total: 1 }));
    return new Promise<Response>(resolve => {
      slow = () => resolve(json({ hits: page(1, 3), total: 3 }));
    });
  }) as typeof fetch;
  rtl.render(
    createElement(RoomSearch, {
      sessionId: 'sess-1',
      chatId: 'alice@c.us',
      onClose: () => undefined,
      onHit: () => true,
    }),
  );
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'mess' } });
  await waitFor(() => assert.ok(slow, 'the first search was not made'), DEADLINE);
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'messa' } });
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 1), DEADLINE);
  await rtl.act(async () => slow?.()); // the slow answer for 'mess' arrives after the one for 'messa'
  const options = screen.queryAllByRole('option');
  assert.equal(options.length, 1, 'the answer for the text before replaced the one for the new text');
  assert.match(options[0].textContent ?? '', /message 10/);
});

test('a next page that repeats a hit lists it once', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    // A message indexed since the first page moved every row down by one: the second page starts with the last of the first.
    if (param(input, 'offset') === '0') return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    return Promise.resolve(json({ hits: page(20, 20), total: 45 }));
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 39));
});

test('a search the gateway does not have is said to be unavailable', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = (() => Promise.resolve(json({ message: 'no provider' }, 501))) as typeof fetch;
  rtl.render(
    createElement(RoomSearch, {
      sessionId: 'sess-1',
      chatId: 'alice@c.us',
      onClose: () => undefined,
      onHit: () => true,
    }),
  );
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'message' } });
  await waitFor(() => assert.ok(screen.getByText('Search is not configured.')), DEADLINE);
});
