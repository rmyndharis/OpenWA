// The session switcher's list is a listbox: one option is in the tab order and the arrow keys move between them, and
// the text that says nothing matches sits outside the list, which may hold options only.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { Session } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let SessionPicker: (typeof import('./SessionPicker.tsx'))['default'];
let QueryClientProvider: (typeof import('@tanstack/react-query'))['QueryClientProvider'];
let QueryClient: (typeof import('@tanstack/react-query'))['QueryClient'];

const session = (id: string, name: string, status: Session['status'] = 'ready'): Session => ({
  id,
  name,
  status,
  phone: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

// Ann is down, so of the four only Ben, Cleo and Dan can be picked; Cleo is the one selected.
const SESSIONS = [session('a', 'Ann', 'disconnected'), session('b', 'Ben'), session('c', 'Cleo'), session('d', 'Dan')];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // The avatars ask for each ready account's picture; none has one.
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ url: null }), { headers: { 'Content-Type': 'application/json' } }),
    )) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ QueryClient, QueryClientProvider } = await import('@tanstack/react-query'));
  ({ default: SessionPicker } = await import('./SessionPicker.tsx'));
});

// Each client is cleared after its test: a picture read still out, or a cache entry's collection timer, keeps the
// runner from exiting.
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  rtl.cleanup();
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
});

function renderPicker(selectedSessionId = 'c') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SessionPicker, {
        sessions: SESSIONS,
        selectedSessionId,
        onSelectSession: () => undefined,
        canAddSession: false,
      }),
    ),
  );
}

const open = () => rtl.fireEvent.click(document.querySelector('.session-switcher-btn') as HTMLElement);
const tabStops = () =>
  rtl.screen
    .getAllByRole('option')
    .filter(option => option.tabIndex === 0)
    .map(option => option.querySelector('.session-name')?.textContent);
const focusedName = () =>
  (document.activeElement as HTMLElement | null)?.querySelector('.session-name')?.textContent ??
  document.activeElement?.getAttribute('aria-label');

test('only the selected session is in the tab order, and the arrow keys move focus and the tab stop with it', () => {
  renderPicker();
  open();
  assert.deepEqual(tabStops(), ['Cleo']);

  const search = rtl.screen.getByLabelText('Search sessions...');
  rtl.fireEvent.keyDown(search, { key: 'ArrowDown' });
  assert.equal(focusedName(), 'Ben', 'the first option that can be picked did not take focus');
  assert.deepEqual(tabStops(), ['Ben']);
  rtl.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
  rtl.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
  assert.equal(focusedName(), 'Dan');
  assert.deepEqual(tabStops(), ['Dan']);
  rtl.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
  rtl.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
  rtl.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
  assert.equal(focusedName(), 'Search sessions...', 'ArrowUp from the first option did not return to the search');
});

test('the tab stop falls to the first session that can be picked when the selected one cannot be or is not listed', () => {
  renderPicker('a');
  open();
  assert.deepEqual(tabStops(), ['Ben'], 'a session that cannot be picked holds the tab stop');
  rtl.fireEvent.change(rtl.screen.getByLabelText('Search sessions...'), { target: { value: 'd' } });
  assert.deepEqual(tabStops(), ['Dan']);
});

test('the tab stop starts at the selected session again each time the list opens', () => {
  renderPicker();
  open();
  rtl.fireEvent.keyDown(rtl.screen.getByLabelText('Search sessions...'), { key: 'ArrowDown' });
  assert.deepEqual(tabStops(), ['Ben']);
  rtl.fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 });
  assert.ok(rtl.screen.queryByRole('listbox'), 'an Escape the input method processed closed the list');
  rtl.fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(document.activeElement?.getAttribute('title'), 'Switch session', 'Escape did not return focus');
  open();
  assert.deepEqual(tabStops(), ['Cleo']);
});

test('a search with no match says so outside the listbox, which holds options only', () => {
  renderPicker();
  open();
  rtl.fireEvent.change(rtl.screen.getByLabelText('Search sessions...'), { target: { value: 'zz' } });
  const listbox = rtl.screen.getByRole('listbox');
  assert.equal(listbox.children.length, 0, 'the listbox holds something that is no option');
  assert.equal(listbox.contains(rtl.screen.getByText('No session matches')), false);
  assert.equal(rtl.screen.getByRole('textbox').getAttribute('aria-controls'), listbox.id);
});
