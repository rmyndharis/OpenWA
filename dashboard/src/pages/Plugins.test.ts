// Render test for the per-session plugin config override under the bare `node --test` runner, on the
// ApiKeys.test.ts harness. PUT /plugins/:id/config/:sessionId reports a rejected save as 200 +
// {success:false}; the override form must show that failure, not "Saved". A cleared override must also
// leave the form on the Global values, or the next save writes the cleared ones back.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const PLUGIN = {
  id: 'greeter',
  name: 'Greeter',
  version: '1.0.0',
  type: 'extension',
  status: 'enabled',
  config: { greeting: 'hello' },
  builtIn: false,
  provides: [],
  ingressCapable: false,
  configSchema: { type: 'object', properties: { greeting: { type: 'string', title: 'Greeting' } } },
  sessionScoped: true,
  activeSessions: ['*'],
  sessionConfig: {},
};

const SESSION = { id: 'sess-1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' };
const SESSION_2 = { id: 'sess-2', name: 'Second', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' };

const REJECTION = 'Cannot tell which entry was removed; reload and try again';

// Per-test server state: the session overrides GET returns, what PUT answers, and each PUT body sent.
let sessionConfig: Record<string, Record<string, unknown>> = {};
let putReply: { success: boolean; message?: string } = { success: false, message: REJECTION };
let putBodies: unknown[] = [];
// When set, a PUT waits for it before answering, so a test can act while the request is in flight.
let putGate: Promise<void> | undefined;
// Fields that replace the installed plugin's, and what the catalog route answers (and how often it was read).
let pluginOverride: Record<string, unknown> = {};
let catalogReply: () => Promise<Response> = () => Promise.resolve(jsonResponse([]));
let catalogReads = 0;
// Further installed plugins listed after PLUGIN, and a gate a POST /disable waits for before answering.
let extraPlugins: Record<string, unknown>[] = [];
let disableGate: Promise<void> | undefined;
// Whether GET /api/plugins answers with a server error, as it does while the plugin registry is unavailable.
let pluginListFails = false;
// What DELETE /api/plugins/:id answers; the plain answer is the one for a complete removal.
const UNINSTALLED = `Plugin ${PLUGIN.id} uninstalled successfully`;
let deleteReply: { success: boolean; message: string } = { success: true, message: UNINSTALLED };

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') {
      if (pluginListFails) return Promise.resolve(jsonResponse({ message: 'plugin registry unavailable' }, 500));
      return Promise.resolve(jsonResponse([{ ...PLUGIN, sessionConfig, ...pluginOverride }, ...extraPlugins]));
    }
    if (method === 'POST' && path.endsWith('/disable')) {
      return (disableGate ?? Promise.resolve()).then(() => jsonResponse({ success: true, message: 'Disabled' }));
    }
    if (method === 'GET' && path.endsWith('/health')) return Promise.resolve(jsonResponse({ healthy: true }));
    if (method === 'GET' && path === '/api/plugins/catalog') {
      catalogReads++;
      return catalogReply();
    }
    if (method === 'POST' && path === '/api/plugins/install') return Promise.resolve(jsonResponse(PLUGIN));
    if (method === 'DELETE' && path === `/api/plugins/${PLUGIN.id}`) {
      return Promise.resolve(jsonResponse(deleteReply));
    }
    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([SESSION, SESSION_2]));
    if (method === 'PUT' && path === `/api/plugins/${PLUGIN.id}/config`) {
      putBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse(putReply));
    }
    const put = method === 'PUT' ? path.match(new RegExp(`^/api/plugins/${PLUGIN.id}/config/([^/]+)$`)) : null;
    if (put) {
      const sid = put[1];
      const body = JSON.parse(String(init?.body)) as { config: Record<string, unknown> };
      putBodies.push(body);
      if (putReply.success) {
        // The server drops an empty override, so the session inherits Global again.
        sessionConfig = { ...sessionConfig };
        if (Object.keys(body.config).length === 0) delete sessionConfig[sid];
        else sessionConfig[sid] = body.config;
      }
      const reply = putReply;
      return (putGate ?? Promise.resolve()).then(() => jsonResponse(reply));
    }
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // useTheme reads the colour-scheme media query; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  sessionConfig = {};
  putReply = { success: false, message: REJECTION };
  putBodies = [];
  putGate = undefined;
  pluginOverride = {};
  catalogReply = () => Promise.resolve(jsonResponse([]));
  catalogReads = 0;
  extraPlugins = [];
  disableGate = undefined;
  pluginListFails = false;
  deleteReply = { success: true, message: UNINSTALLED };
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderPlugins(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );
}

