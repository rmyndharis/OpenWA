// Render test for the Templates page under the bare `node --test` runner, on the Sessions.test.ts
// harness. The template list route is OPERATOR-only: a viewer key is not sent it (the gateway records every
// refusal as a failed authentication) and is shown the permission state, and a 403 or any other failed read
// must say so instead of rendering the "no templates saved" empty state. The role defaults to operator, the
// lowest one that can read the list.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let templatesStatus = 200;
let templateReads = 0;
let sessionsStatus = 200;
// When set, GET /api/sessions answers only once this settles, holding the page on its first load.
let sessionsGate: Promise<void> | null = null;
// Sessions listed after the default one, which is dropped while `firstSessionGone` is set.
let extraSessions: Array<{ id: string; name: string }> = [];
let firstSessionGone = false;
let templates: Array<{ id: string; name: string; body: string }> = [];
const deleted: string[] = [];
const created: Array<{ path: string; name: string }> = [];
const updated: Array<{ path: string; body: string }> = [];
const copied: string[] = [];
// When set, a template create or update answers only once this settles, holding the save in flight.
let saveGate: Promise<void> | null = null;
let deleteGate: Promise<void> | null = null;
let deleteStatus = 200;
const deletePaths: string[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST' && /^\/api\/sessions\/[^/]+\/templates$/.test(path)) {
      const { name } = JSON.parse(String(init.body)) as { name: string };
      created.push({ path, name });
      const row = { id: `tpl-${created.length + 10}`, name, body: 'x' };
      return (saveGate ?? Promise.resolve()).then(() => jsonResponse(row, 201));
    }
    if (init?.method === 'PUT' && /^\/api\/sessions\/[^/]+\/templates\/[^/]+$/.test(path)) {
      const row = JSON.parse(String(init.body)) as { name: string; body: string };
      updated.push({ path, body: row.body });
      return (saveGate ?? Promise.resolve()).then(() => jsonResponse({ id: path.split('/').pop(), ...row }));
    }
    if (path === '/api/sessions') {
      if (sessionsGate) return sessionsGate.then(() => jsonResponse([]));
      if (sessionsStatus !== 200) return Promise.resolve(jsonResponse({ message: 'gateway restarting' }, 502));
      const rows = [{ id: 'sess-1', name: 'billing-bot' }, ...extraSessions].filter(
        row => !firstSessionGone || row.id !== 'sess-1',
      );
      return Promise.resolve(
        jsonResponse(
          rows.map(row => ({
            ...row,
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })),
        ),
      );
    }
    if (path === '/api/sessions/sess-2/templates') {
      return Promise.resolve(jsonResponse([{ id: 'tpl-2', name: 'support-greeting', body: 'Hello' }]));
    }
    if (path === '/api/sessions/sess-1/templates') {
      templateReads++;
      if (templatesStatus === 403) {
        return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: operator' }, 403));
      }
      if (templatesStatus !== 200)
        return Promise.resolve(jsonResponse({ message: 'database offline' }, templatesStatus));
      return Promise.resolve(jsonResponse(templates));
    }
    const rowMatch = /^\/api\/sessions\/sess-1\/templates\/(.+)$/.exec(path);
    if (init?.method === 'DELETE' && rowMatch) {
      deleted.push(rowMatch[1]);
      deletePaths.push(path);
      const status = deleteStatus;
      return (deleteGate ?? Promise.resolve()).then(() => {
        if (status !== 200) return jsonResponse({ message: 'template delete refused' }, status);
        templates = templates.filter(t => t.id !== rowMatch[1]);
        return jsonResponse({ success: true });
      });
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Templates: (typeof import('./Templates.tsx'))['Templates'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.scrollTo = () => {}; // opening a template scrolls to the editor, which jsdom does not implement
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
  });
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Templates } = await import('./Templates.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  sessionsStatus = 200;
  templatesStatus = 200;
  templates = [];
  extraSessions = [];
  firstSessionGone = false;
  created.length = 0;
  updated.length = 0;
  copied.length = 0;
  saveGate = null;
  deleteGate = null;
  deleteStatus = 200;
  deleted.length = 0;
  deletePaths.length = 0;
  templateReads = 0;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
});

function renderTemplates(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Templates))),
    ),
  );
}

