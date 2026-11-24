import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let rtl: typeof import('@testing-library/react');
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let Plugins: (typeof import('./Plugins.tsx'))['default'];
const realFetch = globalThis.fetch;
let activeClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  window.sessionStorage.setItem('openwa_api_key_id', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  activeClient?.clear();
  activeClient = undefined;
});

after(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderPlugins() {
  activeClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: activeClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );
}

test('PluginConfigUi config:save rejects non-object payloads without sending PUT', async () => {
  let putCalls = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/plugins')) {
      return Promise.resolve(
        json([
          {
            id: 'p1',
            name: 'P1',
            version: '1.0.0',
            description: 'Plugin',
            enabled: true,
            status: 'active',
            sessionScoped: false,
            configUi: { entry: 'config/index.html', height: 320 },
          },
        ]),
      );
    }
    if (url.endsWith('/config-ui')) {
      return Promise.resolve(new Response('<!doctype html><html><body><p>UI</p></body></html>', { status: 200 }));
    }
    if (url.endsWith('/config') && method === 'PUT') {
      putCalls += 1;
      return Promise.resolve(json({ success: true, message: 'ok' }));
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  renderPlugins();

  const configureBtn = await rtl.screen.findByRole('button', { name: 'Configure' });
  rtl.fireEvent.click(configureBtn);

  const iframe = (await rtl.waitFor(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe.plugin-config-ui-frame');
    assert.ok(el?.getAttribute('srcdoc'));
    return el;
  })) as HTMLIFrameElement;

  const posted: unknown[] = [];
  const fakeWindow = {
    postMessage: (msg: unknown) => posted.push(msg),
  } as unknown as Window;
  Object.defineProperty(iframe, 'contentWindow', { value: fakeWindow, configurable: true });

  await rtl.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: ['bad'] }, source: fakeWindow }),
    );
  });
  await rtl.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: 'bad' }, source: fakeWindow }),
    );
  });

  assert.equal(putCalls, 0);
  assert.equal(
    posted.filter(m => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'config:error').length,
    2,
  );
});