async function openSessionOverride(sessionLabel: string): Promise<void> {
  const { screen, fireEvent, findByText } = rtl;
  renderPlugins();

  fireEvent.click(await screen.findByTitle('Configure'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Sessions' }));
  const select = await screen.findByRole('combobox', { name: 'Select a session…' });
  await findByText(select, sessionLabel);
  fireEvent.change(select, { target: { value: SESSION.id } });
}

// A failed read says nothing about what is installed: the banner is the only message, and the page must not
// count zero plugins or tell the operator to install one.
test('a failed first plugin read shows the error, not an empty install base', async () => {
  const { screen } = rtl;
  pluginListFails = true;
  renderPlugins();

  await screen.findByText('plugin registry unavailable');
  assert.equal(screen.queryByText('No plugins installed') === null, true, 'a failed read claimed nothing is installed');
  assert.equal(screen.queryByText('None enabled yet') === null, true, 'a failed read claimed nothing is enabled');
  const counts = Array.from(document.querySelectorAll('.rail-stat-num')).map(node => node.textContent);
  assert.deepEqual(counts, ['-', '-'], 'the rail counted plugins it could not read');
});

test('a failed refetch keeps the installed plugins and their counts', async () => {
  const { screen, act } = rtl;
  renderPlugins();
  await screen.findByTitle('Configure');

  pluginListFails = true;
  await act(() => queryClient!.refetchQueries({ queryKey: ['plugins'] }));

  await screen.findByText('plugin registry unavailable');
  assert.ok(screen.queryByTitle('Configure'), 'the failed refetch dropped the installed plugin');
  const counts = Array.from(document.querySelectorAll('.rail-stat-num')).map(node => node.textContent);
  assert.deepEqual(counts, ['1', '1']);
});

test('a per-session override the server rejects reports the failure, not "Saved"', async () => {
  const { screen, fireEvent } = rtl;
  await openSessionOverride('Main');
  fireEvent.click(await screen.findByRole('button', { name: 'Save override' }));

  await screen.findByText(REJECTION);
  assert.equal(screen.queryByText('Configuration Saved') === null, true);
});

test('clearing an override shows the Global values, so the next save does not pin the cleared ones back', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  sessionConfig = { [SESSION.id]: { greeting: 'hi' } };
  putReply = { success: true };
  await openSessionOverride('Main ●');
  const field = await screen.findByLabelText<HTMLInputElement>('Greeting');
  assert.equal(field.value, 'hi');

  fireEvent.click(screen.getByRole('button', { name: 'Clear override' }));
  await waitFor(() => assert.equal(putBodies.length, 1));
  await waitFor(() => assert.equal(field.value, 'hello'));

  await waitFor(() =>
    assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Save override' }).disabled, false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save override' }));
  await waitFor(() => assert.equal(putBodies.length, 2));
  assert.deepEqual(putBodies, [{ config: {} }, { config: {} }]);
});

test('a clear that answers after the operator switched sessions leaves the new session on its own values', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  sessionConfig = { [SESSION.id]: { greeting: 'hi' }, [SESSION_2.id]: { greeting: 'hey' } };
  putReply = { success: true };
  let releasePut!: () => void;
  putGate = new Promise(resolve => (releasePut = resolve));
  await openSessionOverride('Main ●');
  const field = await screen.findByLabelText<HTMLInputElement>('Greeting');
  assert.equal(field.value, 'hi');

  fireEvent.click(screen.getByRole('button', { name: 'Clear override' }));
  await waitFor(() => assert.equal(putBodies.length, 1));
  fireEvent.change(screen.getByRole('combobox', { name: 'Select a session…' }), { target: { value: SESSION_2.id } });
  await waitFor(() => assert.equal(screen.getByLabelText<HTMLInputElement>('Greeting').value, 'hey'));

  releasePut();
  await screen.findByText('Configuration Saved');
  assert.equal(screen.getByLabelText<HTMLInputElement>('Greeting').value, 'hey');
});

