import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { SearchHit } from '../../services/api.ts';
import type { DayJump, RoomSearchProps } from './RoomSearch.tsx';

let rtl: typeof import('@testing-library/react');
let RoomSearch: (typeof import('./RoomSearch.tsx'))['RoomSearch'];

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

const NOT_LOADED = 'Older than the messages loaded in this chat. Scroll up in the chat to load older messages.';
/** Longer than the bar's debounce: a search restarted before this would have gone out by now. */
const PAST_DEBOUNCE_MS = 450;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoomSearch } = await import('./RoomSearch.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  mock.restoreAll();
});

after(() => rtl.cleanup());

/** Answers each search in turn (the last answer repeats): a page of hits, or an HTTP error status. Returns the URLs asked. */
function stubSearch(...answers: Array<{ hits: SearchHit[]; total: number } | number>): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    const [body, status] =
      typeof answer === 'number' ? [{ message: 'failed' }, answer] : [{ ...answer, tookMs: 1, provider: 'test' }, 200];
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  return calls;
}

function barProps(props: Partial<RoomSearchProps> = {}): RoomSearchProps {
  return { sessionId: 'sess-1', chatId: 'alice@c.us', onClose: () => undefined, onHit: () => true, ...props };
}

function renderBar(props: Partial<RoomSearchProps> = {}) {
  return rtl.render(createElement(RoomSearch, barProps(props)));
}

const textField = () => rtl.screen.getByLabelText('Search') as HTMLInputElement;
// By its type: what the field is named, and that nothing else shares the name, is one test's own subject below.
const dateField = () => document.querySelector('input[type="date"]') as HTMLInputElement;
/** Lets `ms` pass with whatever the bar does meanwhile (its debounce, an answer landing) applied. */
const wait = (ms: number) => rtl.act(() => new Promise<void>(resolve => setTimeout(resolve, ms)));

test('typing a query searches this chat, and a hit the thread scrolled to folds the list and keeps the query', async () => {
  const calls = stubSearch({ hits: [hit], total: 1 });
  const onHit = mock.fn((picked: SearchHit) => picked.waMessageId === 'wamid.1');
  const { screen, fireEvent, waitFor } = rtl;
  renderBar({ onHit });

  fireEvent.change(textField(), { target: { value: 'alice' } });
  await waitFor(() => assert.ok(calls.some(u => u.includes('/search?') && u.includes('chatId=alice'))));
  await screen.findByText('alice', { selector: 'mark' });
  fireEvent.click(screen.getByRole('option'));
  assert.equal(onHit.mock.callCount(), 1);
  assert.equal(onHit.mock.calls[0].arguments[0].waMessageId, 'wamid.1');

  assert.ok(screen.queryByRole('option') === null, 'the list stayed over the message the thread scrolled to');
  assert.ok(screen.queryByRole('status') === null);
  assert.equal(textField().value, 'alice', 'the query was thrown away with the pick');

  // The field brings the kept hits back, with no second request.
  fireEvent.click(textField());
  assert.ok(screen.getByRole('option'));
  assert.equal(calls.length, 1);
});

test('a hit picked from the keyboard leaves focus in the search field, not on the page', async () => {
  stubSearch({ hits: [hit], total: 1 });
  const { screen, fireEvent } = rtl;
  renderBar();
  fireEvent.change(textField(), { target: { value: 'alice' } });
  const option = await screen.findByRole('option');
  option.focus();
  fireEvent.click(option);
  assert.ok(document.activeElement === textField(), 'focus was left on the hit that unmounted');
  assert.ok(screen.queryByRole('option') === null, 'moving focus to the field reopened the list');
});

test('a picked hit the thread has not loaded keeps the list and says the message is older than what is loaded', async () => {
  stubSearch({ hits: [hit], total: 1 });
  const { screen, fireEvent } = rtl;
  renderBar({ onHit: () => false });
  fireEvent.change(textField(), { target: { value: 'alice' } });
  fireEvent.click(await screen.findByRole('option'));

  assert.equal(screen.getByRole('status').textContent, NOT_LOADED);
  assert.ok(screen.getByRole('option'), 'the result list was closed');
  assert.equal(textField().value, 'alice');

  // The next thing typed is a new search, and the notice was about the last pick.
  fireEvent.change(textField(), { target: { value: 'alice b' } });
  assert.ok(screen.queryByRole('status') === null);
});

