// The sidebar's message search lists pages of hits. Asking for the next one adds to the list the reader is on: the hits
// already shown stay while it is on its way, with the loading line under them. A new search is not that: it shows
// the loading line alone, so that an old answer is never offered for the new text.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { SearchHit } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let GlobalSearch: (typeof import('./GlobalSearch.tsx'))['GlobalSearch'];

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
// A search goes out after the box's debounce: a condition that depends on it is waited for up to this long, so a
// loaded machine makes the test slower and not wrong.
const DEADLINE = { timeout: 10_000 };

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ GlobalSearch } = await import('./GlobalSearch.tsx'));
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
const offsetOf = (input: RequestInfo | URL): number =>
  Number(new URL(String(input), 'http://localhost').searchParams.get('offset') ?? 0);
const queryOf = (input: RequestInfo | URL): string =>
  new URL(String(input), 'http://localhost').searchParams.get('q') ?? '';

async function listFirstPage(): Promise<void> {
  const { screen, fireEvent, waitFor } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  fireEvent.change(screen.getByLabelText('Search messages…'), { target: { value: 'message' } });
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 20), DEADLINE);
}

test('the hits already listed stay while the next page loads, with the loading line under them', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (offsetOf(input) === 0) return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    return new Promise<Response>(resolve => {
      release = () => resolve(json({ hits: page(21, 20), total: 45 }));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await screen.findByText('Searching…');

  const list = screen.getByRole('listbox');
  assert.equal(screen.queryAllByRole('option').length, 20, 'the hits already listed were taken off the screen');
  assert.equal(list.lastElementChild?.textContent, 'Searching…', 'the loading line is not under the hits');
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
    if (queryOf(input) === 'message') return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    return new Promise<Response>(resolve => {
      release = () => resolve(json({ hits: [], total: 0 }));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.change(screen.getByLabelText('Search messages…'), { target: { value: 'messages' } });
  await screen.findByText('Searching…', {}, DEADLINE);
  assert.equal(screen.queryAllByRole('option').length, 0, 'the hits of the text before were offered for the new one');
  await waitFor(() => assert.ok(release, 'the search for the new text was not made'), DEADLINE);
  await rtl.act(async () => release?.());
  await waitFor(() => assert.ok(screen.getByText('No messages found.')));
});

test('typing while a next page is coming shows the loading line of the new search alone', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const held: Array<() => void> = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (queryOf(input) === 'message' && offsetOf(input) === 0) {
      return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
    }
    return new Promise<Response>(resolve => {
      held.push(() => resolve(json({ hits: page(21, 20), total: 45 })));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await waitFor(() => assert.equal(held.length, 1, 'the next page was not asked for'));
  fireEvent.change(screen.getByLabelText('Search messages…'), { target: { value: 'messages' } });
  // Before the box's debounce has sent the new search: the old hits, and a Show more for them, are not its own.
  assert.equal(screen.queryAllByRole('option').length, 0, 'the hits of the text before were offered for the new one');
  assert.ok(screen.queryByRole('button', { name: /Show more/ }) === null, 'Show more of the old list is still offered');
  assert.equal(screen.getByRole('listbox').children.length, 1, 'something besides the loading line is listed');
  await waitFor(() => assert.equal(held.length, 2, 'the search for the new text was not made'), DEADLINE);
  // The page of the old text lands first and the answer of the new text after it: only the new one is listed.
  await rtl.act(async () => held[0]());
  assert.equal(screen.queryAllByRole('option').length, 0, 'the page of the old text was listed under the new text');
  await rtl.act(async () => held[1]());
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 20));
  assert.ok(screen.queryByText('Searching…') === null);
});

test('clearing the text while a next page is coming leaves no loading line behind', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const held: Array<() => void> = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (offsetOf(input) === 0) {
      const first = queryOf(input) === 'message';
      return Promise.resolve(json({ hits: page(1, first ? 20 : 2), total: first ? 45 : 2 }));
    }
    return new Promise<Response>(resolve => {
      held.push(() => resolve(json({ hits: page(21, 20), total: 45 })));
    });
  }) as typeof fetch;
  await listFirstPage();
  fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
  await waitFor(() => assert.equal(held.length, 1, 'the next page was not asked for'));
  const box = screen.getByLabelText('Search messages…');
  fireEvent.change(box, { target: { value: '' } });
  fireEvent.change(box, { target: { value: 'other' } });
  // The line that is up is the new search's own: nothing of the page that was dropped is listed with it.
  assert.equal(screen.getByRole('listbox').children.length, 1, 'something besides the loading line is listed');
  await waitFor(() => assert.equal(screen.queryAllByRole('option').length, 2), DEADLINE);
  await rtl.act(async () => held.forEach(answer => answer()));
  assert.equal(screen.queryAllByRole('option').length, 2, 'the page that was dropped was listed under the new text');
  assert.ok(screen.queryByText('Searching…') === null);
});

test('a failed next page keeps the hits already listed and offers Show more again', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (offsetOf(input) === 0) return Promise.resolve(json({ hits: page(1, 20), total: 45 }));
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

test('a first search that fails is said alone, and a gateway without search is said to be unavailable', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      queryOf(input) === 'message' ? json({ message: 'no provider' }, 501) : json({ message: 'boom' }, 500),
    )) as typeof fetch;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const box = screen.getByLabelText('Search messages…');
  fireEvent.change(box, { target: { value: 'message' } });
  await waitFor(() => assert.ok(screen.getByText('Search is not configured.')), DEADLINE);
  assert.equal(screen.getByRole('listbox').children.length, 1, 'something besides the failure is listed');
  fireEvent.change(box, { target: { value: 'other' } });
  await waitFor(() => assert.ok(screen.getByText('Search failed. Try again.')), DEADLINE);
  assert.equal(screen.getByRole('listbox').children.length, 1, 'something besides the failure is listed');
});