test('a catalog prefetch that fails after the Catalog tab opened shows the error with a retry', async () => {
  const { screen, fireEvent } = rtl;
  let failCatalog!: () => void;
  catalogReply = () =>
    new Promise(resolve => (failCatalog = () => resolve(jsonResponse({ message: 'catalog unreachable' }, 502))));
  renderPlugins();
  await screen.findByTitle('Configure');
  fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }));
  fireEvent.click(document.querySelectorAll<HTMLButtonElement>('.install-tab')[1]);
  await screen.findByText(/Install directly from the OpenWA plugin catalog/);

  failCatalog();
  const message = await screen.findByText(/catalog unreachable/);
  assert.ok(rtl.within(message).getByRole('button', { name: 'Refresh' }));
  assert.equal(screen.queryByText('No plugins in the catalog.') === null, true);
});

test('uninstalling a plugin reloads the catalog, whose installed flags it changed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const realConfirm = window.confirm;
  window.confirm = () => true;
  try {
    renderPlugins();
    await waitFor(() => assert.equal(catalogReads, 1));
    fireEvent.click(await screen.findByTitle('Uninstall'));
    await screen.findByText('Plugin uninstalled');
    await waitFor(() => assert.equal(catalogReads, 2));
  } finally {
    window.confirm = realConfirm;
  }
});

/** Click Uninstall, wait for the toast titled `title` and for the refetches the uninstall started to settle. */
async function uninstallAndReadToast(title: string): Promise<Element> {
  const { screen, fireEvent, waitFor } = rtl;
  const realConfirm = window.confirm;
  window.confirm = () => true;
  try {
    renderPlugins();
    await waitFor(() => assert.equal(catalogReads, 1));
    fireEvent.click(await screen.findByTitle('Uninstall'));
    const toast = (await screen.findByText(title)).closest('.toast');
    assert.ok(toast, `no toast titled ${title}`);
    await waitFor(() => assert.equal(catalogReads, 2));
    await waitFor(() => assert.equal(queryClient?.isFetching(), 0));
    return toast;
  } finally {
    window.confirm = realConfirm;
  }
}

// A complete removal names the plugin as the operator's language shows it, not the server's English sentence.
test('a plain uninstall answer shows the localized plugin name, not the server text', async () => {
  pluginOverride = { i18n: { en: { name: 'Welcome bot' } } };

  const toast = await uninstallAndReadToast('Plugin uninstalled');

  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.querySelector('.toast-message')?.textContent, 'Welcome bot');
  assert.ok(!toast.textContent?.includes(UNINSTALLED), toast.textContent ?? '');
});

// When only the final registry delete fails the uninstall still answers success, with a message naming the call that
// removes the entry it left. The plugin's card is gone by then, so that message is the operator's only pointer.
test('an uninstall that kept its registry entry warns with the answer that says how to remove it', async () => {
  const kept =
    'Plugin greeter uninstalled, but the plugin registry could not be written: registry.json keeps its entry, ' +
    'emptied of config, sessions and the enable decision, reported at startup as a plugin with no code ' +
    'until DELETE /api/plugins/greeter is repeated once the registry is writable';
  deleteReply = { success: true, message: kept };

  const toast = await uninstallAndReadToast('Plugin uninstalled, with a warning');

  assert.equal(toast.getAttribute('role'), 'alert');
  assert.equal(toast.querySelector('.toast-message')?.textContent, kept);
});