test('Install modal locks dismissal, tab switching, and concurrent installs while catalog install is in flight', async () => {
  let releaseInstall!: () => void;
  let installCalls = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/plugins')) return Promise.resolve(json([]));
    if (url.endsWith('/api/plugins/catalog')) {
      return Promise.resolve(
        json([
          { id: 'cat-1', name: 'Cat One', version: '1.0.0', download: 'https://example.com/1.zip', installed: false },
          { id: 'cat-2', name: 'Cat Two', version: '1.0.0', download: 'https://example.com/2.zip', installed: false },
        ]),
      );
    }
    if (url.endsWith('/api/plugins/install-url') && method === 'POST') {
      installCalls += 1;
      return new Promise<Response>(resolve => {
        releaseInstall = () => resolve(json({ id: 'cat-1', name: 'Cat One', version: '1.0.0' }));
      });
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  renderPlugins();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Install plugin' }));
  const uploadTab = rtl.screen.getByRole('tab', { name: /Upload/i }) as HTMLButtonElement;
  const catalogTab = rtl.screen.getByRole('tab', { name: /Catalog/i }) as HTMLButtonElement;
  rtl.fireEvent.click(catalogTab);

  await rtl.screen.findByText('Cat One');
  const installBtns = rtl.screen.getAllByRole('button', { name: 'Install' }) as HTMLButtonElement[];
  assert.equal(installBtns.length, 2);

  rtl.fireEvent.click(installBtns[0]);
  await rtl.waitFor(() => assert.equal(installCalls, 1));

  // Header close button hidden, footer Close disabled, tabs disabled, and second catalog install disabled.
  assert.equal(document.querySelector('.modal-header .btn-icon'), null);
  const closeBtn = rtl.screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
  assert.equal(closeBtn.disabled, true);
  assert.equal(uploadTab.disabled, true);
  assert.equal(catalogTab.disabled, true);
  assert.equal(installBtns[1].disabled, true);

  rtl.fireEvent.click(uploadTab);
  rtl.fireEvent.click(installBtns[1]);
  rtl.fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(catalogTab.getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('.install-modal'));
  assert.equal(installCalls, 1);

  await rtl.act(async () => {
    releaseInstall();
  });
  await rtl.waitFor(() => assert.equal(uploadTab.disabled, false));
  assert.ok(document.querySelector('.modal-header .btn-icon'));
  assert.equal(closeBtn.disabled, false);
});

test('Config modal locks dismissal and tab switching during iframe config:save, blocks duplicate saves, and skips post after unmount', async () => {
  let putCalls = 0;
  let releasePut!: () => void;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/plugins')) {
      return Promise.resolve(
        json([
          {
            id: 'p1',
            name: 'P1',
            version: '1.0.0',
            type: 'extension',
            description: 'Plugin',
            enabled: true,
            status: 'enabled',
            config: {},
            sessionScoped: true,
            activeSessions: ['*'],
            configSchema: { type: 'object', properties: { token: { type: 'string' } } },
            configUi: { entry: 'config/index.html', height: 320 },
          },
        ]),
      );
    }
    if (url.endsWith('/api/sessions')) return Promise.resolve(json([]));
    if (url.endsWith('/config-ui')) {
      return Promise.resolve(new Response('<!doctype html><html><body><p>UI</p></body></html>', { status: 200 }));
    }
    if (url.endsWith('/config') && method === 'PUT') {
      putCalls += 1;
      return new Promise<Response>(resolve => {
        releasePut = () => resolve(json({ success: true, message: 'ok' }));
      });
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  const view = renderPlugins();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Configure' }));
  const iframe = (await rtl.waitFor(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe.plugin-config-ui-frame');
    assert.ok(el?.getAttribute('srcdoc'));
    return el;
  })) as HTMLIFrameElement;

  const posted: unknown[] = [];
  const fakeWindow = { postMessage: (msg: unknown) => posted.push(msg) } as unknown as Window;
  Object.defineProperty(iframe, 'contentWindow', { value: fakeWindow, configurable: true });

  await rtl.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: { token: 'a' } }, source: fakeWindow }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: { token: 'b' } }, source: fakeWindow }),
    );
  });

  assert.equal(putCalls, 1);
  const configTab = rtl.screen.getByRole('tab', { name: 'Configuration' }) as HTMLButtonElement;
  const sessionsTab = rtl.screen.getByRole('tab', { name: 'Sessions' }) as HTMLButtonElement;
  const closeBtns = rtl.screen.getAllByRole('button', { name: 'Close' }) as HTMLButtonElement[];
  assert.equal(closeBtns.length, 1);
  assert.equal(closeBtns[0].disabled, true);
  assert.equal(configTab.disabled, true);
  assert.equal(sessionsTab.disabled, true);

  rtl.fireEvent.click(sessionsTab);
  rtl.fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(configTab.getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('.config-modal'));

  await rtl.act(async () => {
    releasePut();
  });
  await rtl.waitFor(() => assert.equal(sessionsTab.disabled, false));
  assert.equal(posted.filter(m => (m as { type?: string }).type === 'config:saved').length, 1);

  // Start another save and unmount before it settles: no late config:saved message should be posted.
  await rtl.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: { token: 'c' } }, source: fakeWindow }),
    );
  });
  assert.equal(putCalls, 2);
  view.unmount();
  await rtl.act(async () => {
    releasePut();
  });
  assert.equal(posted.filter(m => (m as { type?: string }).type === 'config:saved').length, 1);
});

