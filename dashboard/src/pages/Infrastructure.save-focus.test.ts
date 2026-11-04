// Save Configuration sits at the foot of a long page. A keyboard user who presses it must find focus on it again
// afterwards: when the restart dialog it opens is dismissed with Restart Later, and when the gateway refuses the save.
// The page's stylesheet is not loaded under jsdom; what matters here is where document.activeElement ends up.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
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

// How PUT /api/infra/config answers: a saved configuration, or a refusal.
let saveAnswer: 'saved' | 'refused' = 'saved';
let holdSave = false;
let releaseSave: () => void = () => {};

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
      // Answered on a later turn, as a real request is, so the page renders its saving state first.
      return new Promise(resolve => {
        const answer = () =>
          resolve(
            saveAnswer === 'saved'
              ? jsonResponse({ message: 'Configuration saved', saved: true, envPath: '.env.generated', profiles: [] })
              : jsonResponse(
                  { statusCode: 400, message: 'Refusing to save the storage path', error: 'Bad Request' },
                  400,
                ),
          );
        if (holdSave) releaseSave = answer;
        else setImmediate(answer);
      });
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Infrastructure: (typeof import('./Infrastructure.tsx'))['Infrastructure'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : matches.call(this, selector);
  } as typeof matches;
  // HTML focus fixup rule, as browsers apply it: disabling the focused control drops focus to the document body.
  // jsdom does not run focus fixup when disabled is set (the same emulation as Infrastructure.import-keyboard.test.ts).
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
  saveAnswer = 'saved';
  holdSave = false;
});

/** The text of the focused control, or 'body' when focus fell out of every control. */
function focusedName(): string {
  const active = document.activeElement;
  if (!active || active === document.body) return 'body';
  return active.textContent?.trim() || active.tagName.toLowerCase();
}

async function renderPage(): Promise<HTMLButtonElement> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
  return (await rtl.screen.findByRole('button', { name: 'Save Configuration' })) as HTMLButtonElement;
}

test('keyboard focus returns to Save Configuration when the restart dialog is put off with Restart Later', async () => {
  const save = await renderPage();
  save.focus();
  assert.equal(focusedName(), 'Save Configuration');

  // Enter or Space on a focused button fires its click.
  rtl.fireEvent.click(save);
  const later = await rtl.screen.findByRole('button', { name: 'Restart Later' });
  // The dialog moves focus into itself in an effect after it mounts.
  await rtl.waitFor(() => assert.ok(document.activeElement?.closest('[role="dialog"]')));
  later.focus();
  rtl.fireEvent.click(later);
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('dialog'), null));
  await rtl.waitFor(() => assert.equal(save.disabled, false));

  assert.equal(focusedName(), 'Save Configuration');
});

test('keyboard focus stays on Save Configuration when the gateway refuses the save', async () => {
  saveAnswer = 'refused';
  const save = await renderPage();
  save.focus();
  assert.equal(focusedName(), 'Save Configuration');

  rtl.fireEvent.click(save);
  await rtl.waitFor(() => assert.equal(save.disabled, true));
  await rtl.screen.findByText('Refusing to save the storage path');
  await rtl.waitFor(() => assert.equal(save.disabled, false));

  assert.equal(focusedName(), 'Save Configuration');
});

test('Escape from the restart dialog returns focus to Save Configuration', async () => {
  const save = await renderPage();
  save.focus();
  rtl.fireEvent.click(save);
  const dialog = await rtl.screen.findByRole('dialog');
  rtl.fireEvent.keyDown(dialog, { key: 'Escape' });
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('dialog') === null, true));
  assert.equal(focusedName(), 'Save Configuration');
});

test('a refused save leaves focus on a field selected while the request ran', async () => {
  saveAnswer = 'refused';
  holdSave = true;
  const save = await renderPage();
  save.focus();
  rtl.fireEvent.click(save);
  const path = rtl.screen.getByDisplayValue('./data/media');
  path.focus();
  await rtl.act(async () => releaseSave());
  await rtl.waitFor(() => assert.equal(save.disabled, false));
  assert.equal(document.activeElement?.getAttribute('value'), './data/media');
});

test('a save activated without keyboard focus does not claim focus after refusal', async () => {
  saveAnswer = 'refused';
  const save = await renderPage();
  rtl.fireEvent.click(save);
  await rtl.screen.findByText('Refusing to save the storage path');
  await rtl.waitFor(() => assert.equal(save.disabled, false));
  assert.equal(focusedName(), 'body');
});