// The mount prefetch can still be in flight when a later read starts; its older answer must not replace the newer one.
test('a catalog read that finishes after a newer one does not replace it', async () => {
  const { screen, fireEvent, waitFor, act } = rtl;
  const entry = (updateAvailable: boolean) => ({
    id: PLUGIN.id,
    name: 'Greeter',
    version: updateAvailable ? '2.0.0' : '1.0.0',
    installed: true,
    installedVersion: '1.0.0',
    updateAvailable,
    download: 'https://example.invalid/greeter.zip',
  });
  let releaseFirst!: () => void;
  catalogReply = () =>
    catalogReads === 1
      ? new Promise(resolve => (releaseFirst = () => resolve(jsonResponse([entry(true)]))))
      : Promise.resolve(jsonResponse([entry(false)]));
  const realConfirm = window.confirm;
  window.confirm = () => true;
  try {
    renderPlugins();
    await waitFor(() => assert.equal(catalogReads, 1));
    fireEvent.click(await screen.findByTitle('Uninstall'));
    await waitFor(() => assert.equal(catalogReads, 2));
    await screen.findByText('Plugin uninstalled');
    await act(async () => {
      releaseFirst();
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(document.querySelector('.plugin-update-chip') === null, true, 'the older read replaced the newer');
  } finally {
    window.confirm = realConfirm;
  }
});

test('uploading a plugin .zip reloads the catalog, whose installed flags it changed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPlugins();
  await waitFor(() => assert.equal(catalogReads, 1));
  fireEvent.click(await screen.findByRole('button', { name: 'Install plugin' }));
  const input = document.querySelector<HTMLInputElement>('.install-drop input[type="file"]');
  assert.ok(input);
  fireEvent.change(input, { target: { files: [new File(['zip'], 'greeter.zip', { type: 'application/zip' })] } });
  await screen.findByText('greeter.zip');
  const submit = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Install plugin' }).at(-1);
  assert.ok(submit && !submit.disabled);
  fireEvent.click(submit);
  await screen.findByText('Plugin installed');
  await waitFor(() => assert.equal(catalogReads, 2));
});

test('a config schema without properties opens the config modal and the Sessions tab', async () => {
  const { screen, fireEvent } = rtl;
  pluginOverride = { configSchema: { type: 'object' } };
  renderPlugins();
  fireEvent.click(await screen.findByTitle('Configure'));
  assert.equal(screen.queryByRole('button', { name: 'Save Configuration' }) === null, true);
  fireEvent.click(await screen.findByRole('tab', { name: 'Sessions' }));
  // No declared field means nothing to override per session.
  await screen.findByText('Run for');
  assert.equal(screen.queryByRole('combobox', { name: 'Select a session…' }) === null, true);
});

// The gateway keeps a stored secret for the mask and for an empty string; only an explicit null removes it.
// A secret textarea (a PEM key, a service-account JSON) is cleared the same way as a secret text field.
test('clearing a stored secret textarea saves null, as clearing a secret text field does', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  pluginOverride = {
    config: { pem: '***', token: '***' },
    configSchema: {
      type: 'object',
      properties: {
        pem: { type: 'textarea', title: 'Private key', secret: true },
        token: { type: 'string', title: 'Token', secret: true },
      },
    },
  };
  putReply = { success: true };
  renderPlugins();
  fireEvent.click(await screen.findByTitle('Configure'));
  const pem = await screen.findByLabelText<HTMLTextAreaElement>('Private key');
  assert.equal(pem.value, '***');

  fireEvent.change(pem, { target: { value: '' } });
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('Token'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => assert.equal(putBodies.length, 1));
  assert.deepEqual(putBodies, [{ config: { pem: null, token: null } }]);
});

