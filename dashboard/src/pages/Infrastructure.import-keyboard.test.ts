// "Import data" restores a backup from a file chooser. A keyboard user reaches a control by Tab and opens it
// with Enter or Space, so the file input has to stay in the tab order: hidden from sight inside the button-styled
// label, not removed, and named by its text. The page's stylesheet is not loaded under jsdom, so its display
// rules are read from Infrastructure.css and applied to the rendered elements.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { decl, readRules } from '../test-helpers/css-rules.ts';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const STATUS = {
  database: { connected: true, type: 'sqlite', builtIn: false },
  redis: { enabled: false, connected: false, host: 'localhost', port: 6379, builtIn: false },
  queue: { enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 'local', path: './data/media', builtIn: false },
  engine: { type: 'baileys', headless: true },
};

const SAVED = {
  database: { type: 'sqlite', builtIn: false, builtInSet: true, passwordSet: false },
  redis: { enabled: false, builtIn: false, builtInSet: true, host: 'localhost', port: '6379', passwordSet: false },
  queue: { enabled: false },
  storage: { type: 'local', builtIn: false, builtInSet: true, localPath: './data/media', s3CredentialsSet: false },
  engine: { type: 'baileys', headless: true },
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/infra/status') return Promise.resolve(jsonResponse(STATUS));
    if (method === 'GET' && path === '/api/infra/config') return Promise.resolve(jsonResponse(SAVED));
    if (method === 'GET' && path === '/api/infra/engines') {
      return Promise.resolve(jsonResponse([{ id: 'baileys', name: 'Baileys', enabled: true, features: [] }]));
    }
    if (method === 'GET' && path === '/api/infra/engines/current') {
      return Promise.resolve(jsonResponse({ engineType: 'baileys' }));
    }
    if (method === 'PUT' && path === '/api/infra/config') {
      return Promise.resolve(
        jsonResponse({ message: 'Configuration saved', saved: true, envPath: '.env.generated', profiles: [] }),
      );
    }
    if (method === 'GET' && path === '/api/infra/export-data') {
      return new Promise(resolve =>
        setImmediate(() =>
          resolve(
            jsonResponse({ exportedAt: '2026-10-09T10:00:00.000Z', dataDbType: 'sqlite', tables: {}, counts: {} }),
          ),
        ),
      );
    }
    if (method === 'POST' && path === '/api/infra/import-data') {
      return new Promise(resolve =>
        setImmediate(() => resolve(jsonResponse({ imported: true, counts: {}, warnings: [] }, 201))),
      );
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Infrastructure: (typeof import('./Infrastructure.tsx'))['Infrastructure'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;
let confirmOriginal: typeof window.confirm;
let anchorClickOriginal: typeof HTMLAnchorElement.prototype.click;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // HTML focus fixup rule: disabling the focused control drops focus to the document body (jsdom does not
  // run focus fixup when disabled is set, and its blur() is a no-op once the attribute is already present).
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (name.toLowerCase() === 'disabled' && document.activeElement === this) (this as HTMLElement).blur();
    setAttr.call(this, name, value);
  };
  for (const Ctor of [HTMLInputElement, HTMLButtonElement]) {
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'disabled')!;
    Object.defineProperty(Ctor.prototype, 'disabled', {
      ...desc,
      set(this: HTMLElement, value: boolean) {
        if (value && document.activeElement === this) this.blur();
        desc.set!.call(this, value);
      },
    });
  }
  confirmOriginal = window.confirm;
  anchorClickOriginal = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => 'blob:backup';
  URL.revokeObjectURL = () => {};
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Infrastructure } = await import('./Infrastructure.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  window.confirm = confirmOriginal;
  HTMLAnchorElement.prototype.click = anchorClickOriginal;
  window.sessionStorage.removeItem('openwa_api_key');
});

// Every top-level rule of the page's stylesheet that sets display: none.
const hiddenSelectors = readRules(new URL('./Infrastructure.css', import.meta.url))
  .filter(rule => rule.media === '' && decl(rule.body, 'display') === 'none')
  .flatMap(rule => rule.selectors);

/** The text of the label of the focused field, or what has focus instead. */
function focusedLabel(): string {
  const active = document.activeElement as HTMLInputElement | null;
  if (!active || active === document.body) return 'body';
  return active.labels?.[0]?.textContent?.trim() || `${active.tagName.toLowerCase()} without a label`;
}

function inTabOrder(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled || el.tabIndex < 0) return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none') return false;
    if (hiddenSelectors.some(selector => node!.matches(selector))) return false;
  }
  return true;
}

test('the backup file chooser of Import data can be opened from the keyboard', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  await rtl.screen.findByText('Import data');
  const chooser = rtl.screen.getByLabelText('Import data') as HTMLInputElement;
  assert.equal(chooser.type, 'file');
  assert.ok(
    inTabOrder(chooser),
    'Import data is a label around a display: none input, and neither takes keyboard focus',
  );
  // Named by the button's text, so a screen reader says what Space or Enter opens.
  chooser.focus();
  assert.equal(focusedLabel(), 'Import data');
});

