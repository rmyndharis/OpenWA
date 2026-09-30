// Render test for the Webhooks page under the bare `node --test` runner, on the Templates.test.ts
// harness. GET /webhooks is OPERATOR-only, so a viewer key always gets 403 there; a failed read must
// say so instead of rendering the "no webhooks configured" empty state.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let webhooksStatus = 200;
let webhookList: unknown[] = [];
let sessionList: unknown[] = [];
let createCalls = 0;
let updateCalls = 0;
let createBody: Record<string, unknown> | undefined;
let updateBody: Record<string, unknown> | undefined;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse(sessionList));
    if (init?.method === 'POST' && path === '/api/sessions/sess-1/webhooks') {
      // Never answers: the create stays in flight, like one held up by the gateway's URL check.
      createCalls++;
      createBody = JSON.parse(String(init.body));
      return new Promise<Response>(() => {});
    }
    if (init?.method === 'PUT' && path === '/api/sessions/sess-1/webhooks/w1') {
      updateCalls++;
      updateBody = JSON.parse(String(init.body));
      return new Promise<Response>(() => {});
    }
    if (path === '/api/webhooks') {
      if (webhooksStatus === 403) {
        return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: operator' }, 403));
      }
      if (webhooksStatus !== 200) return Promise.resolve(jsonResponse({ message: 'database offline' }, 500));
      return Promise.resolve(jsonResponse(webhookList));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Webhooks: (typeof import('./Webhooks.tsx'))['Webhooks'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Webhooks } = await import('./Webhooks.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  webhookList = [];
  sessionList = [];
  createCalls = 0;
  updateCalls = 0;
  createBody = undefined;
  updateBody = undefined;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
});

function renderWebhooks(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Webhooks))),
    ),
  );
}

test('a 403 on the webhook list shows a permission state, not an empty list', async () => {
  webhooksStatus = 403;
  renderWebhooks();
  await rtl.screen.findByText('No access to webhooks');
  assert.ok(!rtl.screen.queryByText('No webhooks configured'), 'a refused read claimed there are no webhooks');
});

test('any other failed read shows the error, not an empty list', async () => {
  webhooksStatus = 500;
  renderWebhooks();
  await rtl.screen.findByText('Could not load webhooks');
  rtl.screen.getByText('database offline');
  assert.ok(!rtl.screen.queryByText('No webhooks configured'), 'a failed read claimed there are no webhooks');
});

test('a successful empty read still shows the empty state', async () => {
  webhooksStatus = 200;
  renderWebhooks();
  await rtl.screen.findByText('No webhooks configured');
});

test('a failed refetch keeps the cached list and flags the error above it', async () => {
  webhooksStatus = 200;
  webhookList = [{ id: 'w1', sessionId: 'sess-1', url: 'https://example.test/hook', events: [], active: true }];
  renderWebhooks();
  await rtl.screen.findByText('https://example.test/hook');

  webhooksStatus = 500;
  await rtl.act(() => queryClient!.refetchQueries({ queryKey: ['webhooks'] }));
  await rtl.screen.findByText('Failed to load data');
  rtl.screen.getByText('https://example.test/hook');
});

test('the filter badge popover names enum values in words, like the filter builder', async () => {
  webhooksStatus = 200;
  webhookList = [
    {
      id: 'w1',
      sessionId: 'sess-1',
      url: 'https://example.test/hook',
      events: ['message.received'],
      active: true,
      filters: {
        conditions: [
          { field: 'type', operator: 'is', value: ['image', 'unknown', 'future-type'] },
          { field: 'kind', operator: 'isNot', value: ['individual'] },
          { field: 'sender', operator: 'is', value: ['628123@c.us'] },
        ],
      },
    },
  ];
  renderWebhooks();
  const badge = (await rtl.screen.findByText('3 filters')).closest('.filter-badge') as HTMLElement;
  rtl.fireEvent.focus(badge);

  const rows = Array.from(document.querySelectorAll('.filter-popover-row')).map(r => r.textContent);
  assert.deepEqual(rows, [
    // An unmapped value stays raw rather than disappearing.
    'Message type is Image, Unknown type, future-type',
    'Chat kind is not Individual',
    // A contact field has no labels; its JIDs are shown as they are.
    'Sender is 628123@c.us',
  ]);
});

