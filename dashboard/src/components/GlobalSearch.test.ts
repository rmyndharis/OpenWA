// Render test for GlobalSearch under the bare `node --test` runner (jsdom loader hooks, recorded fetch
// stub). Each GET /search is held until the test releases it, so responses can land out of order: a
// slower, earlier query must never replace the results of the one the input now shows.
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
// The label of the button that loads the next page when 20 of 40 hits are shown. It names the action;
// a bare "40 results" says nothing about what a click does.
let more40: string;
let GlobalSearch: (typeof import('./GlobalSearch.tsx'))['GlobalSearch'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady, default: i18n } = await import('../i18n/index.ts');
  await i18nReady;
  more40 = i18n.t('search.loadMore', { shown: 20, total: 40 });
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
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rtl.screen.queryByText('refund issued') === null, true, 'the cleared query filled the list');
});

test('Escape during a pending keystroke keeps the dismissed results closed', async () => {
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = rtl.screen.getByRole('textbox');

  await typeAndWaitForRequest(input, 'refund');
  await rtl.act(async () => pending.get('refund')!(['refund issued']));
  await rtl.screen.findByRole('listbox');

  rtl.fireEvent.change(input, { target: { value: 'refunds' } });
  rtl.fireEvent.keyDown(input, { key: 'Escape' });
  assert.ok(!rtl.screen.queryByRole('listbox'), 'Escape left the results open');
  // Past the debounce: the keystroke typed before Escape must not reopen them.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(!rtl.screen.queryByRole('listbox'), 'the pending debounce reopened the dismissed results');
});

test('Escape that cancels a search before any results opened is consumed', async () => {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');

  fireEvent.change(input, { target: { value: 'refund' } });
  // Inside the debounce window: nothing has opened yet, but the key cancels the pending search, so a
  // page-level Escape handler (the Chats page closes the open conversation) must leave it alone.
  assert.equal(fireEvent.keyDown(input, { key: 'Escape' }), false, 'the cancelling Escape was not consumed');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(!pending.has('refund'), 'the cancelled search still ran');
  assert.ok(!screen.queryByRole('listbox'), 'the cancelled search opened results');
  // With nothing pending and nothing open, Escape is not the widget's to keep.
  assert.equal(fireEvent.keyDown(input, { key: 'Escape' }), true, 'an idle Escape was swallowed');
});

test("refocusing after Escape cancelled a search does not show the previous query's results", async () => {
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = rtl.screen.getByRole('textbox');

  await typeAndWaitForRequest(input, 'refund');
  await rtl.act(async () => pending.get('refund')!(['refund issued']));
  await rtl.screen.findByRole('listbox');

  rtl.fireEvent.change(input, { target: { value: 'refunds' } });
  rtl.fireEvent.keyDown(input, { key: 'Escape' });
  rtl.fireEvent.focus(input);
  assert.ok(!rtl.screen.queryByText('refund issued'), 'refocus showed results for the old query');
  await rtl.waitFor(() => assert.ok(pending.has('refunds'), 'refocus did not search the query the input shows'));
  await rtl.act(async () => pending.get('refunds')!(['refunds batch']));
  await rtl.screen.findByText('refunds batch');
});

const page = (from: number): string[] => Array.from({ length: 20 }, (_, i) => `refund ${from + i}`);

test('a mouse click on "more" keeps the results open and appends the next page', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(page(0), 40));
  const more = await screen.findByRole('button', { name: more40 });

  // A real mousedown moves focus off the input; cancelling it is what keeps the input focused.
  assert.equal(fireEvent.mouseDown(more), false, 'mousedown on "more" was not cancelled');
  fireEvent.click(more);
  await waitFor(() => assert.deepEqual(offsets, ['0', '20']));
  await act(async () => pending.get('refund')!(page(20), 40));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(screen.queryByRole('listbox'), 'the results closed after "more"');
  assert.equal(screen.getAllByRole('option').length, 40);
});