// The row button exists so a template can be deleted without opening it in the editor first.
test('a write key can delete a template from its row', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  templatesStatus = 200;
  templates = [{ id: 'tpl-1', name: 'invoice-reminder', body: 'Hi {{name}}' }];
  deleted.length = 0;

  renderTemplates();

  const row = (await screen.findByText('invoice-reminder')).closest('.template-list-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

  // The confirm names the template, so a mis-click on a crowded list is recoverable.
  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText(/invoice-reminder/), 'the confirm did not name the template');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.deepEqual(deleted, ['tpl-1'], 'the delete never reached the API'));
});

// A read-only key is never sent the list, so it has no row to delete from.
test('a read-only key is shown the permission state without a list request the gateway would refuse', async () => {
  templates = [{ id: 'tpl-1', name: 'invoice-reminder', body: 'Hi {{name}}' }];
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderTemplates();

  await rtl.screen.findByText('No access to templates');
  assert.equal(rtl.screen.queryByText('No templates saved') === null, true);
  assert.equal(rtl.screen.queryByText('invoice-reminder') === null, true);

  // A retry or a window focus would send it again; give either the time to.
  window.dispatchEvent(new window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(templateReads, 0, 'the viewer page asked the gateway for the template list');
});

// The key's role is what the page learned at sign-in; a 403 for a key it took for a writer is still a refusal.
test('a 403 on the template list shows a permission state, not an empty library', async () => {
  templatesStatus = 403;
  renderTemplates();
  await rtl.screen.findByText('No access to templates');
  assert.equal(rtl.screen.queryByText('No templates saved') === null, true);
});

test('any other failed read shows the error, not an empty library', async () => {
  templatesStatus = 500;
  renderTemplates();
  await rtl.screen.findByText('Could not load templates');
  rtl.screen.getByText('database offline');
  assert.equal(rtl.screen.queryByText('No templates saved') === null, true);
});

test('a successful empty read still shows the empty state', async () => {
  renderTemplates();
  // Before a session is selected the templates read has not started and the list is briefly empty, so
  // only the settled read can tell an empty library from a loaded one.
  await rtl.waitFor(() =>
    assert.equal(queryClient!.getQueryState(['sessions', 'sess-1', 'templates'])?.status, 'success'),
  );
  await rtl.screen.findByText('No templates saved');
});

// Between the sessions read and the effect that selects the first session, no templates read has
// started yet; that frame must show the loading state, not claim the library is empty.
test('a library with templates never flashes the empty state while the first session is selected', async () => {
  templates = [{ id: 'tpl-1', name: 'invoice-reminder', body: 'Hi {{name}}' }];
  let sawEmpty = false;
  const observer = new MutationObserver(() => {
    if (document.body.textContent?.includes('No templates saved')) sawEmpty = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    renderTemplates();
    await rtl.screen.findByText('invoice-reminder');
  } finally {
    observer.disconnect();
  }
  assert.equal(sawEmpty, false, 'the empty state rendered before the templates read started');
});

test('a failed sessions read shows the error, not "no sessions available"', async () => {
  sessionsStatus = 502;
  renderTemplates();
  const alert = await rtl.screen.findByRole('alert');
  rtl.within(alert).getByText('Failed to load data');
  rtl.within(alert).getByText('gateway restarting');
  assert.equal(rtl.screen.queryByText('No sessions available') === null, true);
  assert.equal(rtl.screen.queryByRole('option', { name: 'No sessions' }) === null, true);
});

// The full-page loader puts both classes on the page root itself, so its rule must be a compound
// selector: a descendant one never matches, leaving the spinner in the top-left corner.
test('the first-load spinner is centered in a 400px block', async () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('./Templates.css', import.meta.url), 'utf8');
  document.head.appendChild(style);
  let release!: () => void;
  sessionsGate = new Promise<void>(resolve => (release = resolve));
  try {
    renderTemplates();
    const loader = document.querySelector('.templates-loading') as HTMLElement;
    assert.ok(loader, 'the page did not render its loading state');
    const computed = getComputedStyle(loader);
    assert.equal(computed.display, 'flex');
    assert.equal(computed.justifyContent, 'center');
    assert.equal(computed.minHeight, '400px');
  } finally {
    release();
    sessionsGate = null;
    style.remove();
  }
});

