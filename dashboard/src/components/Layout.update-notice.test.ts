import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoleContextType, UserRole } from '../types/role.ts';

let rtl: typeof import('@testing-library/react');
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];
let Layout: (typeof import('./Layout.tsx'))['Layout'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
  ({ ToastProvider } = await import('./Toast.tsx'));
  ({ Layout } = await import('./Layout.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function makeRoleValue(role: UserRole, scoped: boolean): RoleContextType {
  return {
    role,
    setRole: () => {},
    isAdmin: role === 'admin',
    isOperator: role === 'operator',
    isViewer: role === 'viewer',
    canWrite: role !== 'viewer',
    engineType: 'baileys',
    setEngineType: () => {},
    scoped,
    setScoped: () => {},
  };
}

test('Layout clears stale update notice when actor switches to non-admin or scoped key', async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/app-info')) return Promise.resolve(json({ version: '0.26.0', appVersion: '0.26.0' }));
    if (url.includes('/api/infra/update-check')) {
      return Promise.resolve(
        json({ updateAvailable: true, latest: '0.27.0', releaseUrl: 'https://example.test/releases/0.27.0' }),
      );
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;

  const client = new QueryClient();
  const renderWith = (role: UserRole, scoped: boolean) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(
          ToastProvider,
          null,
          createElement(
            RoleContext.Provider,
            { value: makeRoleValue(role, scoped) },
            createElement(Layout, { onLogout: () => {}, userRole: role }),
          ),
        ),
      ),
    );

  const view = rtl.render(renderWith('admin', false));
  await rtl.screen.findByRole('link', { name: 'v0.27.0 available' });

  view.rerender(renderWith('operator', false));
  assert.equal(rtl.screen.queryByRole('link', { name: 'v0.27.0 available' }), null);

  view.rerender(renderWith('admin', false));
  await rtl.screen.findByRole('link', { name: 'v0.27.0 available' });

  view.rerender(renderWith('admin', true));
  assert.equal(rtl.screen.queryByRole('link', { name: 'v0.27.0 available' }), null);
  client.clear();
});
