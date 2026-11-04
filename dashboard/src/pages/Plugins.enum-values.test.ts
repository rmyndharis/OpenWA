import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Plugin } from '../services/api';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const PLUGIN: Plugin = {
  id: 'router',
  name: 'Router',
  version: '2.0.0',
  type: 'extension',
  status: 'disabled',
  config: { mode: 'legacy' },
  builtIn: false,
  provides: [],
  ingressCapable: false,
  configSchema: { type: 'object', properties: { mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] } } },
  sessionScoped: false,
  activeSessions: ['*'],
  sessionConfig: {},
};
let plugin: Plugin;

const putBodies: Array<{ config: Record<string, unknown> }> = [];

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
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
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') return Promise.resolve(jsonResponse([plugin]));
    if (path === '/api/sessions') {
      return Promise.resolve(jsonResponse([{ id: 's1', name: 'Main', status: 'ready' }]));
    }
    if (method === 'PUT' && path === `/api/plugins/${PLUGIN.id}/config`) {
      putBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse({ success: true, message: 'updated' }));
    }
    if (method === 'PUT' && path === `/api/plugins/${PLUGIN.id}/config/s1`) {
      putBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse({ success: true, message: 'updated' }));
    }
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

beforeEach(() => {
  plugin = structuredClone(PLUGIN);
  putBodies.length = 0;
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

test('the plugin config form saves the choice its select shows for a stored value the list no longer has', async () => {
  const select = await openConfig();
  const shown = select.options[select.selectedIndex]?.value ?? '(nothing)';
  // The stored value is listed ahead of the schema's choices and selected, not replaced by the first of them.
  assert.deepEqual(
    Array.from(select.options, option => option.value),
    ['legacy', 'fast', 'safe'],
  );
  assert.equal(shown, 'legacy');

  await saveConfig();
  assert.equal(putBodies[0].config.mode, shown);
});

async function openForm(): Promise<void> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );
  rtl.fireEvent.click(await rtl.screen.findByTitle('Configure'));
}

async function openConfig(): Promise<HTMLSelectElement> {
  await openForm();
  return rtl.screen.findByRole<HTMLSelectElement>('combobox', { name: 'Mode' });
}

async function saveConfig(): Promise<void> {
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save Configuration' }));
  await rtl.waitFor(() => assert.equal(putBodies.length, 1));
}

for (const value of [undefined, null]) {
  test(`a nested enum with ${String(value)} shows a blank option and preserves the stored object`, async () => {
    plugin.config = { options: value === undefined ? {} : { mode: null } };
    plugin.configSchema = {
      type: 'object',
      properties: {
        options: { type: 'object', properties: { mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] } } },
      },
    };
    const select = await openConfig();
    assert.equal(select.value, '');
    assert.equal(select.selectedOptions[0].textContent, '');
    await saveConfig();
    assert.deepEqual(putBodies[0].config.options, plugin.config.options);
  });
}

test('an explicit null enum shows a blank option instead of its schema default', async () => {
  plugin.config = { mode: null };
  const select = await openConfig();
  assert.equal(select.value, '');
  await saveConfig();
  assert.equal(putBodies[0].config.mode, null);
});

// Only a field with a choice list keeps a stored null (its select shows a blank option). Any other field reads null as
// unset: a default shows and is what a save sends, and a field with no default seeds its blank.
test('a stored null on a field without a choice list shows and saves its default', async () => {
  plugin.config = { count: null, name: null, enabled: null, plain: null, bare: null, list: null };
  plugin.configSchema = {
    type: 'object',
    properties: {
      count: { type: 'number', title: 'Count', default: 5 },
      name: { type: 'string', title: 'Name', default: 'x' },
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      plain: { type: 'string', title: 'Plain' },
      bare: { type: 'boolean', title: 'Bare' },
      list: { type: 'array', title: 'List', items: { type: 'string' } },
    },
  };
  await openForm();
  assert.equal((await rtl.screen.findByLabelText<HTMLInputElement>('Count')).value, '5');
  assert.equal(rtl.screen.getByLabelText<HTMLInputElement>('Name').value, 'x');
  assert.equal(rtl.screen.getByRole<HTMLInputElement>('checkbox', { name: 'Enabled' }).checked, true);
  assert.equal(rtl.screen.getByLabelText<HTMLInputElement>('Plain').value, '');
  assert.equal(rtl.screen.getByRole<HTMLInputElement>('checkbox', { name: 'Bare' }).checked, false);

  await saveConfig();
  assert.deepEqual(putBodies[0].config, { count: 5, name: 'x', enabled: true, plain: '', bare: false, list: [] });
});

test('an absent fresh enum still starts with the first schema choice', async () => {
  plugin.config = {};
  const select = await openConfig();
  assert.equal(select.value, 'fast');
  await saveConfig();
  assert.equal(putBodies[0].config.mode, 'fast');
});

test('reselecting a stale numeric choice restores its original type', async () => {
  plugin.config = { mode: 0 };
  plugin.configSchema = { type: 'object', properties: { mode: { type: 'number', title: 'Mode', enum: [1, 2] } } };
  const select = await openConfig();
  assert.equal(select.value, '0');
  rtl.fireEvent.change(select, { target: { value: '0' } });
  await saveConfig();
  assert.equal(putBodies[0].config.mode, 0);
});

// The reseed after a cleared override is the seed with an empty override, so a stored null choice reads the same.
test('clearing a session override shows a stored null choice as blank, and the next save pins nothing', async () => {
  plugin.sessionScoped = true;
  plugin.config = { mode: null };
  plugin.sessionConfig = { s1: { mode: 'safe' } };
  await openConfig();
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'Sessions' }));
  const sessionSelect = await rtl.screen.findByRole<HTMLSelectElement>('combobox', { name: /Select a session/ });
  await rtl.findByText(sessionSelect, 'Main ●');
  rtl.fireEvent.change(sessionSelect, { target: { value: 's1' } });
  const modeSelect = () => rtl.screen.getByRole<HTMLSelectElement>('combobox', { name: 'Mode' });
  await rtl.waitFor(() => assert.equal(modeSelect().value, 'safe'));

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Clear override' }));
  await rtl.waitFor(() => assert.equal(putBodies.length, 1));
  await rtl.waitFor(() => assert.equal(modeSelect().value, ''));
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save override' }));
  await rtl.waitFor(() => assert.equal(putBodies.length, 2));
  assert.deepEqual(putBodies, [{ config: {} }, { config: {} }]);
});

test('the per-session form displays an inherited stale enum and leaves it inherited on save', async () => {
  plugin.sessionScoped = true;
  await openConfig();
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'Sessions' }));
  const sessionSelect = await rtl.screen.findByRole<HTMLSelectElement>('combobox', { name: /Select a session/ });
  await rtl.findByText(sessionSelect, 'Main');
  rtl.fireEvent.change(sessionSelect, { target: { value: 's1' } });
  const select = await rtl.screen.findByRole<HTMLSelectElement>('combobox', { name: 'Mode' });
  assert.equal(select.value, 'legacy');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save override' }));
  await rtl.waitFor(() => assert.equal(putBodies.length, 1));
  assert.deepEqual(putBodies[0].config, {});
});