test('"more" does not repeat a hit that a newly indexed message pushed onto the next page', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(page(0), 40));
  fireEvent.click(await screen.findByRole('button', { name: more40 }));
  await waitFor(() => assert.deepEqual(offsets, ['0', '20']));
  // A match indexed in between shifted every hit down by one, so offset 20 starts with the old 20th.
  await act(async () => pending.get('refund')!(page(19), 41));
  await waitFor(() => assert.ok(screen.queryByText('refund 38')));
  assert.equal(screen.getAllByText('refund 19').length, 1, 'the shifted hit is listed twice');
  assert.equal(screen.getAllByRole('option').length, 39);
  // The next page starts after the 40 rows the server has sent, not after the 39 listed, and the last
  // row it returns ends the list: the dropped repeat must not keep "more" up for a match never fetched.
  fireEvent.click(screen.getByRole('button', { name: /39/ }));
  await waitFor(() => assert.deepEqual(offsets, ['0', '20', '40']));
  await act(async () => pending.get('refund')!(['refund 39'], 41));
  await waitFor(() => assert.ok(screen.queryByText('refund 39')));
  assert.equal(screen.getAllByRole('option').length, 40);
  assert.equal(screen.queryByRole('button', { name: /41/ }) === null, true, '"more" stayed up after the last page');
});

test('a failed "more" keeps the results already shown and offers the button again', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(page(0), 40));
  fireEvent.click(await screen.findByRole('button', { name: more40 }));
  await waitFor(() => assert.deepEqual(offsets, ['0', '20']));
  await act(async () => failing.get('refund')!(500));

  await screen.findByText('Search failed. Try again.');
  assert.equal(screen.getAllByRole('option').length, 20, 'the first page was dropped');
  // The retry runs the same page again, and its success clears the error.
  fireEvent.click(screen.getByRole('button', { name: more40 }));
  await waitFor(() => assert.deepEqual(offsets, ['0', '20', '20']));
  await act(async () => pending.get('refund')!(page(20), 40));
  await waitFor(() => assert.equal(screen.getAllByRole('option').length, 40));
  assert.equal(screen.queryByText('Search failed. Try again.') === null, true);
});

test('a failed search shows only the error', async () => {
  const { screen, act } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(page(0), 40));
  await screen.findByRole('button', { name: more40 });

  await typeAndWaitForRequest(input, 'refunds');
  await act(async () => failing.get('refunds')!(500));
  await screen.findByText('Search failed. Try again.');
  assert.equal(screen.queryAllByRole('option').length, 0, "the previous query's hits stayed on screen");
  assert.equal(screen.queryByRole('button', { name: more40 }) === null, true);
  assert.equal(screen.queryByText('No messages found.') === null, true);
});

test('Tab then Enter on "more" keeps the results open and returns focus to the input', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(page(0), 40));
  const more = await screen.findByRole('button', { name: more40 });

  // Tabbing moves focus from the input to the button; the results must outlive the close timer.
  act(() => more.focus());
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(screen.queryByRole('listbox'), 'moving focus to "more" closed the results');

  // Enter and Space activate a focused button through click.
  fireEvent.click(more);
  await waitFor(() => assert.deepEqual(offsets, ['0', '20']));
  assert.equal(document.activeElement, input, 'focus was left on the replaced button');
  await act(async () => pending.get('refund')!(page(20), 40));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(screen.queryByRole('listbox'), 'the results closed after "more"');
  assert.equal(screen.getAllByRole('option').length, 40);
});

test('focus leaving the widget still closes the results', async () => {
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
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(!screen.queryByRole('listbox'), 'the results stayed open after focus left');
  } finally {
    outside.remove();
  }
});

