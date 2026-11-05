// On a phone the page behind the open navigation drawer is inert. A dialog the page opens once a request answers can
// open while the drawer is still out (the operator pressed Save Configuration, then opened the menu while the save
// ran): it is drawn on top of the drawer, so it has to be usable, not inert with the page it belongs to.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

// The test releases the pending save after opening the navigation drawer.
let releaseSave: () => void = () => {};
let sessionStarted = false;
let logoutCalls = 0;

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let Infrastructure: (typeof import('../pages/Infrastructure.tsx'))['Infrastructure'];
let Sessions: (typeof import('../pages/Sessions.tsx'))['Sessions'];
let Modal: (typeof import('./Modal.tsx'))['Modal'];
let RoleProvider: (typeof import('./RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];
let router: typeof import('react-router-dom');
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : matches.call(this, selector);
  } as typeof matches;
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    get() {
      return this.parentElement;
    },
  });
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options) {
    if (!this.closest('[inert]')) focus.call(this, options);
  };
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  // A phone-width window: the layout's (max-width: 767px) query matches.
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*767px/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const session = {
      id: 'new-session',
      name: 'New device',
      phone: null,
      status: sessionStarted ? 'qr_ready' : 'created',
      engineLoaded: sessionStarted,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([session]));
    if (method === 'GET' && path === '/api/sessions/new-session/qr') {
      return Promise.resolve(jsonResponse({ qrCode: '', status: 'qr_ready' }));
    }
    if (method === 'POST' && path === '/api/sessions/new-session/start') {
      return new Promise(resolve => {
        releaseSave = () => {
          sessionStarted = true;
          resolve(jsonResponse({ ...session, status: 'qr_ready', engineLoaded: true }));
        };
      });
    }
    if (method === 'GET' && path === '/api/infra/status') return Promise.resolve(jsonResponse(STATUS));
    if (method === 'GET' && path === '/api/infra/config') return Promise.resolve(jsonResponse(SAVED));
    if (method === 'GET' && path === '/api/infra/engines') {
      return Promise.resolve(jsonResponse([{ id: 'baileys', name: 'Baileys', enabled: true, features: [] }]));
    }
    if (method === 'GET' && path === '/api/infra/engines/current') {
      return Promise.resolve(jsonResponse({ engineType: 'baileys' }));
    }
    if (method === 'PUT' && path === '/api/infra/config') {
      return new Promise(resolve => {
        releaseSave = () =>
          resolve(
            jsonResponse({ message: 'Configuration saved', saved: true, envPath: '.env.generated', profiles: [] }),
          );
      });
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  router = await import('react-router-dom');
  ({ Layout } = await import('./Layout.tsx'));
  ({ RoleProvider } = await import('./RoleProvider.tsx'));
  ({ ToastProvider } = await import('./Toast.tsx'));
  ({ Infrastructure } = await import('../pages/Infrastructure.tsx'));
  ({ Sessions } = await import('../pages/Sessions.tsx'));
  ({ Modal } = await import('./Modal.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  sessionStorage.removeItem('openwa_user_role');
  sessionStarted = false;
  logoutCalls = 0;
});

function renderPage(element: ReturnType<typeof createElement>) {
  sessionStorage.setItem('openwa_user_role', 'admin');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { MemoryRouter, Routes, Route } = router;
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(
              Routes,
              null,
              createElement(
                Route,
                {
                  path: '/',
                  element: createElement(Layout, {
                    onLogout: () => {
                      logoutCalls++;
                    },
                    userRole: 'admin',
                  }),
                },
                createElement(Route, { index: true, element }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return container;
}

test('a dialog opened during the phone drawer closes the drawer and remains usable', async () => {
  const container = renderPage(createElement(Infrastructure));
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Save Configuration' }));
  // The save is still running when the operator opens the menu.
  rtl.fireEvent.click(container.querySelector('.mobile-menu-btn')!);
  assert.ok(container.querySelector('aside.sidebar')!.classList.contains('open'), 'the drawer did not open');
  rtl.screen.getByRole('button', { name: 'Logout' }).focus();

  await rtl.act(async () => releaseSave());
  const dialog = await rtl.screen.findByRole('dialog');

  const inertAncestor = dialog.closest('[inert]');
  assert.equal(
    inertAncestor === null ? 'usable' : `inside an inert <${inertAncestor.tagName.toLowerCase()}>`,
    'usable',
  );
  assert.equal(container.querySelector('aside.sidebar')!.classList.contains('open'), false);
  assert.equal(document.activeElement?.textContent?.trim(), 'Restart Later');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Restart Later' }));
  assert.equal(logoutCalls, 0);
  assert.equal(rtl.screen.queryByRole('dialog') === null, true);
  assert.equal(document.body.style.overflow, '');
  assert.equal(document.activeElement?.classList.contains('mobile-menu-btn'), true);
});

test('a deferred session Start opens a focused pairing dialog over the phone drawer', async () => {
  const container = renderPage(createElement(Sessions));
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Start' }));
  const menu = container.querySelector<HTMLButtonElement>('.mobile-menu-btn')!;
  menu.focus();
  rtl.fireEvent.click(menu);
  assert.equal(container.querySelector('main')!.hasAttribute('inert'), true);
  await rtl.act(async () => releaseSave());
  const dialog = await rtl.screen.findByRole('dialog');
  await rtl.waitFor(() => assert.equal(dialog.closest('[inert]') === null, true));
  assert.equal(container.querySelector('aside.sidebar')!.classList.contains('open'), false);
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close');
  rtl.fireEvent.click(rtl.within(dialog).getByRole('button', { name: 'Close' }));
  assert.equal(document.body.style.overflow, '');
  assert.equal(logoutCalls, 0);
});

test('a dialog revealed after the drawer closes honors its initial field', async () => {
  const input = createRef<HTMLInputElement>();
  const view = (inert: boolean) =>
    createElement(
      'main',
      { inert },
      createElement(Modal, {
        open: true,
        title: 'Edit label',
        onClose: () => {},
        initialFocusRef: input,
        children: createElement('input', { ref: input, 'aria-label': 'Label' }),
      }),
    );
  const { rerender, unmount } = rtl.render(view(true));
  assert.equal(document.activeElement === document.body, true);
  rerender(view(false));
  await rtl.waitFor(() => assert.equal(document.activeElement?.getAttribute('aria-label'), 'Label'));
  unmount();
  assert.equal(document.body.style.overflow, '');
});

// The page can have a dialog open before the menu button is pressed (the overlay covers the button for a pointer, not for
// a script or an assistive technology). No later change of the page then wakes the observer, so the drawer closes at once.
test('a dialog that is already open when the drawer opens closes the drawer and stays usable', async () => {
  const container = renderPage(
    createElement(Modal, {
      open: true,
      title: 'Already open',
      onClose: () => {},
      children: createElement('p', null, 'Body'),
    }),
  );
  const dialog = await rtl.screen.findByRole('dialog');
  // The drawer ends up closed whether it opened and closed again or never opened, so the button is watched for the state
  // it had before each change: a record that held "true" shows the drawer did open.
  const menuButton = container.querySelector('.mobile-menu-btn')!;
  const previous: Array<string | null> = [];
  const watcher = new MutationObserver(records => previous.push(...records.map(record => record.oldValue)));
  watcher.observe(menuButton, { attributes: true, attributeFilter: ['aria-expanded'], attributeOldValue: true });

  rtl.fireEvent.click(menuButton);

  assert.equal(container.querySelector('aside.sidebar')!.classList.contains('open'), false);
  previous.push(...watcher.takeRecords().map(record => record.oldValue));
  watcher.disconnect();
  assert.equal(previous.includes('true'), true, 'the drawer opened before it closed');
  assert.equal(container.querySelector('main')!.hasAttribute('inert'), false);
  assert.equal(dialog.closest('[inert]') === null, true);
});
