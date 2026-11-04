import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18nReady } from '../i18n/index.ts';
import i18next from 'i18next';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

import type { Plugin } from '../services/api';

const pluginHtml = '<p>Editor</p>';
let pluginsList: Plugin[] = [];
// What the config route answered, and every body it was sent.
let putReply: { success: boolean; message?: string } = { success: true };
let putBodies: unknown[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'PUT' && path === '/api/plugins/p1/config') {
      putBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(jsonResponse(putReply));
    }
    if (path === '/api/plugins') return Promise.resolve(jsonResponse(pluginsList));
    if (path.startsWith('/api/plugins/p1/config-ui')) return Promise.resolve(new Response(pluginHtml, { status: 200 }));
    if (path === '/api/plugins/catalog') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();

  // Mock matchMedia for useTheme
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {}, // Deprecated
      removeListener: () => {}, // Deprecated
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  installFetchStub();
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  pluginsList = [];
  putReply = { success: true };
  putBodies = [];
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

test('PluginConfigUi localizes its frame title and replies to config:get with localized schema and locale', async () => {
  // Set the dashboard language so we can verify the schema gets localized
  await i18next.changeLanguage('es');

  pluginsList = [
    {
      id: 'p1',
      name: 'Plugin 1',
      type: 'extension',
      config: {},
      configUi: { entry: 'ui.html' },
      configSchema: {
        type: 'object',
        properties: {
          field1: { type: 'string', title: 'English Title' },
        },
      },
      i18n: {
        es: {
          name: 'Mi complemento',
          config: {
            field1: { title: 'Spanish Title' },
          },
        },
      },
    } as unknown as Plugin,
  ];

  renderPlugins();

  // Wait for plugin list to load by finding the Configure button
  const configureButton = await rtl.screen.findByTitle('Configurar');

  // Open the configuration modal
  rtl.fireEvent.click(configureButton);

  // Wait for the iframe to be rendered
  const iframe = await rtl.waitFor(() => {
    const el = document.querySelector('iframe');
    assert.ok(el, 'ConfigUi iframe not found in DOM');
    return el;
  });
  // The frame's accessible name follows the localized modal title, not the raw manifest name.
  assert.equal(iframe.getAttribute('title'), 'Mi complemento', 'iframe title was not localized');

  // We spy on the iframe's contentWindow postMessage
  // JSDOM creates an empty contentWindow for the iframe
  interface ConfigMessage {
    type?: string;
    locale?: string;
    schema?: { properties: { field1: { title: string } } };
  }
  let postedMessage: ConfigMessage | null = null;
  iframe.contentWindow!.postMessage = (message: unknown) => {
    postedMessage = message as ConfigMessage;
  };

  // Dispatch the handshake message from the iframe to the window
  const messageEvent = new window.MessageEvent('message', {
    source: iframe.contentWindow as Window,
    data: { type: 'config:get' },
  });
  window.dispatchEvent(messageEvent);

  // Assert that PluginConfigUi replied with the correct schema and locale
  assert.ok(postedMessage, 'No postMessage received by iframe');
  const msg = postedMessage as ConfigMessage;
  assert.equal(msg.type, 'config:value');

  // Bug #1522: The schema must be localized and locale must be present
  assert.equal(msg.locale, 'es', 'locale was not sent in config:value');
  assert.equal(msg.schema?.properties.field1.title, 'Spanish Title', 'schema was not localized in config:value');
});

// The editor runs in a sandboxed frame; the bridge answers only that frame, because a save carries the operator's key.
async function openConfigUi(): Promise<{ iframe: HTMLIFrameElement; posted: Record<string, unknown>[] }> {
  await i18next.changeLanguage('en');
  pluginsList = [
    {
      id: 'p1',
      name: 'Plugin 1',
      type: 'extension',
      config: {},
      configUi: { entry: 'ui.html' },
      configSchema: { type: 'object', properties: { field1: { type: 'string', title: 'Field' } } },
    } as unknown as Plugin,
  ];
  renderPlugins();
  rtl.fireEvent.click(await rtl.screen.findByTitle('Configure'));
  const iframe = await rtl.waitFor(() => {
    const el = document.querySelector('iframe');
    assert.ok(el, 'ConfigUi iframe not found in DOM');
    return el;
  });
  const posted: Record<string, unknown>[] = [];
  iframe.contentWindow!.postMessage = (message: unknown) => {
    posted.push(message as Record<string, unknown>);
  };
  return { iframe, posted };
}

const messageFrom = (source: Window, data: unknown) =>
  window.dispatchEvent(new window.MessageEvent('message', { source, data }));

test('PluginConfigUi ignores a save that does not come from its own frame', async () => {
  const { iframe, posted } = await openConfigUi();

  messageFrom(window, { type: 'config:save', config: { field1: 'foreign' } });
  messageFrom(iframe.contentWindow as Window, { type: 'config:save', config: { field1: 'own' } });

  await rtl.waitFor(() => assert.equal(putBodies.length, 1));
  assert.deepEqual(putBodies, [{ config: { field1: 'own' } }]);
  await rtl.waitFor(() => assert.deepEqual(posted, [{ type: 'config:saved' }]));
});

test('PluginConfigUi answers config:error with the gateway message when a save is rejected', async () => {
  putReply = { success: false, message: 'Rejected by the plugin' };
  const { iframe, posted } = await openConfigUi();

  messageFrom(iframe.contentWindow as Window, { type: 'config:save', config: { field1: 'x' } });

  await rtl.waitFor(() => assert.deepEqual(posted, [{ type: 'config:error', message: 'Rejected by the plugin' }]));
  assert.deepEqual(putBodies, [{ config: { field1: 'x' } }]);
});
