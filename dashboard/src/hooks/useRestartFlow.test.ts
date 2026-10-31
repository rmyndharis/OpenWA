// The restart flow driven directly through renderHook, for outcomes that turn on the exact answer to
// the restart POST or on timing around an unmount. Infrastructure.test.ts covers the same hook through
// the page.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { RestartStatus, useRestartFlow as useRestartFlowFn } from './useRestartFlow.ts';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useRestartFlow: typeof useRestartFlowFn;

// Per-test answers to the two requests the hook sends; a test that never sets one gets a hanging
// request, which is what an in-flight call looks like.
let restartAnswer: (signal?: AbortSignal | null) => Promise<Response> = () => new Promise(() => {});
let readyAnswer: (signal?: AbortSignal | null) => Promise<Response> = () => new Promise(() => {});
const calls: string[] = [];
const readySignals: Array<AbortSignal | null | undefined> = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function htmlResponse(status: number): Response {
  return new Response(`<html><body>${status}</body></html>`, { status, headers: { 'Content-Type': 'text/html' } });
}

function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(r => (resolve = r));
  return { promise, resolve };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  const { installJsdomGlobals } = (await import('../test-helpers/jsdom.ts')) as {
    installJsdomGlobals: typeof installJsdomGlobalsFn;
  };
  await installJsdomGlobals();
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/infra/restart') return restartAnswer(init?.signal);
    if (path === '/api/health/ready') {
      readySignals.push(init?.signal);
      return readyAnswer(init?.signal);
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  };
  rtl = await import('@testing-library/react');
  ({ useRestartFlow } = await import('./useRestartFlow.ts'));
});

afterEach(() => {
  rtl.cleanup();
  mock.timers.reset();
  calls.length = 0;
  readySignals.length = 0;
  restartAnswer = () => new Promise(() => {});
  readyAnswer = () => new Promise(() => {});
});

async function statusAfterRestart(answer: () => Promise<Response>): Promise<RestartStatus> {
  restartAnswer = answer;
  const { result } = rtl.renderHook(() => useRestartFlow());
  rtl.act(() => void result.current.start());
  await rtl.waitFor(() => assert.notEqual(result.current.restartStatus, 'restarting'));
  return result.current.restartStatus;
}

// Cloudflare answers a slow origin with 524 and a reset or refused one with 520/522, all as an HTML
// page. The restart may still go ahead behind it, so this is the same unknown outcome as a 504.
test('a proxy 52x page on the restart request is an unknown outcome, not a refusal', async () => {
  for (const status of [520, 522, 524]) {
    assert.equal(await statusAfterRestart(() => Promise.resolve(htmlResponse(status))), 'unknown', `HTTP ${status}`);
    rtl.cleanup();
  }
});

test('a proxy 503 page and a coded gateway 5xx stay refusals', async () => {
  assert.equal(await statusAfterRestart(() => Promise.resolve(htmlResponse(503))), 'error');
  rtl.cleanup();
  const coded = jsonResponse({ message: 'Compose rejected the profile', code: 'SOME_CODE' }, 524);
  assert.equal(await statusAfterRestart(() => Promise.resolve(coded)), 'error');
});

test(
  'a restart answer that lands after unmount starts no countdown and no readiness poll',
  { timeout: 10_000 },
  async () => {
    const restart = deferred();
    restartAnswer = () => restart.promise;
    const live = new Set<unknown>();
    const { setInterval: realSet, clearInterval: realClear } = globalThis;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const handle = realSet(fn, ms);
      live.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      live.delete(handle);
      realClear(handle);
    }) as typeof clearInterval;
    try {
      const { result, unmount } = rtl.renderHook(() => useRestartFlow());
      rtl.act(() => void result.current.start());
      await rtl.waitFor(() => assert.ok(calls.includes('POST /api/infra/restart')));

      unmount();
      restart.resolve(jsonResponse({ message: 'restarting', restarting: true, estimatedTime: 5 }));
      // Past the first readiness poll (3s after the answer).
      await wait(3500);

      assert.ok(!calls.includes('GET /api/health/ready'), 'the readiness poll ran after unmount');
      assert.equal(live.size, 0, 'a countdown interval outlived the component');
    } finally {
      for (const handle of live) realClear(handle as ReturnType<typeof setInterval>);
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  },
);