test('a second click on Create while the first create is in flight sends nothing', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  webhooksStatus = 200;
  sessionList = [{ id: 'sess-1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderWebhooks();

  fireEvent.click(await screen.findByRole('button', { name: 'Add Webhook' }));
  const sessionSelect = screen.getByLabelText<HTMLSelectElement>('Session');
  await rtl.findByText(sessionSelect, 'Main');
  fireEvent.change(sessionSelect, { target: { value: 'sess-1' } });
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.test/hook' } });

  const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });
  fireEvent.click(create);
  await waitFor(() => assert.equal(createCalls, 1));
  // A double click lands a moment later, after the pending create has rendered.
  await new Promise(resolve => setTimeout(resolve, 50));
  fireEvent.click(create);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(createCalls, 1);
});

test('Create stays disabled until both a session and a URL are filled in', async () => {
  const { screen, fireEvent } = rtl;
  webhooksStatus = 200;
  sessionList = [{ id: 'sess-1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderWebhooks();

  fireEvent.click(await screen.findByRole('button', { name: 'Add Webhook' }));
  const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });
  const sessionSelect = screen.getByLabelText<HTMLSelectElement>('Session');
  await rtl.findByText(sessionSelect, 'Main');
  assert.equal(create.disabled, true, 'nothing filled in');

  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.test/hook' } });
  assert.equal(create.disabled, true, 'URL without a session');

  fireEvent.change(sessionSelect, { target: { value: 'sess-1' } });
  assert.equal(create.disabled, false);

  fireEvent.change(screen.getByLabelText('URL'), { target: { value: '' } });
  assert.equal(create.disabled, true, 'session without a URL');
});

test('Create stays disabled with a hint while no event is selected', async () => {
  const { screen, fireEvent } = rtl;
  webhooksStatus = 200;
  sessionList = [{ id: 'sess-1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderWebhooks();

  fireEvent.click(await screen.findByRole('button', { name: 'Add Webhook' }));
  const sessionSelect = screen.getByLabelText<HTMLSelectElement>('Session');
  await rtl.findByText(sessionSelect, 'Main');
  fireEvent.change(sessionSelect, { target: { value: 'sess-1' } });
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.test/hook' } });
  const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });
  assert.equal(create.disabled, false);
  assert.equal(screen.queryByText('Select at least one event.'), null);

  fireEvent.click(screen.getByRole('button', { name: 'message.received' }));
  assert.equal(create.disabled, true, 'no event selected');
  screen.getByText('Select at least one event.');
  fireEvent.click(create);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(createCalls, 0);

  fireEvent.click(screen.getByRole('button', { name: 'message.received' }));
  assert.equal(create.disabled, false);
});

async function openEditModal(): Promise<HTMLButtonElement> {
  webhooksStatus = 200;
  webhookList = [
    {
      id: 'w1',
      sessionId: 'sess-1',
      url: 'https://example.test/hook',
      events: ['message.received'],
      active: true,
      secret: 'stray-secret-from-a-payload',
      headers: { 'X-Stray': 'value' },
    },
  ];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderWebhooks();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Edit'));
  return rtl.screen.getByRole<HTMLButtonElement>('button', { name: 'Save Changes' });
}

test('Save stays disabled with a hint while no event is selected', async () => {
  const { screen, fireEvent } = rtl;
  const save = await openEditModal();
  assert.equal(save.disabled, false);

  fireEvent.click(screen.getByRole('button', { name: 'message.received' }));
  assert.equal(save.disabled, true, 'no event selected');
  screen.getByText('Select at least one event.');
  fireEvent.click(save);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updateCalls, 0);
});

test('Save stays disabled while the URL is empty', async () => {
  const { screen, fireEvent } = rtl;
  const save = await openEditModal();
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: ' ' } });
  assert.equal(save.disabled, true);
  fireEvent.click(save);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updateCalls, 0);
});

test('a second click on Save while the first update is in flight sends nothing', async () => {
  const { fireEvent, waitFor } = rtl;
  const save = await openEditModal();
  fireEvent.click(save);
  await waitFor(() => assert.equal(updateCalls, 1));
  await new Promise(resolve => setTimeout(resolve, 50));
  fireEvent.click(save);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updateCalls, 1);
});

async function openCreateModal(): Promise<HTMLButtonElement> {
  const { screen, fireEvent } = rtl;
  webhooksStatus = 200;
  sessionList = [{ id: 'sess-1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderWebhooks();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Webhook' }));
  const sessionSelect = screen.getByLabelText<HTMLSelectElement>('Session');
  await rtl.findByText(sessionSelect, 'Main');
  fireEvent.change(sessionSelect, { target: { value: 'sess-1' } });
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.test/hook' } });
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });
}

