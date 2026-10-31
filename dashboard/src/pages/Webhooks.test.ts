// Render test for the Webhooks page under the bare `node --test` runner, on the Templates.test.ts
// harness. GET /webhooks is OPERATOR-only: a viewer key is not sent it (the gateway records every refusal as a
// failed authentication) and is shown the permission state, and a 403 or any other failed read must say so
// instead of rendering the "no webhooks configured" empty state. The role defaults to operator, the lowest
// one that can read the list.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let webhooksStatus = 200;
let webhookReads = 0;
let webhookList: unknown[] = [];
let sessionList: unknown[] = [];
let createCalls = 0;
let updateCalls = 0;
let createBody: Record<string, unknown> | undefined;
let updateBody: Record<string, unknown> | undefined;
// Test deliveries and deletes, recorded by path; each answers only once `releaseRequests` runs.
let testCalls: string[] = [];
let deleteCalls: string[] = [];
let heldRequests: Promise<void> = Promise.resolve();
let releaseRequests: () => void = () => {};
function holdRequests(): void {
  heldRequests = new Promise<void>(resolve => (releaseRequests = resolve));
}

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
    if (init?.method === 'POST' && /^\/api\/sessions\/sess-1\/webhooks\/[^/]+\/test$/.test(path)) {
      testCalls.push(path);
      return heldRequests.then(() => jsonResponse({ success: true, statusCode: 200 }));
    }
    if (init?.method === 'DELETE' && /^\/api\/sessions\/sess-1\/webhooks\/[^/]+$/.test(path)) {
      deleteCalls.push(path);
      // A repeat delete finds the row gone, as the gateway's does.
      const repeat = deleteCalls.filter(p => p === path).length > 1;
      return heldRequests.then(() =>
        repeat ? jsonResponse({ message: 'Webhook not found' }, 404) : new Response(null, { status: 204 }),
      );
    }
    if (path === '/api/webhooks') {
      webhookReads++;
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
  window.sessionStorage.setItem('openwa_user_role', 'operator');
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
  testCalls = [];
  deleteCalls = [];
  releaseRequests();
  heldRequests = Promise.resolve();
  webhookReads = 0;
  window.sessionStorage.setItem('openwa_user_role', 'operator');
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

// The key's role is what the page learned at sign-in; a 403 for a key it took for a writer is still a refusal.
test('a 403 on the webhook list shows a permission state, not an empty list', async () => {
  webhooksStatus = 403;
  renderWebhooks();
  await rtl.screen.findByText('No access to webhooks');
  assert.ok(!rtl.screen.queryByText('No webhooks configured'), 'a refused read claimed there are no webhooks');
});

test('a viewer key is shown the permission state without a list request the gateway would refuse', async () => {
  webhooksStatus = 200;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderWebhooks();
  await rtl.screen.findByText('No access to webhooks');
  assert.ok(!rtl.screen.queryByText('No webhooks configured'), 'a read nobody sent claimed there are no webhooks');

  // A retry or a window focus would send it again; give either the time to.
  window.dispatchEvent(new window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(webhookReads, 0, 'the viewer page asked the gateway for the webhook list');
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

// The popover is fixed against the viewport and was placed at the badge's left edge and below its bottom edge, so a
// badge near the right edge of a phone, or near the bottom of a short window, pushed it past the screen.
test('the filter badge popover stays inside the viewport', async () => {
  webhooksStatus = 200;
  webhookList = [
    {
      id: 'w1',
      sessionId: 'sess-1',
      url: 'https://example.test/hook',
      events: ['message.received'],
      active: true,
      filters: { conditions: [{ field: 'sender', operator: 'is', value: ['628123@c.us'] }] },
    },
  ];
  const sizes = Object.getOwnPropertyDescriptors(window.HTMLElement.prototype);
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  // jsdom lays nothing out: the popover is 240 by 80 px, the window 390 by 700.
  const size = (name: 'offsetWidth' | 'offsetHeight', value: number) =>
    Object.defineProperty(window.HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('filter-popover') ? value : 0;
      },
    });
  size('offsetWidth', 240);
  size('offsetHeight', 80);
  window.innerWidth = 390;
  window.innerHeight = 700;
  try {
    renderWebhooks();
    const badge = (await rtl.screen.findByText('1 filter')).closest('.filter-badge') as HTMLElement;
    const placeBadge = (left: number, top: number) => {
      badge.getBoundingClientRect = () =>
        ({ left, right: left + 70, top, bottom: top + 20, width: 70, height: 20, x: left, y: top }) as DOMRect;
      rtl.fireEvent.blur(badge);
      rtl.fireEvent.focus(badge);
      const popover = document.querySelector<HTMLElement>('.filter-popover')!;
      return { left: popover.style.left, top: popover.style.top };
    };
    // Room on both sides: below the badge, at its left edge.
    assert.deepEqual(placeBadge(100, 200), { left: '100px', top: '226px' });
    // Near the right edge: moved left until it ends 8px short of the edge.
    assert.deepEqual(placeBadge(350, 200), { left: '142px', top: '226px' });
    // Near the left edge: kept 8px off it.
    assert.deepEqual(placeBadge(2, 200), { left: '8px', top: '226px' });
    // Near the bottom: above the badge, whose top is at 650.
    assert.deepEqual(placeBadge(100, 650), { left: '100px', top: '564px' });
  } finally {
    window.innerWidth = innerWidth;
    window.innerHeight = innerHeight;
    for (const name of ['offsetWidth', 'offsetHeight'] as const) {
      const original = sizes[name];
      if (original) Object.defineProperty(window.HTMLElement.prototype, name, original);
      else delete (window.HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
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
  assert.equal(screen.queryByText('Select at least one event.') === null, true);

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

const FILTERS_HINT =
  'Give every filter condition a value, and use at most 20 conditions, 100 values per condition and 1000 characters of text.';

// FilterBuilder starts a condition as "sender is" with no contact, and the gateway refuses an empty
// value list and more than 20 conditions. Either would come back as raw English in a toast.
test('an incomplete filter condition keeps Create disabled and says why', async () => {
  const { screen, fireEvent } = rtl;
  const create = await openCreateModal();
  assert.equal(create.disabled, false);

  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
  assert.equal(create.disabled, true);
  screen.getByText(FILTERS_HINT);
  fireEvent.click(create);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(createCalls, 0);

  fireEvent.click(screen.getByRole('button', { name: 'Remove condition' }));
  assert.equal(create.disabled, false);
});

function editWebhookWith(conditions: unknown[]): void {
  webhooksStatus = 200;
  webhookList = [
    {
      id: 'w1',
      sessionId: 'sess-1',
      url: 'https://example.test/hook',
      events: ['message.received'],
      active: true,
      filters: { conditions },
    },
  ];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  renderWebhooks();
}

async function openEdit(): Promise<HTMLButtonElement> {
  const { screen, fireEvent } = rtl;
  fireEvent.click(await screen.findByTitle('Edit'));
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Save Changes' });
}

test('more than 20 filter conditions keep Save disabled', async () => {
  const { screen, fireEvent } = rtl;
  // Stored before the limit: the builder no longer adds a 21st row, but it can still load one.
  editWebhookWith(Array.from({ length: 21 }, () => ({ field: 'fromMe', operator: 'is', value: true })));
  const save = await openEdit();
  assert.equal(save.disabled, true);
  screen.getByText(FILTERS_HINT);

  fireEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[0]);
  assert.equal(save.disabled, false);
});

test('a condition with more than 100 values keeps Save disabled', async () => {
  const { screen, fireEvent } = rtl;
  const values = Array.from({ length: 101 }, (_, i) => `${i}@c.us`);
  editWebhookWith([{ field: 'sender', operator: 'is', value: values }]);
  const save = await openEdit();
  assert.equal(save.disabled, true);
  screen.getByText(FILTERS_HINT);
  fireEvent.click(save);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updateCalls, 0);
});

test('a test in flight on one webhook is not ended by a test on another', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  webhooksStatus = 200;
  webhookList = ['w1', 'w2'].map(id => ({
    id,
    sessionId: 'sess-1',
    url: `https://example.test/${id}`,
    events: ['message.received'],
    active: true,
  }));
  holdRequests();
  renderWebhooks();
  await screen.findByText('https://example.test/w2');
  const [first, second] = screen.getAllByTitle<HTMLButtonElement>('Test');

  fireEvent.click(first);
  fireEvent.click(second);
  await waitFor(() => assert.equal(testCalls.length, 2));
  assert.equal(first.disabled, true, 'the first test is still in flight');
  assert.equal(second.disabled, true);

  fireEvent.click(first);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(testCalls.length, 2);
  releaseRequests();
  await waitFor(() => assert.equal(first.disabled, false));
  assert.equal(second.disabled, false);
});

test('a second click on the delete confirm while the first delete is in flight sends nothing', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  webhooksStatus = 200;
  webhookList = [{ id: 'w1', sessionId: 'sess-1', url: 'https://example.test/hook', events: [], active: true }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  holdRequests();
  renderWebhooks();
  fireEvent.click(await screen.findByTitle('Delete'));

  const confirm = within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: 'Delete' });
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(deleteCalls.length, 1));
  await new Promise(resolve => setTimeout(resolve, 50));
  fireEvent.click(confirm);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(deleteCalls.length, 1);
  releaseRequests();
  await screen.findByText('Webhook deleted successfully');
  assert.equal(screen.queryByRole('alert') === null, true);
});

// A late success resets whichever modal is open by then, so a modal must not close and give way to
// another while its own request is in flight.
test('the edit modal stays open while its save is in flight', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const save = await openEditModal();
  fireEvent.click(save);
  await waitFor(() => assert.equal(updateCalls, 1));
  const dialog = screen.getByRole('dialog');
  const cancel = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
  assert.equal(cancel.disabled, true);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  assert.ok(screen.queryByRole('dialog'), 'the edit modal closed mid-save');
});

test('the create modal stays open while its create is in flight', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  fireEvent.click(await openCreateModal());
  await waitFor(() => assert.equal(createCalls, 1));
  const dialog = screen.getByRole('dialog');
  assert.equal(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled, true);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(screen.queryByRole('dialog'), 'the create modal closed mid-create');
});

test('the delete confirmation stays open while its delete is in flight', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  webhooksStatus = 200;
  webhookList = [{ id: 'w1', sessionId: 'sess-1', url: 'https://example.test/hook', events: [], active: true }];
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  holdRequests();
  renderWebhooks();
  fireEvent.click(await screen.findByTitle('Delete'));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.equal(deleteCalls.length, 1));
  assert.equal(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled, true);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(screen.queryByRole('dialog'), 'the delete confirmation closed mid-delete');
  releaseRequests();
  await screen.findByText('Webhook deleted successfully');
});
