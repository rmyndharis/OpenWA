// A bulk number check stops at the first answer that no later number would change.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import type { NumberCheckProvider as NumberCheckProviderType } from './NumberCheckProvider.tsx';
import type {
  batchStopMessage as batchStopMessageFn,
  useNumberCheck as useNumberCheckFn,
} from '../hooks/useNumberCheck.ts';
import type i18nType from '../i18n/index.ts';
import type { ToastContext as ToastContextType } from '../hooks/useToast.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let NumberCheckProvider: typeof NumberCheckProviderType;
let useNumberCheck: typeof useNumberCheckFn;
let batchStopMessage: typeof batchStopMessageFn;
let i18n: typeof i18nType;
let ToastContext: typeof ToastContextType;

let lookupStatus = 200;
let lookupCode: string | undefined;
const lookups: string[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady, default: instance } = await import('../i18n/index.ts');
  await i18nReady;
  i18n = instance;
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    lookups.push(url.slice(url.lastIndexOf('/') + 1));
    const body =
      lookupStatus === 200
        ? { number: '', exists: true, whatsappId: null }
        : { statusCode: lookupStatus, message: 'Dummy refusal', ...(lookupCode ? { code: lookupCode } : {}) };
    return Promise.resolve(new Response(JSON.stringify(body), { status: lookupStatus }));
  };
  rtl = await import('@testing-library/react');
  ({ NumberCheckProvider } = await import('./NumberCheckProvider.tsx'));
  ({ useNumberCheck, batchStopMessage } = await import('../hooks/useNumberCheck.ts'));
  ({ ToastContext } = await import('../hooks/useToast.ts'));
});

afterEach(() => {
  rtl.cleanup();
  lookupStatus = 200;
  lookupCode = undefined;
  lookups.length = 0;
});

function renderRun() {
  const noop = () => {};
  const value = {
    toasts: [],
    addToast: noop,
    removeToast: noop,
    success: noop,
    error: noop,
    warning: noop,
    info: noop,
  };
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ToastContext.Provider, { value }, createElement(NumberCheckProvider, null, children));
  return rtl.renderHook(() => useNumberCheck(), { wrapper });
}

for (const status of [403, 429]) {
  test(`a ${status} on the first lookup stops the run before the second number is sent`, async () => {
    lookupStatus = status;
    const { result } = renderRun();
    await rtl.act(() => result.current.start(['628111111111', '628222222222', '628333333333'], 'dummy-session', 0));
    assert.equal(lookups.length, 1);
    assert.equal(result.current.running, false);
    assert.equal(result.current.stopped?.status, status);
    assert.equal(result.current.stopped?.attempted, 1);
  });
}

// A 409 is also the answer while the WhatsApp Web page reloads, under a session that still reads ready; only the code
// tells it from a session that is not connected.
test('a 409 from the page reload window is not reported as a session that is not connected', async () => {
  lookupStatus = 409;
  lookupCode = 'ENGINE_PAGE_RELOADING';
  const { result } = renderRun();
  await rtl.act(() => result.current.start(['628111111111', '628222222222'], 'dummy-session', 0));
  assert.equal(lookups.length, 1);
  const stopped = result.current.stopped;
  assert.equal(stopped?.code, 'ENGINE_PAGE_RELOADING');
  const message = batchStopMessage(i18n.t.bind(i18n), stopped!);
  assert.match(message, /reloading its page/);
  assert.doesNotMatch(message, /not connected/);
});

test('a 409 with no code still says the session is not connected', async () => {
  lookupStatus = 409;
  const { result } = renderRun();
  await rtl.act(() => result.current.start(['628111111111', '628222222222'], 'dummy-session', 0));
  assert.equal(result.current.stopped?.code, undefined);
  assert.match(batchStopMessage(i18n.t.bind(i18n), result.current.stopped!), /not connected/);
});

test('a 404 fails that number only and the run goes on', async () => {
  lookupStatus = 404;
  const { result } = renderRun();
  await rtl.act(() => result.current.start(['628111111111', '628222222222'], 'dummy-session', 0));
  assert.equal(lookups.length, 2);
  assert.equal(result.current.stopped, null);
});