// A session deleted elsewhere drops out of the list on the next read. Kept selected, it matches no
// option, so the select shows another session while the list and every write still target the gone one.
test('a selected session that disappears from the list is replaced by the first remaining one', async () => {
  const { screen, act } = rtl;
  templatesStatus = 200;
  templates = [{ id: 'tpl-1', name: 'invoice-reminder', body: 'Hi {{name}}' }];
  extraSessions = [{ id: 'sess-2', name: 'support-bot' }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  await screen.findByText('invoice-reminder');
  const select = screen.getByLabelText<HTMLSelectElement>('Session');
  assert.equal(select.value, 'sess-1');

  firstSessionGone = true;
  await act(() => queryClient!.refetchQueries({ queryKey: ['sessions'], exact: true }));

  await screen.findByText('support-greeting');
  assert.equal(select.value, 'sess-2');
  assert.equal(screen.queryByText('invoice-reminder') === null, true);
  screen.getByText('Saved under support-bot');
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
});

test('a successful create clears the form for the next template', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  await screen.findByText('No templates saved');
  const name = screen.getByLabelText<HTMLInputElement>('Name');
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  fireEvent.change(name, { target: { value: 'invoice-reminder' } });
  fireEvent.change(body, { target: { value: 'Hi {{name}}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Template' }));

  await screen.findByText('Template created successfully');
  await waitFor(() => assert.equal(name.value, ''));
  assert.equal(body.value, '');
  assert.deepEqual(created, [{ path: '/api/sessions/sess-1/templates', name: 'invoice-reminder' }]);
});

// The session select stays usable while a save is in flight. A create that resolves after the operator
// switched session and started another draft must still land on the first session, and must not clear
// the draft now on screen.
test('a create that resolves after a session switch keeps the draft typed since', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  extraSessions = [{ id: 'sess-2', name: 'support-bot' }];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  await screen.findByText('No templates saved');
  const name = screen.getByLabelText<HTMLInputElement>('Name');
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  const select = screen.getByLabelText<HTMLSelectElement>('Session');
  fireEvent.change(name, { target: { value: 'invoice-reminder' } });
  fireEvent.change(body, { target: { value: 'Hi {{name}}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Template' }));
  await waitFor(() => assert.equal(created.length, 1));

  fireEvent.change(select, { target: { value: 'sess-2' } });
  await screen.findByText('support-greeting');
  fireEvent.change(name, { target: { value: 'support-followup' } });
  fireEvent.change(body, { target: { value: 'Still there?' } });

  release();
  await screen.findByText('Template created successfully');
  assert.equal(name.value, 'support-followup', 'the draft typed after the switch was cleared');
  assert.equal(body.value, 'Still there?');
  assert.equal(select.value, 'sess-2');
  assert.ok(
    screen.getByRole('heading', { name: 'Create Template' }),
    'the new draft was tied to the first session row',
  );
  assert.deepEqual(created, [{ path: '/api/sessions/sess-1/templates', name: 'invoice-reminder' }]);
});

// Edits made while a create is in flight stay on screen, and saving them must update the row just created:
// a second create with the same name would fail the per-session unique name check.
test('edits typed while a create is in flight are saved as an update to the new template', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  await screen.findByText('No templates saved');
  const name = screen.getByLabelText<HTMLInputElement>('Name');
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  fireEvent.change(name, { target: { value: 'invoice-reminder' } });
  fireEvent.change(body, { target: { value: 'Hi {{name}}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Template' }));
  await waitFor(() => assert.equal(created.length, 1));
  fireEvent.change(body, { target: { value: 'Hi {{name}}, your invoice is due' } });

  release();
  await screen.findByText('Template created successfully');
  await screen.findByRole('heading', { name: 'Edit Template' });
  assert.equal(name.value, 'invoice-reminder');
  assert.equal(body.value, 'Hi {{name}}, your invoice is due');

  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await screen.findByText('Template updated successfully');
  assert.equal(created.length, 1, 'the edits were sent as a second create');
  assert.deepEqual(updated, [
    { path: '/api/sessions/sess-1/templates/tpl-11', body: 'Hi {{name}}, your invoice is due' },
  ]);
});

test('an update that resolves after starting a new template keeps the new draft', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  const name = screen.getByLabelText<HTMLInputElement>('Name');
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  fireEvent.change(body, { target: { value: 'Hello again' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));

  fireEvent.click(screen.getByRole('button', { name: 'New Template' }));
  fireEvent.change(name, { target: { value: 'order-shipped' } });
  fireEvent.change(body, { target: { value: 'On its way' } });

  release();
  await screen.findByText('Template updated successfully');
  assert.equal(name.value, 'order-shipped', 'the new draft was cleared');
  assert.equal(body.value, 'On its way');
  assert.ok(screen.getByRole('heading', { name: 'Create Template' }));
  assert.deepEqual(updated, [{ path: '/api/sessions/sess-1/templates/tpl-1', body: 'Hello again' }]);
});