test('keyboard focus stays on Import data after a backup file is imported', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  window.confirm = () => true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  await rtl.screen.findByText('Import data');
  const chooser = rtl.screen.getByLabelText('Import data') as HTMLInputElement;
  chooser.focus();
  assert.equal(focusedLabel(), 'Import data');

  const file = new File([JSON.stringify({ tables: { sessions: [{ id: 's1' }] } })], 'backup.json', {
    type: 'application/json',
  });
  rtl.fireEvent.change(chooser, { target: { files: [file] } });
  await rtl.waitFor(() => assert.equal(chooser.disabled, true));
  await rtl.waitFor(() => assert.equal(chooser.disabled, false));
  // The page restores focus in an effect after the commit that re-enables the chooser.
  await rtl.waitFor(() => assert.equal(focusedLabel(), 'Import data'));
});

test('keyboard focus returns to Import data when the import confirmation is declined', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  window.confirm = () => false;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  await rtl.screen.findByText('Import data');
  const chooser = rtl.screen.getByLabelText('Import data') as HTMLInputElement;
  chooser.focus();
  assert.equal(focusedLabel(), 'Import data');

  const file = new File([JSON.stringify({ tables: { sessions: [{ id: 's1' }] } })], 'backup.json', {
    type: 'application/json',
  });
  rtl.fireEvent.change(chooser, { target: { files: [file] } });
  await rtl.waitFor(() => assert.equal(chooser.disabled, false));
  // The page restores focus in an effect after the commit that re-enables the chooser.
  await rtl.waitFor(() => assert.equal(focusedLabel(), 'Import data'));
});

test('keyboard focus stays on Export data after a backup is exported', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  HTMLAnchorElement.prototype.click = () => {};
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  const exportBtn = (await rtl.screen.findByRole('button', { name: 'Export data' })) as HTMLButtonElement;
  exportBtn.focus();
  assert.equal(document.activeElement?.textContent?.trim(), 'Export data');

  rtl.fireEvent.click(exportBtn);
  await rtl.waitFor(() => assert.equal(exportBtn.disabled, true));
  await rtl.waitFor(() => assert.equal(exportBtn.disabled, false));
  // The page restores focus in an effect after the commit that re-enables the button.
  await rtl.waitFor(() =>
    assert.equal(
      document.activeElement === document.body ? 'body' : document.activeElement?.textContent?.trim(),
      'Export data',
    ),
  );
});

test('restoring focus after a backup export does not scroll the page back to the button', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  HTMLAnchorElement.prototype.click = () => {};
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  const exportBtn = (await rtl.screen.findByRole('button', { name: 'Export data' })) as HTMLButtonElement;
  exportBtn.focus();
  const focusOriginal = HTMLElement.prototype.focus;
  const focusOptions: Array<FocusOptions | undefined> = [];
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    focusOptions.push(options);
    focusOriginal.call(this, options);
  };
  try {
    rtl.fireEvent.click(exportBtn);
    await rtl.waitFor(() => assert.equal(exportBtn.disabled, true));
    await rtl.waitFor(() => assert.equal(exportBtn.disabled, false));
    await rtl.waitFor(() => assert.equal(document.activeElement?.textContent?.trim(), 'Export data'));
  } finally {
    HTMLElement.prototype.focus = focusOriginal;
  }
  // React's own commit-time focus restore comes first, with no options; the page's effect runs after the commit.
  assert.deepEqual(focusOptions.at(-1), { preventScroll: true });
});

test('keyboard focus stays on Download backup first in the restart modal after a backup is exported', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  HTMLAnchorElement.prototype.click = () => {};
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  await rtl.screen.findByRole('button', { name: 'Export data' });
  const pgRadio = container.querySelectorAll('input[name="dbType"]')[1] as HTMLInputElement;
  rtl.fireEvent.click(pgRadio);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save Configuration' }));

  const restartBackupBtn = (await rtl.screen.findByRole('button', {
    name: 'Download backup first',
  })) as HTMLButtonElement;
  restartBackupBtn.focus();
  assert.equal(document.activeElement?.textContent?.trim(), 'Download backup first');

  rtl.fireEvent.click(restartBackupBtn);
  await rtl.waitFor(() => assert.equal(restartBackupBtn.disabled, true));
  await rtl.waitFor(() => assert.equal(restartBackupBtn.disabled, false));
  assert.equal(
    document.activeElement === document.body ? 'body' : document.activeElement?.textContent?.trim(),
    'Download backup first',
  );
});

test('moving keyboard focus to another control while a backup export runs does not steal focus back', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'test-admin-key');
  HTMLAnchorElement.prototype.click = () => {};
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  const exportBtn = (await rtl.screen.findByRole('button', { name: 'Export data' })) as HTMLButtonElement;
  const saveBtn = rtl.screen.getByRole('button', { name: 'Save Configuration' }) as HTMLButtonElement;
  exportBtn.focus();
  rtl.fireEvent.click(exportBtn);
  await rtl.waitFor(() => assert.equal(exportBtn.disabled, true));
  saveBtn.focus();
  await rtl.waitFor(() => assert.equal(exportBtn.disabled, false));
  assert.equal(document.activeElement?.textContent?.trim(), 'Save Configuration');
});