test('a typed secret textarea is saved as typed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  pluginOverride = {
    config: { pem: '***' },
    configSchema: { type: 'object', properties: { pem: { type: 'textarea', title: 'Private key', secret: true } } },
  };
  putReply = { success: true };
  renderPlugins();
  fireEvent.click(await screen.findByTitle('Configure'));
  fireEvent.change(await screen.findByLabelText('Private key'), { target: { value: 'NEW-KEY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => assert.equal(putBodies.length, 1));
  assert.deepEqual(putBodies, [{ config: { pem: 'NEW-KEY' } }]);
});

// A stored secret reads back as the mask '***', which no pattern describes. The form holds it untouched,
// and the browser checks a pattern against whatever the field holds, so the save was refused on a field
// the operator never edited.
const PATTERNED_SECRET = {
  config: { greeting: 'hello', token: '***' },
  configSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', title: 'Greeting' },
      token: { type: 'string', title: 'Token', secret: true, required: true, pattern: '^tok_[a-z0-9]+$' },
    },
  },
};

test('a stored secret with a pattern is saved without retyping it', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  pluginOverride = PATTERNED_SECRET;
  putReply = { success: true };
  renderPlugins();
  fireEvent.click(await screen.findByTitle('Configure'));
  fireEvent.change(await screen.findByLabelText('Greeting'), { target: { value: 'hi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => assert.equal(putBodies.length, 1));
  assert.deepEqual(putBodies, [{ config: { greeting: 'hi', token: '***' } }]);
});

test('a stored secret with a pattern does not block the per-session override save', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  pluginOverride = PATTERNED_SECRET;
  putReply = { success: true };
  await openSessionOverride('Main');
  fireEvent.change(await screen.findByLabelText('Greeting'), { target: { value: 'hi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save override' }));

  await waitFor(() => assert.equal(putBodies.length, 1));
  assert.equal((putBodies[0] as { config: { greeting?: string } }).config.greeting, 'hi');
});

test('a secret typed over the stored one is still held to its pattern', async () => {
  const { screen, fireEvent } = rtl;
  pluginOverride = PATTERNED_SECRET;
  renderPlugins();
  fireEvent.click(await screen.findByTitle('Configure'));
  const token = await screen.findByLabelText<HTMLInputElement>(/Token/);
  assert.equal(token.validity.patternMismatch, false);

  fireEvent.change(token, { target: { value: 'nope' } });
  assert.equal(token.validity.patternMismatch, true);
  fireEvent.change(token, { target: { value: 'tok_abc1' } });
  assert.equal(token.validity.valid, true);
});

test('a fractional value in a bounded number field does not block the override save', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  pluginOverride = {
    config: { threshold: 0.7 },
    configSchema: { type: 'object', properties: { threshold: { type: 'number', title: 'Threshold', min: 0, max: 1 } } },
  };
  putReply = { success: true };
  await openSessionOverride('Main');
  const field = await screen.findByLabelText<HTMLInputElement>('Threshold');
  assert.equal(field.value, '0.7');
  fireEvent.change(field, { target: { value: '0.5' } });

  fireEvent.click(screen.getByRole('button', { name: 'Save override' }));
  await waitFor(() => assert.equal(putBodies.length, 1));
  assert.deepEqual(putBodies, [{ config: { threshold: 0.5 } }]);
});

test("another plugin's action settling first keeps a pending plugin's buttons disabled", async () => {
  const { screen, fireEvent, within } = rtl;
  extraPlugins = [{ ...PLUGIN, id: 'echo', name: 'Echo', configSchema: undefined, sessionScoped: false }];
  let releaseDisable!: () => void;
  disableGate = new Promise(resolve => (releaseDisable = resolve));
  renderPlugins();
  await rtl.waitFor(() => assert.equal(document.querySelectorAll('.plugin-card').length, 2));
  const [greeter, echo] = Array.from(document.querySelectorAll<HTMLElement>('.plugin-card'));
  const greeterToggle = within(greeter).getByRole<HTMLButtonElement>('button', { name: 'Disable' });

  fireEvent.click(greeterToggle);
  assert.equal(greeterToggle.disabled, true);
  fireEvent.click(within(echo).getByTitle('Health Check'));
  await screen.findByText('Health Check Passed');
  assert.equal(greeterToggle.disabled, true);
  assert.equal(within(greeter).getByTitle<HTMLButtonElement>('Uninstall').disabled, true);

  releaseDisable();
});