test('a date alone asks the page to jump when no text is typed, and with text it narrows the search instead', async () => {
  const calls = stubSearch({ hits: [hit], total: 1 });
  const onJumpToDate = mock.fn((bounds: { dateFrom: number; dateTo: number }): DayJump => {
    void bounds;
    return 'shown';
  });
  const { screen, fireEvent } = rtl;
  renderBar({ onJumpToDate });

  fireEvent.change(dateField(), { target: { value: '2023-11-14' } });
  assert.equal(onJumpToDate.mock.callCount(), 1);
  const bounds = onJumpToDate.mock.calls[0]?.arguments[0];
  assert.ok(bounds && bounds.dateFrom < bounds.dateTo);
  assert.ok(screen.queryByRole('option') === null);
  assert.ok(screen.queryByRole('status') === null);
  assert.equal(calls.length, 0, 'a day with no text was sent to the search');

  fireEvent.change(textField(), { target: { value: 'alice' } });
  await screen.findByRole('option');
  const asked = new URL(calls[0], 'http://localhost').searchParams;
  assert.equal(asked.get('dateFrom'), String(bounds.dateFrom));
  assert.equal(asked.get('dateTo'), String(bounds.dateTo));

  // With text the day is a filter: changing it searches again and moves nothing.
  fireEvent.change(dateField(), { target: { value: '2023-11-15' } });
  assert.equal(onJumpToDate.mock.callCount(), 1);
});

test('a day further back than the loaded messages says so, and a day the chat has no message of says that', () => {
  stubSearch({ hits: [], total: 0 });
  const answers: Record<string, DayJump> = { '2023-11-14': 'older', '2023-11-15': 'none', '2023-11-16': 'shown' };
  let asked = '';
  const { screen, fireEvent } = rtl;
  renderBar({ onJumpToDate: () => answers[asked] });

  const pickDay = (value: string) => {
    asked = value;
    fireEvent.change(dateField(), { target: { value } });
  };
  pickDay('2023-11-14');
  assert.equal(screen.getByRole('status').textContent, NOT_LOADED);
  pickDay('2023-11-15');
  assert.equal(screen.getByRole('status').textContent, 'No loaded messages on that day');
  pickDay('2023-11-16');
  assert.ok(screen.queryByRole('status') === null);
});

test('a thread update, which hands the bar new callbacks, does not repeat the day jump', () => {
  stubSearch({ hits: [], total: 0 });
  let jumps = 0;
  // A new function on every render, as the page passes one whenever the thread's messages change.
  const next = () =>
    createElement(
      RoomSearch,
      barProps({
        onHit: () => true,
        onJumpToDate: () => {
          jumps += 1;
          return 'shown';
        },
      }),
    );
  const view = rtl.render(next());
  rtl.fireEvent.change(dateField(), { target: { value: '2023-11-14' } });
  assert.equal(jumps, 1);
  view.rerender(next());
  view.rerender(next());
  assert.equal(jumps, 1, 'the thread was scrolled back to the day by an update the user did not make');
});

test('a thread update does not restart a text search or drop the hits it listed', async () => {
  const calls = stubSearch({ hits: [hit], total: 1 });
  const next = () => createElement(RoomSearch, barProps({ onHit: () => true, onJumpToDate: () => 'shown' }));
  const { screen, fireEvent } = rtl;
  const view = rtl.render(next());
  fireEvent.change(textField(), { target: { value: 'alice' } });
  await screen.findByRole('option');
  assert.equal(calls.length, 1);

  view.rerender(next());
  assert.ok(screen.getByRole('option'), 'the hits gave way to a search nobody asked for');
  await wait(PAST_DEBOUNCE_MS);
  assert.equal(calls.length, 1, 'the search was sent again');
});

test('an update that lands while the search is still waiting to go out does not hold it back', async () => {
  const calls = stubSearch({ hits: [hit], total: 1 });
  const next = () => createElement(RoomSearch, barProps({ onHit: () => true, onJumpToDate: () => 'shown' }));
  const view = rtl.render(next());
  rtl.fireEvent.change(textField(), { target: { value: 'alice' } });
  // Updates closer together than the debounce, for longer than it: each one used to put the search off again.
  for (let i = 0; i < 6; i++) {
    await wait(100);
    view.rerender(next());
  }
  assert.equal(calls.length, 1, 'the search never went out while the thread kept updating');
});

test('clearing the text with a day set jumps to that day', async () => {
  stubSearch({ hits: [hit], total: 1 });
  let jumps = 0;
  const { screen, fireEvent } = rtl;
  renderBar({
    onJumpToDate: () => {
      jumps += 1;
      return 'older';
    },
  });
  fireEvent.change(textField(), { target: { value: 'alice' } });
  fireEvent.change(dateField(), { target: { value: '2023-11-14' } });
  assert.equal(jumps, 0);

  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  assert.equal(jumps, 1);
  assert.equal(textField().value, '');
  assert.equal(dateField().value, '2023-11-14', 'clearing the text took the day with it');
  assert.equal(screen.getByRole('status').textContent, NOT_LOADED);
  assert.ok(document.activeElement === textField());
});

test('Enter in the date field jumps again to the day it holds', () => {
  stubSearch({ hits: [], total: 0 });
  let jumps = 0;
  renderBar({
    onJumpToDate: () => {
      jumps += 1;
      return 'shown';
    },
  });
  rtl.fireEvent.change(dateField(), { target: { value: '2023-11-14' } });
  rtl.fireEvent.keyDown(dateField(), { key: 'Enter' });
  assert.equal(jumps, 2);
});