// Edits made while a rename is in flight stay on screen, so the editor must follow the stored row: the header's
// copy button would otherwise hand out the old name, which no longer exists.
test('edits typed while an update is in flight keep the editor on the renamed template', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  const name = screen.getByLabelText<HTMLInputElement>('Name');
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  fireEvent.change(name, { target: { value: 'welcome-v2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));
  fireEvent.change(body, { target: { value: 'Hello there' } });

  release();
  await screen.findByText('Template updated successfully');
  assert.equal(body.value, 'Hello there');
  fireEvent.click(screen.getByTitle('Copy template name'));
  await screen.findByText('Template name copied');
  assert.deepEqual(copied, ['welcome-v2']);
});

// Until an update settles, the list still holds the row as it was before the save. Reopening it then
// would put the old values back in the editor, bound to the same template, and the next save would
// silently undo the update.
test('the template being updated stays inert until its update settles', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  fireEvent.change(body, { target: { value: 'Hello again' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));

  const row = document.querySelector<HTMLButtonElement>('.template-list-item')!;
  assert.equal(row.disabled, true, 'the row being saved could be reopened');
  fireEvent.click(row);

  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello again' }];
  release();
  await screen.findByText('Template updated successfully');
  assert.equal(body.value, '', 'the pre-save values stayed in the editor');
  assert.ok(screen.getByRole('heading', { name: 'Create Template' }));
  await waitFor(() => assert.equal(row.disabled, false));
  assert.deepEqual(updated, [{ path: '/api/sessions/sess-1/templates/tpl-1', body: 'Hello again' }]);
});

// Only the row being updated holds stale values, so every other row stays openable mid-save: a save that
// never answers must not lock the whole library, and the one that resolves leaves the newer draft alone.
test('other templates stay openable while a save is in flight', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  templates = [
    { id: 'tpl-1', name: 'welcome', body: 'Hello' },
    { id: 'tpl-2', name: 'invoice', body: 'Due soon' },
  ];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  const name = screen.getByLabelText<HTMLInputElement>('Name');
  const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
  fireEvent.change(body, { target: { value: 'Hello again' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));

  const [first, second] = document.querySelectorAll<HTMLButtonElement>('.template-list-item');
  assert.equal(first.disabled, true);
  assert.equal(second.disabled, false, 'a row with no save in flight was locked');
  fireEvent.click(second);
  assert.equal(body.value, 'Due soon');

  release();
  await screen.findByText('Template updated successfully');
  assert.equal(name.value, 'invoice', 'the template opened mid-save was replaced');
  assert.equal(body.value, 'Due soon');
  await waitFor(() => assert.equal(first.disabled, false));

  saveGate = new Promise<void>(resolve => (release = resolve));
  fireEvent.click(screen.getByRole('button', { name: 'New Template' }));
  fireEvent.change(name, { target: { value: 'order-shipped' } });
  fireEvent.change(body, { target: { value: 'On its way' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Template' }));
  await waitFor(() => assert.equal(created.length, 1));
  assert.equal(first.disabled, false, 'a pending create locked the list');
  assert.equal(second.disabled, false, 'a pending create locked the list');
  release();
  await screen.findByText('Template created successfully');
});

// The rows come back as soon as the update resolves, before the list refetch lands, and a failed refetch keeps
// the cached rows. Either way the row must already carry the saved values, or reopening it and saving again
// would write the old ones back.
test('reopening a template after its update loads the saved values even if the list refresh fails', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello again' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));

  templatesStatus = 502;
  release();
  await screen.findByText('Template updated successfully');
  const row = document.querySelector<HTMLButtonElement>('.template-list-item')!;
  await waitFor(() => assert.equal(row.disabled, false));
  fireEvent.click(row);

  assert.equal(screen.getByLabelText<HTMLTextAreaElement>('Body').value, 'Hello again');
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 2));
  assert.equal(updated[1].body, 'Hello again', 'the second save wrote the pre-save body back');
});

// A session deleted elsewhere while an update is in flight moves the editor to an empty draft on the next
// session. The update resolving afterwards must leave that draft unbound: tied to the old session's row,
// its next save would send that row's id to the new session.
test('an update that resolves after its session disappeared leaves the next session draft unbound', async () => {
  const { screen, fireEvent, waitFor, act } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  extraSessions = [{ id: 'sess-2', name: 'support-bot' }];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello again' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));

  firstSessionGone = true;
  await act(() => queryClient!.refetchQueries({ queryKey: ['sessions'], exact: true }));
  await screen.findByText('support-greeting');

  release();
  await screen.findByText('Template updated successfully');
  assert.equal(screen.getByLabelText<HTMLSelectElement>('Session').value, 'sess-2');
  assert.ok(
    screen.getByRole('heading', { name: 'Create Template' }),
    'the next session draft was tied to the old session row',
  );
});

// The count above the list still shows the library is not empty, so a search that matches nothing
// must say so rather than claim no templates are saved.
test('a search with no match says so instead of reporting an empty library', async () => {
  const { screen, fireEvent } = rtl;
  templatesStatus = 200;
  templates = [{ id: 'tpl-1', name: 'invoice-reminder', body: 'Hi {{name}}' }];
  renderTemplates();

  await screen.findByText('invoice-reminder');
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'no-such-template' } });
  await screen.findByText('No templates match your search.');
  assert.equal(screen.queryByText('No templates saved') === null, true);
});