test('picking a hit with the mouse closes the results', async () => {
  const { screen, act, fireEvent } = rtl;
  const picked: string[] = [];
  rtl.render(createElement(GlobalSearch, { onHit: (h: { messageId: string }) => picked.push(h.messageId) }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(['refund issued']));
  const hit = await screen.findByRole('option');
  // A browser moves focus to the pressed button on mousedown, then fires click.
  act(() => {
    fireEvent.mouseDown(hit);
    hit.focus();
  });
  fireEvent.click(hit);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(picked.length, 1);
  assert.ok(!screen.queryByRole('listbox'), 'the results stayed open after picking a hit');
});

test('clicking the input after a pick or Escape shows the results again', async () => {
  const { screen, act, fireEvent } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(['refund issued']));
  // A mouse pick keeps focus in the input, so the click back fires no focus event.
  const hit = await screen.findByRole('option');
  fireEvent.mouseDown(hit);
  fireEvent.click(hit);
  assert.ok(!screen.queryByRole('listbox'), 'picking a hit left the results open');
  fireEvent.click(input);
  assert.ok(await screen.findByRole('listbox'), 'clicking the input after a pick did not reopen the results');

  fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
  assert.ok(screen.queryByRole('listbox'), 'an Escape the input method processed closed the results');
  fireEvent.keyDown(input, { key: 'Escape' });
  assert.ok(!screen.queryByRole('listbox'), 'Escape left the results open');
  fireEvent.click(input);
  assert.ok(await screen.findByRole('listbox'), 'clicking the input after Escape did not reopen the results');
});

test('a click on the input while a keystroke search is pending sends that search once', async () => {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  fireEvent.change(input, { target: { value: 'refund' } });
  fireEvent.click(input); // before the 300 ms debounce fires
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(offsets, ['0'], 'the same search went out twice');
});

test('clicking the input after Escape cancelled a scope change searches the scope shown', async () => {
  const { screen, act, fireEvent, waitFor } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined, currentSessionId: 'sess-1' }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(['refund issued']));
  await screen.findByRole('listbox');

  const scope = screen.getByRole('checkbox');
  fireEvent.click(scope);
  fireEvent.keyDown(scope, { key: 'Escape' }); // cancels the scoped search before it goes out
  fireEvent.click(input);
  await waitFor(() => assert.deepEqual(scopes, ['', 'sess-1']));
});

test('a hit reached with Tab is picked with Enter or Space', async () => {
  const { screen, act, fireEvent } = rtl;
  const picked: string[] = [];
  rtl.render(createElement(GlobalSearch, { onHit: (h: { messageId: string }) => picked.push(h.messageId) }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(['refund issued']));
  const hit = await screen.findByRole('option');
  act(() => hit.focus());
  // Enter and Space activate a focused button through click, with no mousedown.
  fireEvent.click(hit);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(picked.length, 1);
  assert.ok(!screen.queryByRole('listbox'), 'the results stayed open after picking a hit');
});

test('Escape with focus on "more" closes the results and is consumed', async () => {
  const { screen, act, fireEvent } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  input.focus();
  await typeAndWaitForRequest(input, 'refund');
  await act(async () => pending.get('refund')!(page(0), 40));
  const more = await screen.findByRole('button', { name: more40 });
  act(() => more.focus());
  // Unconsumed, the key would reach the Chats page handler and close the open conversation instead.
  assert.equal(fireEvent.keyDown(more, { key: 'Escape' }), false, 'Escape on "more" was not consumed');
  assert.ok(!screen.queryByRole('listbox'), 'Escape on "more" left the results open');
});

test('a hit shows its chat id and time as isolated runs, so a right-to-left page keeps them readable', async () => {
  const { screen, act } = rtl;
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  const input = screen.getByRole('textbox');
  await typeAndWaitForRequest(input, 'alice');
  await act(async () => pending.get('alice')!(['alice replied']));
  const meta = (await screen.findByRole('listbox')).querySelector('.global-search-hit-meta');
  assert.ok(meta, 'the hit has no meta line');
  // A <bdi> takes its direction from its own text, so the Latin id and the digits stay in order inside Arabic or Hebrew text.
  assert.deepEqual(
    [...meta.querySelectorAll('bdi')].map(run => run.textContent),
    ['chat-1@c.us', new Date(1_767_225_600 * 1000).toLocaleString()],
  );
});