test('Config modal locks dismissal and tab switching while SessionsTab activation save is in flight', async () => {
  let releaseSessions!: () => void;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/plugins')) {
      return Promise.resolve(
        json([
          {
            id: 'p1',
            name: 'P1',
            version: '1.0.0',
            type: 'extension',
            description: 'Plugin',
            enabled: true,
            status: 'enabled',
            config: {},
            sessionScoped: true,
            activeSessions: ['*'],
            configSchema: { type: 'object', properties: { token: { type: 'string' } } },
          },
        ]),
      );
    }
    if (url.endsWith('/api/sessions')) {
      return Promise.resolve(json([{ id: 's1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00Z' }]));
    }
    if (url.endsWith('/api/plugins/p1/sessions') && method === 'PUT') {
      return new Promise<Response>(resolve => {
        releaseSessions = () => resolve(json({ success: true }));
      });
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  renderPlugins();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Configure' }));
  const configTab = rtl.screen.getByRole('tab', { name: 'Configuration' }) as HTMLButtonElement;
  const sessionsTab = rtl.screen.getByRole('tab', { name: 'Sessions' }) as HTMLButtonElement;
  rtl.fireEvent.click(sessionsTab);

  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Save activation' }));
  await rtl.waitFor(() => assert.equal(configTab.disabled, true));
  assert.equal(document.querySelector('.modal-header .btn-icon'), null);
  const closeBtn = rtl.screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
  assert.equal(closeBtn.disabled, true);
  assert.equal(sessionsTab.disabled, true);

  rtl.fireEvent.click(configTab);
  rtl.fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(sessionsTab.getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('.config-modal'));

  await rtl.act(async () => {
    releaseSessions();
  });
  await rtl.waitFor(() => assert.equal(configTab.disabled, false));
  assert.ok(document.querySelector('.modal-header .btn-icon'));
  assert.equal(closeBtn.disabled, false);
});