// Hebrew and Arabic flip the three-column grid. A physical left or right edge then lands on the
// workspace's outer border instead of between the columns, and left-aligned text reads backwards.
test('the workspace columns and list rows follow the text direction', () => {
  const css = readFileSync(new URL('./Templates.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /border-(left|right)\s*:/, 'a column divider uses a physical side');
  assert.doesNotMatch(css, /text-align\s*:\s*(left|right)\b/, 'text is aligned to a physical side');
});

// The selected row's highlight wins over the hover style by source order, so the hover rule may not carry any
// more specificity than `.selected`: hovering the open template would otherwise drop its highlight.
test('hovering the selected template row keeps its selected highlight', () => {
  const css = readFileSync(new URL('./Templates.css', import.meta.url), 'utf8');
  const hover = /^([^{}\n]*\.template-list-item:hover[^{}\n]*)\{/m.exec(css)?.[1].trim();
  assert.equal(hover?.replace(/:where\([^)]*\)+/g, ''), '.templates-page .template-list-item:hover');
  assert.ok(css.indexOf('.template-list-item.selected {') > css.indexOf(hover!), 'the selected rule must come last');
});

// Opening another template while a save is in flight must leave the editor bound to the template opened:
// the save resolving afterwards may not rebind it, or the next save writes one template's text into the other.
test('a save that resolves after another template was opened keeps the editor on that template', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  templates = [
    { id: 'tpl-1', name: 'welcome', body: 'Hello' },
    { id: 'tpl-2', name: 'invoice', body: 'Due soon' },
  ];
  let release!: () => void;
  saveGate = new Promise<void>(resolve => (release = resolve));
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderTemplates();

  fireEvent.click(await screen.findByText('welcome'));
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Hello again' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 1));

  fireEvent.click(screen.getByText('invoice'));
  assert.equal(screen.getByLabelText<HTMLTextAreaElement>('Body').value, 'Due soon');

  release();
  await screen.findByText('Template updated successfully');
  saveGate = null;
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Due tomorrow' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => assert.equal(updated.length, 2));

  assert.equal(updated[1].path, '/api/sessions/sess-1/templates/tpl-2', 'the invoice text was saved over welcome');
  assert.equal(updated[1].body, 'Due tomorrow');
});

for (const replacement of ['another template', 'a new template', 'another session'] as const) {
  test(`a completed delete keeps the draft opened in ${replacement}`, async () => {
    const { screen, fireEvent, within, waitFor } = rtl;
    templates = [
      { id: 'tpl-1', name: 'welcome', body: 'Hello' },
      { id: 'tpl-2', name: 'invoice', body: 'Due soon' },
    ];
    extraSessions = [{ id: 'sess-2', name: 'support-bot' }];
    let release!: () => void;
    deleteGate = new Promise<void>(resolve => (release = resolve));
    renderTemplates();
    fireEvent.click(await screen.findByText('welcome'));
    const row = screen.getByText('welcome').closest('.template-list-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => assert.equal(deleted.length, 1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    assert.equal(screen.queryByRole('dialog') === null, true);

    if (replacement === 'another template') fireEvent.click(screen.getByText('invoice'));
    else if (replacement === 'a new template') fireEvent.click(screen.getByRole('button', { name: 'New Template' }));
    else {
      fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'sess-2' } });
      await screen.findByText('support-greeting');
    }
    const name = screen.getByLabelText<HTMLInputElement>('Name');
    const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
    assert.equal(name.disabled, false);
    assert.equal(body.disabled, false);
    assert.equal(screen.getByLabelText<HTMLSelectElement>('Session').disabled, false);
    assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'New Template' }).disabled, false);
    fireEvent.change(name, { target: { value: 'replacement-draft' } });
    fireEvent.change(body, { target: { value: 'Hello {{customer}}' } });
    fireEvent.change(screen.getByLabelText('{{customer}}'), { target: { value: 'Ada' } });

    release();
    await screen.findByText('Template deleted successfully');
    assert.equal(name.value, 'replacement-draft', 'the completed delete cleared the replacement name');
    assert.equal(body.value, 'Hello {{customer}}', 'the completed delete cleared the replacement body');
    assert.equal(screen.getByLabelText<HTMLInputElement>('{{customer}}').value, 'Ada');
    assert.equal(document.querySelector('.template-preview-message pre')?.textContent, 'Hello Ada');
    screen.getByRole('heading', { name: replacement === 'another template' ? 'Edit Template' : 'Create Template' });
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>('Session').value,
      replacement === 'another session' ? 'sess-2' : 'sess-1',
    );
    assert.deepEqual(deletePaths, ['/api/sessions/sess-1/templates/tpl-1']);
  });
}