function addHeaderRow(name: string, value: string): void {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
  const names = screen.getAllByLabelText('Header name');
  const values = screen.getAllByLabelText('Header value');
  fireEvent.change(names[names.length - 1], { target: { value: name } });
  fireEvent.change(values[values.length - 1], { target: { value: value } });
}

test('a create with the authentication section left empty sends neither a secret nor headers', async () => {
  const create = await openCreateModal();
  rtl.fireEvent.click(create);
  await rtl.waitFor(() => assert.equal(createCalls, 1));
  assert.deepEqual(Object.keys(createBody!).sort(), ['events', 'filters', 'url']);
});

test('a create sends the signing secret and custom headers exactly as typed', async () => {
  const { screen, fireEvent } = rtl;
  const create = await openCreateModal();
  fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: ' a-secret-of-20-chars' } });
  addHeaderRow('Authorization', 'Bearer abc');
  addHeaderRow('', '');
  fireEvent.click(create);
  await rtl.waitFor(() => assert.equal(createCalls, 1));
  assert.equal(createBody!.secret, ' a-secret-of-20-chars');
  assert.deepEqual(createBody!.headers, { Authorization: 'Bearer abc' });
});

test('Generate fills a 64-hex secret, and that exact value is sent', async () => {
  const { screen, fireEvent } = rtl;
  const create = await openCreateModal();
  const secret = screen.getByLabelText<HTMLInputElement>('Signing secret');
  assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy' }).disabled, true, 'nothing to copy yet');
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
  assert.match(secret.value, /^[0-9a-f]{64}$/);
  assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy' }).disabled, false);
  fireEvent.click(create);
  await rtl.waitFor(() => assert.equal(createCalls, 1));
  assert.equal(createBody!.secret, secret.value);
});

test('a short secret or a bad header keeps Create disabled and says why', async () => {
  const { screen, fireEvent } = rtl;
  const create = await openCreateModal();
  fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'too-short' } });
  assert.equal(create.disabled, true);
  screen.getByText('The signing secret must be 16 to 255 characters long.');

  fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: '' } });
  addHeaderRow('X-OpenWA-Signature', 'forged');
  assert.equal(create.disabled, true);
  screen.getByText(
    'Content-Type, User-Agent, X-OpenWA-* and connection headers are set by the gateway and cannot be used.',
  );
  fireEvent.click(create);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(createCalls, 0);
});

test('an edit that leaves the authentication section alone sends neither a secret nor headers', async () => {
  const { screen, fireEvent } = rtl;
  // A stray credential in the list payload must never reach the form or the update.
  const save = await openEditModal();
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.test/other' } });
  fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(updateCalls, 1));
  assert.equal(updateBody!.url, 'https://example.test/other');
  assert.equal('secret' in updateBody!, false);
  assert.equal('headers' in updateBody!, false);
});

test('an edit sends a replacement secret, or an empty one to stop signing', async () => {
  const { screen, fireEvent } = rtl;
  const save = await openEditModal();
  const secret = screen.getByLabelText<HTMLInputElement>('Signing secret');
  assert.equal(secret.value, '');
  fireEvent.change(secret, { target: { value: 'too-short' } });
  assert.equal(save.disabled, true);
  fireEvent.click(screen.getByLabelText('Stop signing deliveries (remove the secret)'));
  assert.equal(secret.disabled, true);
  assert.equal(save.disabled, false);
  fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(updateCalls, 1));
  assert.equal(updateBody!.secret, '');
  assert.equal('headers' in updateBody!, false);
});

test('an edit sends a typed secret', async () => {
  const { screen, fireEvent } = rtl;
  const save = await openEditModal();
  fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'a-new-secret-value-1' } });
  fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(updateCalls, 1));
  assert.equal(updateBody!.secret, 'a-new-secret-value-1');
});

test('replacing headers sends the whole map, and no rows sends an empty map', async () => {
  const { screen, fireEvent } = rtl;
  let save = await openEditModal();
  fireEvent.click(screen.getByLabelText('Replace custom headers'));
  addHeaderRow('X-Token', '\u20ac5');
  assert.equal(save.disabled, true, 'a value outside Latin-1 is refused');
  fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'abc' } });
  fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(updateCalls, 1));
  assert.deepEqual(updateBody!.headers, { 'X-Token': 'abc' });
  assert.equal('secret' in updateBody!, false);

  rtl.cleanup();
  queryClient?.clear();
  updateCalls = 0;
  save = await openEditModal();
  fireEvent.click(screen.getByLabelText('Replace custom headers'));
  fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(updateCalls, 1));
  assert.deepEqual(updateBody!.headers, {});
});