test('a readiness check in flight at unmount does not schedule another one', { timeout: 12_000 }, async () => {
  restartAnswer = () => Promise.resolve(jsonResponse({ message: 'restarting', restarting: true, estimatedTime: 5 }));
  const ready = deferred();
  readyAnswer = () => ready.promise;
  const { result, unmount } = rtl.renderHook(() => useRestartFlow());
  rtl.act(() => void result.current.start());
  await rtl.waitFor(() => assert.ok(calls.includes('GET /api/health/ready')), { timeout: 5_000 });

  unmount();
  ready.resolve(jsonResponse({ status: 'error', details: {} }, 503));
  readyAnswer = () => Promise.resolve(jsonResponse({ status: 'error', details: {} }, 503));
  // Past the 1s retry a failed check schedules.
  await wait(1500);

  assert.equal(calls.filter(c => c === 'GET /api/health/ready').length, 1, 'the poll re-armed after unmount');
});

test('the containers the restart could not start or stop are listed with the answer', async () => {
  restartAnswer = () =>
    Promise.resolve(
      jsonResponse({
        message: 'restarting',
        restarting: true,
        estimatedTime: 5,
        orchestration: { errors: ['postgres: port in use'] },
        removal: { errors: ['minio: stop timed out'] },
      }),
    );
  const { result } = rtl.renderHook(() => useRestartFlow());
  rtl.act(() => void result.current.start());
  await rtl.waitFor(() => assert.equal(result.current.restartStatus, 'waiting'));
  assert.deepEqual(result.current.restartWarnings, ['postgres: port in use', 'minio: stop timed out']);
});

function abortReady<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

const settleRestartReply = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};

for (const stalledAt of ['fetch', 'body']) {
  test(`readiness ${stalledAt} is aborted at the elapsed restart deadline`, async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
    restartAnswer = () => Promise.resolve(jsonResponse({ message: 'Restarting', restarting: true, estimatedTime: 5 }));
    const pending = deferred();
    let bodyResolve!: (body: unknown) => void;
    const body = new Promise<unknown>(resolve => {
      bodyResolve = resolve;
    });
    readyAnswer = signal =>
      stalledAt === 'fetch'
        ? abortReady(pending.promise, signal)
        : Promise.resolve({ ok: true, status: 200, json: () => abortReady(body, signal) } as Response);
    const { result } = rtl.renderHook(() => useRestartFlow());
    await rtl.act(async () => {
      void result.current.start();
      await settleRestartReply();
    });
    assert.equal(result.current.restartStatus, 'waiting');
    await rtl.act(async () => {
      mock.timers.tick(3000);
      await settleRestartReply();
    });
    assert.equal(readySignals.length, 1);
    await rtl.act(async () => {
      mock.timers.tick(60000);
      await settleRestartReply();
    });
    assert.equal(result.current.restartStatus, 'error');
    assert.equal(result.current.restartCountdown, 0);
    assert.equal(readySignals[0]?.aborted, true);
    await rtl.act(async () => {
      pending.resolve(jsonResponse({ status: 'ok', details: {} }));
      bodyResolve({ status: 'ok', details: {} });
      await settleRestartReply();
      mock.timers.tick(120000);
    });
    assert.equal(result.current.restartStatus, 'error');
    assert.equal(readySignals.length, 1);
  });
}

test('a late readiness reply cannot replace the elapsed deadline result', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
  restartAnswer = () => Promise.resolve(jsonResponse({ message: 'Restarting', restarting: true, estimatedTime: 5 }));
  const pending = deferred();
  // Keep the transport pending even after abort, so the state fence is exercised independently.
  readyAnswer = () => pending.promise;
  const { result } = rtl.renderHook(() => useRestartFlow());
  await rtl.act(async () => {
    void result.current.start();
    await settleRestartReply();
  });
  await rtl.act(async () => {
    mock.timers.tick(3000);
    await settleRestartReply();
  });
  await rtl.act(async () => {
    mock.timers.tick(60000);
    await settleRestartReply();
  });
  assert.equal(result.current.restartStatus, 'error');
  assert.equal(readySignals[0]?.aborted, true);
  await rtl.act(async () => {
    pending.resolve(jsonResponse({ status: 'ok', details: {} }));
    await settleRestartReply();
    mock.timers.tick(120000);
  });
  assert.equal(result.current.restartStatus, 'error');
  assert.equal(readySignals.length, 1);
});