test('a completed delete clears the editor when it still shows the deleted template', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  let release!: () => void;
  deleteGate = new Promise<void>(resolve => (release = resolve));
  renderTemplates();
  fireEvent.click(await screen.findByText('welcome'));
  const row = screen.getByText('welcome').closest('.template-list-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete' });
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(confirm.disabled, true));
  fireEvent.click(confirm);
  assert.deepEqual(deleted, ['tpl-1'], 'a pending confirmation sent another delete');

  release();
  await screen.findByText('Template deleted successfully');
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
  assert.equal(screen.getByLabelText<HTMLInputElement>('Name').value, '');
  assert.equal(screen.getByLabelText<HTMLTextAreaElement>('Body').value, '');
  screen.getByRole('heading', { name: 'Create Template' });
});

test('a failed delete keeps its confirmation and draft available for retry', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  templates = [{ id: 'tpl-1', name: 'welcome', body: 'Hello' }];
  deleteStatus = 409;
  let release!: () => void;
  deleteGate = new Promise<void>(resolve => (release = resolve));
  renderTemplates();
  fireEvent.click(await screen.findByText('welcome'));
  const row = screen.getByText('welcome').closest('.template-list-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.equal(deleted.length, 1));
  release();
  await screen.findByText(/template delete refused/);
  await waitFor(() =>
    assert.equal(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled, false),
  );
  assert.equal(screen.getByLabelText<HTMLInputElement>('Name').value, 'welcome');
  assert.equal(screen.getByLabelText<HTMLTextAreaElement>('Body').value, 'Hello');
  screen.getByRole('heading', { name: 'Edit Template' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  assert.equal(screen.queryByRole('dialog') === null, true);
});

test('a completed delete does not dismiss a newer confirmation', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  templates = [
    { id: 'tpl-1', name: 'welcome', body: 'Hello' },
    { id: 'tpl-2', name: 'invoice', body: 'Due soon' },
  ];
  let release!: () => void;
  deleteGate = new Promise<void>(resolve => (release = resolve));
  renderTemplates();
  await screen.findByText('welcome');
  const firstRow = screen.getByText('welcome').closest('.template-list-row') as HTMLElement;
  fireEvent.click(within(firstRow).getByRole('button', { name: 'Delete' }));
  const firstDialog = await screen.findByRole('dialog');
  fireEvent.click(within(firstDialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.equal(deleted.length, 1));
  fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close' }));
  const secondRow = screen.getByText('invoice').closest('.template-list-row') as HTMLElement;
  fireEvent.click(within(secondRow).getByRole('button', { name: 'Delete' }));
  const secondDialog = await screen.findByRole('dialog');
  assert.ok(secondDialog.textContent?.includes('invoice'));
  release();
  await screen.findByText('Template deleted successfully');
  assert.equal(
    screen.queryByRole('dialog') === secondDialog,
    true,
    'the earlier delete dismissed the newer confirmation',
  );
  assert.ok(secondDialog.textContent?.includes('invoice'));
  assert.deepEqual(deletePaths, ['/api/sessions/sess-1/templates/tpl-1']);
});