test('the day is one named date field that shows the day it holds, with a clear control of its own', () => {
  stubSearch({ hits: [hit], total: 1 });
  const { screen, fireEvent } = rtl;
  renderBar({ onJumpToDate: () => 'shown' });

  const named = screen.getAllByLabelText('Jump to date');
  assert.equal(named.length, 1, 'two controls answer to the same name');
  assert.equal(named[0].tagName, 'INPUT');
  assert.equal(named[0].getAttribute('type'), 'date');
  assert.notEqual(named[0].getAttribute('tabindex'), '-1');
  assert.ok(screen.queryByRole('button', { name: 'Clear date' }) === null, 'a clear control with no day to clear');

  fireEvent.change(textField(), { target: { value: 'alice' } });
  fireEvent.change(dateField(), { target: { value: '2023-11-14' } });
  assert.equal(dateField().value, '2023-11-14');
  fireEvent.click(screen.getByRole('button', { name: 'Clear date' }));
  assert.equal(dateField().value, '');
  assert.equal(textField().value, 'alice', 'clearing the day took the text with it');
  assert.ok(screen.queryByRole('button', { name: 'Clear date' }) === null);
  assert.ok(document.activeElement === dateField(), 'focus was left on the clear control that unmounted');
});

test('the text field has one clear control: the bar draws its own, so the field is not a search input', () => {
  stubSearch({ hits: [], total: 0 });
  const { screen, fireEvent } = rtl;
  renderBar();
  // A search input gets a second, native clear button in Chromium and WebKit.
  assert.equal(textField().getAttribute('type'), 'text');
  assert.ok(screen.queryByRole('button', { name: 'Clear search' }) === null);
  fireEvent.change(textField(), { target: { value: 'a' } });
  assert.equal(screen.getAllByRole('button', { name: 'Clear search' }).length, 1);
});

test('"No messages found." is said only of a search that has run', async () => {
  const calls = stubSearch({ hits: [], total: 0 });
  const { screen, fireEvent } = rtl;
  renderBar();
  fireEvent.change(textField(), { target: { value: 'nothing' } });

  // The debounce has not elapsed: nothing was asked yet, so nothing can be said to be missing.
  assert.equal(calls.length, 0);
  assert.ok(screen.queryByText('No messages found.') === null, 'the empty state came before the search');
  assert.ok(screen.getByText('Searching…'));

  await screen.findByText('No messages found.');
  assert.equal(calls.length, 1);

  // The same holds for the next text: its answer is not in yet.
  fireEvent.change(textField(), { target: { value: 'nothing else' } });
  assert.ok(screen.queryByText('No messages found.') === null, 'the last search answered for this one');
});

test('a failed next page keeps the hits already listed and shows the error beside them', async () => {
  const calls = stubSearch({ hits: [hit], total: 2 }, 500);
  const { screen, fireEvent } = rtl;
  renderBar();
  fireEvent.change(textField(), { target: { value: 'alice' } });
  await screen.findByRole('option');

  fireEvent.click(screen.getByRole('button', { name: 'Show more (1 of 2)' }));
  await screen.findByText('Search failed. Try again.');
  assert.equal(calls.length, 2);
  assert.ok(screen.getByRole('option'), 'the listed hit was replaced by the error');
  assert.ok(screen.getByRole('button', { name: 'Show more (1 of 2)' }), 'nothing was left to retry with');
  assert.ok(screen.queryByText('No messages found.') === null);
});

test('Escape closes the bar, unless another surface took the key or an input method is composing', () => {
  stubSearch({ hits: [], total: 0 });
  const onClose = mock.fn();
  renderBar({ onClose });

  rtl.fireEvent.keyDown(textField(), { key: 'Escape', isComposing: true });
  assert.equal(onClose.mock.callCount(), 0, 'the Escape of an input method closed the bar');

  // As the composer's emoji picker takes it: in the capture phase, marking it handled.
  const takeKey = (event: KeyboardEvent) => event.preventDefault();
  document.addEventListener('keydown', takeKey, true);
  try {
    rtl.fireEvent.keyDown(textField(), { key: 'Escape' });
  } finally {
    document.removeEventListener('keydown', takeKey, true);
  }
  assert.equal(onClose.mock.callCount(), 0, 'one Escape closed two surfaces');

  rtl.fireEvent.keyDown(textField(), { key: 'Escape' });
  assert.equal(onClose.mock.callCount(), 1);
});

test('the close control is a button of the bar, not the room Back button the two-pane layout hides', () => {
  stubSearch({ hits: [], total: 0 });
  const onClose = mock.fn();
  renderBar({ onClose });
  const close = rtl.screen.getByRole('button', { name: 'Back' });
  // RoomSearch.responsive.test.ts holds the stylesheets to never hiding these two classes.
  assert.equal(close.className, 'icon-btn room-search-close');
  rtl.fireEvent.click(close);
  assert.equal(onClose.mock.callCount(), 1);
});