test('SessionsTab select disables during uiBusy and savingOverride, and overlapping saves never clobber modal lock', async () => {
  let putS1Calls = 0;
  let putS2Calls = 0;
  let releaseS1!: () => void;
  let releaseS2!: () => void;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/plugins')) {
      return Promise.resolve(
        json([
          {
            id: 'p1',
            name: 'P1',
            version: '1.0.0',
            type: 'extension',
            description: 'Plugin',
            enabled: true,
            status: 'enabled',
            config: { token: 'base' },
            sessionScoped: true,
            activeSessions: ['*'],
            configSchema: { type: 'object', properties: { token: { type: 'string' } } },
            configUi: { entry: 'config/index.html', height: 320 },
          },
          {
            id: 'p2',
            name: 'P2',
            version: '1.0.0',
            type: 'extension',
            description: 'Schema Only',
            enabled: true,
            status: 'enabled',
            config: { token: 'base' },
            sessionScoped: true,
            activeSessions: ['*'],
            configSchema: { type: 'object', properties: { token: { type: 'string', title: 'Token' } } },
          },
        ]),
      );
    }
    if (url.endsWith('/api/sessions')) {
      return Promise.resolve(
        json([
          { id: 's1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
          { id: 's2', name: 'Second', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
        ]),
      );
    }
    if (url.endsWith('/config-ui')) {
      return Promise.resolve(new Response('<!doctype html><html><body><p>UI</p></body></html>', { status: 200 }));
    }
    if (url.endsWith('/api/plugins/p1/config/s1') && method === 'PUT') {
      putS1Calls += 1;
      return new Promise<Response>(resolve => {
        releaseS1 = () => resolve(json({ success: true, message: 'ok' }));
      });
    }
    if (url.endsWith('/api/plugins/p1/config/s2') && method === 'PUT') {
      putS2Calls += 1;
      return new Promise<Response>(resolve => {
        releaseS2 = () => resolve(json({ success: true, message: 'ok' }));
      });
    }
    if (url.endsWith('/api/plugins/p2/config/s1') && method === 'PUT') {
      putS1Calls += 1;
      return new Promise<Response>(resolve => {
        releaseS1 = () => resolve(json({ success: true, message: 'ok' }));
      });
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  renderPlugins();
  const configureBtns = await rtl.screen.findAllByRole('button', { name: 'Configure' });
  rtl.fireEvent.click(configureBtns[0]);
  const configTab = rtl.screen.getByRole('tab', { name: 'Configuration' }) as HTMLButtonElement;
  const sessionsTab = rtl.screen.getByRole('tab', { name: 'Sessions' }) as HTMLButtonElement;
  rtl.fireEvent.click(sessionsTab);

  const select = (await rtl.screen.findByRole('combobox', { name: 'Select a session…' })) as HTMLSelectElement;
  await rtl.screen.findByText('Main');
  rtl.fireEvent.change(select, { target: { value: 's1' } });

  const iframe1 = (await rtl.waitFor(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe.plugin-config-ui-frame');
    assert.ok(el?.getAttribute('srcdoc'));
    return el;
  })) as HTMLIFrameElement;
  const posted1: unknown[] = [];
  const fakeWin1 = { postMessage: (msg: unknown) => posted1.push(msg) } as unknown as Window;
  Object.defineProperty(iframe1, 'contentWindow', { value: fakeWin1, configurable: true });

  await rtl.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: { token: 'v1' } }, source: fakeWin1 }),
    );
  });
  assert.equal(putS1Calls, 1);
  assert.equal(select.disabled, true);
  assert.equal(configTab.disabled, true);
  assert.equal(document.querySelector('.modal-header .btn-icon'), null);

  // Switch session while s1 save is still in flight (unmounts s1 PluginConfigUi); modal lock must persist.
  rtl.fireEvent.change(select, { target: { value: 's2' } });
  assert.equal(configTab.disabled, true);
  assert.equal(document.querySelector('.modal-header .btn-icon'), null);

  const iframe2 = (await rtl.waitFor(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe.plugin-config-ui-frame');
    assert.ok(el && el !== iframe1 && el.getAttribute('srcdoc'));
    return el;
  })) as HTMLIFrameElement;
  const posted2: unknown[] = [];
  const fakeWin2 = { postMessage: (msg: unknown) => posted2.push(msg) } as unknown as Window;
  Object.defineProperty(iframe2, 'contentWindow', { value: fakeWin2, configurable: true });

  await rtl.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'config:save', config: { token: 'v2' } }, source: fakeWin2 }),
    );
  });
  assert.equal(putS2Calls, 1);

  // Unmounted s1 save finishing first must NOT unlock the modal while s2 save is still running.
  await rtl.act(async () => {
    releaseS1();
  });
  assert.equal(configTab.disabled, true);
  assert.equal(document.querySelector('.modal-header .btn-icon'), null);
  assert.equal(posted1.filter(m => (m as { type?: string }).type === 'config:saved').length, 0);

  await rtl.act(async () => {
    releaseS2();
  });
  await rtl.waitFor(() => assert.equal(configTab.disabled, false));
  assert.equal(select.disabled, false);
  assert.ok(document.querySelector('.modal-header .btn-icon'));
  assert.equal(posted2.filter(m => (m as { type?: string }).type === 'config:saved').length, 1);

  // Verify savingOverride on schema-only plugin p2 also disables the session select while in flight.
  const closeBtn = document.querySelector<HTMLButtonElement>('.modal-footer .btn-secondary')!;
  rtl.fireEvent.click(closeBtn);
  rtl.fireEvent.click((await rtl.screen.findAllByRole('button', { name: 'Configure' }))[1]);
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: 'Sessions' }));
  const selectP2 = (await rtl.screen.findByRole('combobox', { name: 'Select a session…' })) as HTMLSelectElement;
  rtl.fireEvent.change(selectP2, { target: { value: 's1' } });
  rtl.fireEvent.change(await rtl.screen.findByLabelText('Token'), { target: { value: 'override-1' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save override' }));
  await rtl.waitFor(() => assert.equal(selectP2.disabled, true));
  await rtl.act(async () => {
    releaseS1();
  });
  await rtl.waitFor(() => assert.equal(selectP2.disabled, false));
});