test('unmount aborts an in-flight readiness request without rescheduling', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
  restartAnswer = () => Promise.resolve(jsonResponse({ message: 'Restarting', restarting: true, estimatedTime: 5 }));
  const pending = deferred();
  readyAnswer = signal => abortReady(pending.promise, signal);
  const { result, unmount } = rtl.renderHook(() => useRestartFlow());
  await rtl.act(async () => {
    void result.current.start();
    await settleRestartReply();
  });
  await rtl.act(async () => {
    mock.timers.tick(3000);
    await settleRestartReply();
  });
  assert.equal(readySignals.length, 1);
  assert.ok(readySignals[0]);
  assert.equal(readySignals[0].aborted, false);
  await rtl.act(async () => {
    unmount();
    await settleRestartReply();
  });
  assert.equal(readySignals[0].aborted, true);
  await rtl.act(async () => {
    pending.resolve(jsonResponse({ status: 'ok', details: {} }));
    await settleRestartReply();
    mock.timers.tick(120000);
  });
  assert.equal(readySignals.length, 1);
});

test('a successful readiness response retires its deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
  // A warning keeps the success view open instead of scheduling a page reload.
  restartAnswer = () =>
    Promise.resolve(
      jsonResponse({
        message: 'Restarting',
        restarting: true,
        estimatedTime: 5,
        orchestration: { errors: ['A service needs attention'] },
      }),
    );
  readyAnswer = () => Promise.resolve(jsonResponse({ status: 'ok', details: {} }));
  const { result } = rtl.renderHook(() => useRestartFlow());
  await rtl.act(async () => {
    void result.current.start();
    await settleRestartReply();
  });
  await rtl.act(async () => {
    mock.timers.tick(3000);
    await settleRestartReply();
  });
  assert.equal(result.current.restartStatus, 'success');
  await rtl.act(async () => {
    mock.timers.tick(120000);
    await settleRestartReply();
  });
  assert.equal(result.current.restartStatus, 'success');
  assert.equal(readySignals.length, 1);
});

test('a readiness attempt that hangs is given up on and the next one is made before the deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
  // A warning keeps the success view open instead of scheduling a page reload.
  restartAnswer = () =>
    Promise.resolve(
      jsonResponse({
        message: 'Restarting',
        restarting: true,
        estimatedTime: 5,
        orchestration: { errors: ['A service needs attention'] },
      }),
    );
  const hung = deferred();
  let attempt = 0;
  readyAnswer = signal =>
    ++attempt === 1 ? abortReady(hung.promise, signal) : Promise.resolve(jsonResponse({ status: 'ok', details: {} }));
  const { result } = rtl.renderHook(() => useRestartFlow());
  await rtl.act(async () => {
    void result.current.start();
    await settleRestartReply();
  });
  await rtl.act(async () => {
    mock.timers.tick(3000);
    await settleRestartReply();
  });
  assert.equal(readySignals.length, 1);
  assert.equal(result.current.restartStatus, 'waiting');
  await rtl.act(async () => {
    mock.timers.tick(5000);
    await settleRestartReply();
  });
  assert.equal(readySignals[0]?.aborted, true);
  assert.equal(result.current.restartStatus, 'waiting');
  await rtl.act(async () => {
    mock.timers.tick(1000);
    await settleRestartReply();
  });
  assert.equal(readySignals.length, 2);
  assert.equal(result.current.restartStatus, 'success');
});

test('a restart request that never answers ends with the outcome unknown at its bound, with no readiness poll', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
  restartAnswer = signal => abortReady(deferred().promise, signal);
  const { result } = rtl.renderHook(() => useRestartFlow());
  await rtl.act(async () => {
    void result.current.start();
    await settleRestartReply();
  });
  assert.equal(result.current.restartStatus, 'restarting');
  await rtl.act(async () => {
    mock.timers.tick(4 * 60 * 1000);
    await settleRestartReply();
  });
  assert.equal(result.current.restartStatus, 'restarting');
  await rtl.act(async () => {
    mock.timers.tick(61 * 1000);
    await settleRestartReply();
  });
  assert.equal(result.current.restartStatus, 'unknown');
  assert.equal(result.current.restartError, null);
  assert.equal(result.current.restartCountdown, 0);
  await rtl.act(async () => {
    mock.timers.tick(120000);
    await settleRestartReply();
  });
  assert.equal(readySignals.length, 0);
});
