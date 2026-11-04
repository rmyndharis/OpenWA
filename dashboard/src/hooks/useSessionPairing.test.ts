// The QR / pairing modal polls the QR route every five seconds. A poll that fails and cannot read the
// session's status either must not close the modal: the operator may be in the middle of typing a phone
// number, and the failure is the network's, not the session's.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let useSessionPairing: (typeof import('./useSessionPairing.ts'))['useSessionPairing'];
let sessionApi: (typeof import('../services/api.ts'))['sessionApi'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ useSessionPairing } = await import('./useSessionPairing.ts'));
  ({ sessionApi } = await import('../services/api.ts'));
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  rtl.cleanup();
});

const session = { id: 's1', name: 'main', status: 'qr_ready' } as unknown as Session;

/** Opens the modal for `s1`, lets the poll run once with GET /qr failing, and answers the status read as given. */
async function pollOnce(statusRead: () => Promise<Session>): Promise<boolean> {
  const api = sessionApi as unknown as {
    getQR: () => Promise<unknown>;
    get: () => Promise<Session>;
  };
  mock.restoreAll();
  mock.timers.reset();
  mock.method(api, 'getQR', () => Promise.reject(new Error('Failed to fetch')));
  mock.method(api, 'get', statusRead);
  mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [session];
  const { result } = rtl.renderHook(() =>
    useSessionPairing({ sessions, sessionsRef: { current: sessions }, reloadSessions: async () => sessions }),
  );
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  assert.ok(result.current.qrData, 'the modal did not open');
  await rtl.act(async () => {
    mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
  });
  return result.current.qrData !== null;
}

test('the modal stays open when the QR poll and the status read both fail without an answer', async () => {
  assert.equal(await pollOnce(() => Promise.reject(new TypeError('Failed to fetch'))), true);
});

test('the modal stays open when the status read is refused for rate or fails on the server', async () => {
  for (const status of [429, 502]) {
    rtl.cleanup();
    assert.equal(
      await pollOnce(() => Promise.reject(Object.assign(new Error('refused'), { status }))),
      true,
      `a ${status} closed the modal`,
    );
  }
});

test('the modal closes when the session is gone or no longer starting', async () => {
  assert.equal(await pollOnce(() => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))), false);
  rtl.cleanup();
  assert.equal(await pollOnce(() => Promise.resolve({ ...session, status: 'failed' } as Session)), false);
});

test('the modal stays open while the session is still initializing', async () => {
  assert.equal(await pollOnce(() => Promise.resolve({ ...session, status: 'authenticating' } as Session)), true);
});

/** Opens the modal for a session in `status`, runs one poll, and reports the modal and what the poll did. */
async function pollWithQr(status: string, getQR: () => Promise<unknown>, statusAtPoll = status) {
  const api = sessionApi as unknown as { getQR: () => Promise<unknown>; get: () => Promise<Session> };
  mock.restoreAll();
  mock.timers.reset();
  const getQrCalls = mock.method(api, 'getQR', getQR);
  mock.method(api, 'get', () => Promise.reject(new Error('the status is not read on this path')));
  mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [{ ...session, status } as Session];
  const ref = { current: sessions };
  let reloads = 0;
  const { result } = rtl.renderHook(() =>
    useSessionPairing({
      sessions,
      sessionsRef: ref,
      reloadSessions: async () => {
        reloads++;
        return sessions;
      },
    }),
  );
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  assert.ok(result.current.qrData, 'the modal did not open');
  ref.current = [{ ...session, status: statusAtPoll } as Session];
  const callsBefore = getQrCalls.mock.callCount();
  await rtl.act(async () => {
    mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
  });
  return {
    qrData: result.current.qrData,
    pollCalls: getQrCalls.mock.callCount() - callsBefore,
    reloads,
  };
}

test('a poll refreshes the QR code while the session waits for a scan', async () => {
  const outcome = await pollWithQr('qr_ready', () => Promise.resolve({ qrCode: 'NEW-CODE', status: 'qr_ready' }));
  assert.equal(outcome.pollCalls, 1);
  assert.equal(outcome.qrData?.qrCode, 'NEW-CODE');
});

test('a poll that learns the session is ready closes the modal and reloads the list', async () => {
  const outcome = await pollWithQr('qr_ready', () => Promise.resolve({ qrCode: '', status: 'ready' }));
  assert.equal(outcome.qrData, null);
  assert.ok(outcome.reloads >= 1);
});

test('no QR is requested before the engine has produced one', async () => {
  const outcome = await pollWithQr('initializing', () => Promise.reject(new Error('400')));
  assert.equal(outcome.pollCalls, 0);
  assert.ok(outcome.qrData, 'the modal stays open for the push that carries the code');
});

test('a session that became ready closes the modal without a request', async () => {
  const outcome = await pollWithQr('qr_ready', () => Promise.resolve({ qrCode: 'X', status: 'qr_ready' }), 'ready');
  assert.equal(outcome.pollCalls, 0);
  assert.equal(outcome.qrData, null);
});

interface QrReplyPlan {
  path: string;
  answer: Response | Promise<Response>;
  method?: string;
}

function qrReply(code: string): Response {
  return new Response(JSON.stringify({ qrCode: code, status: 'qr_ready' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pendingQrReply(): { promise: Promise<Response>; resolve: (reply: Response) => void } {
  let resolve!: (reply: Response) => void;
  const promise = new Promise<Response>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

function planQrReplies(...plans: QrReplyPlan[]): void {
  mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const plan = plans.shift();
    assert.ok(plan, `No response planned for ${String(input)}`);
    assert.equal(new URL(String(input), 'http://localhost').pathname, plan.path);
    assert.equal(init?.method ?? 'GET', plan.method ?? 'GET');
    return Promise.resolve(plan.answer);
  });
}

const settleQrReply = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};

function renderQrVisit() {
  mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [session, { ...session, id: 's2', name: 'second' }];
  return rtl.renderHook(() =>
    useSessionPairing({
      sessions,
      sessionsRef: { current: sessions },
      reloadSessions: async () => sessions,
    }),
  );
}

test('a QR reply from an earlier visit cannot replace the reopened session code', async () => {
  const old = pendingQrReply(),
    current = pendingQrReply();
  planQrReplies(
    { path: '/api/sessions/s1/qr', answer: old.promise },
    { path: '/api/sessions/s1/qr', answer: current.promise },
  );
  const { result } = renderQrVisit();
  let first!: Promise<void>, second!: Promise<void>;
  await rtl.act(async () => {
    first = result.current.handleShowQR('s1');
    await settleQrReply();
  });
  rtl.act(() => result.current.handleCloseQRModal());
  await rtl.act(async () => {
    second = result.current.handleShowQR('s1');
    await settleQrReply();
  });
  await rtl.act(async () => {
    current.resolve(qrReply('CURRENT'));
    await second;
  });
  assert.equal(result.current.qrData?.qrCode, 'CURRENT');
  await rtl.act(async () => {
    old.resolve(qrReply('RETIRED'));
    await first;
  });
  assert.equal(result.current.qrData?.qrCode, 'CURRENT');
});

test('a newer QR push is kept when an older GET answers', async () => {
  const old = pendingQrReply();
  planQrReplies({ path: '/api/sessions/s1/qr', answer: old.promise });
  const { result } = renderQrVisit();
  let opening!: Promise<void>;
  await rtl.act(async () => {
    opening = result.current.handleShowQR('s1');
    await settleQrReply();
  });
  rtl.act(() => result.current.applyQrPush({ sessionId: 's1', qrCode: 'PUSH' }));
  await rtl.act(async () => {
    old.resolve(qrReply('GET'));
    await opening;
  });
  assert.equal(result.current.qrData?.qrCode, 'PUSH');
});

for (const status of [200, 404]) {
  test(`an earlier poll status ${status} cannot close a reopened session modal`, async () => {
    const old = pendingQrReply();
    const temporaryFailure = new Response(JSON.stringify({ message: 'Temporary failure' }), { status: 503 });
    planQrReplies(
      { path: '/api/sessions/s1/qr', answer: qrReply('FIRST') },
      { path: '/api/sessions/s1/qr', answer: temporaryFailure },
      { path: '/api/sessions/s1', answer: old.promise },
      { path: '/api/sessions/s1/qr', answer: qrReply('REOPENED') },
    );
    const { result } = renderQrVisit();
    await rtl.act(async () => {
      await result.current.handleShowQR('s1');
    });
    await rtl.act(async () => {
      mock.timers.tick(5000);
      await settleQrReply();
    });
    rtl.act(() => result.current.handleCloseQRModal());
    await rtl.act(async () => {
      await result.current.handleShowQR('s1');
    });
    await rtl.act(async () => {
      old.resolve(
        new Response(JSON.stringify(status === 200 ? { ...session, status: 'failed' } : { message: 'Gone' }), {
          status,
        }),
      );
      await settleQrReply();
    });
    assert.equal(result.current.qrData?.qrCode, 'REOPENED');
  });
}

for (const firstToAnswer of ['older', 'newer']) {
  test(`concurrent QR reads keep the latest answer when ${firstToAnswer} resolves first`, async () => {
    const older = pendingQrReply(),
      newer = pendingQrReply();
    planQrReplies(
      { path: '/api/sessions/s1/qr', answer: older.promise },
      { path: '/api/sessions/s1/qr', answer: newer.promise },
    );
    const { result } = renderQrVisit();
    let opening!: Promise<void>;
    await rtl.act(async () => {
      opening = result.current.handleShowQR('s1');
      await settleQrReply();
    });
    await rtl.act(async () => {
      mock.timers.tick(5000);
      await settleQrReply();
    });
    await rtl.act(async () => {
      if (firstToAnswer === 'older') older.resolve(qrReply('OLDER'));
      else newer.resolve(qrReply('NEWER'));
      await settleQrReply();
    });
    await rtl.act(async () => {
      if (firstToAnswer === 'older') newer.resolve(qrReply('NEWER'));
      else older.resolve(qrReply('OLDER'));
      await opening;
      await settleQrReply();
    });
    assert.equal(result.current.qrData?.qrCode, 'NEWER');
  });
}

test('an old QR read cannot change a modal opened for another session', async () => {
  const old = pendingQrReply();
  planQrReplies(
    { path: '/api/sessions/s1/qr', answer: old.promise },
    { path: '/api/sessions/s2/qr', answer: qrReply('SECOND') },
  );
  const { result } = renderQrVisit();
  let first!: Promise<void>;
  await rtl.act(async () => {
    first = result.current.handleShowQR('s1');
    await settleQrReply();
  });
  rtl.act(() => result.current.handleCloseQRModal());
  await rtl.act(async () => {
    await result.current.handleShowQR('s2');
  });
  await rtl.act(async () => {
    old.resolve(qrReply('FIRST'));
    await first;
  });
  assert.equal(result.current.qrData?.sessionId, 's2');
  assert.equal(result.current.qrData?.qrCode, 'SECOND');
});

test('phone pairing keeps its visit generation when a QR push arrives', async () => {
  const old = pendingQrReply(),
    current = pendingQrReply();
  planQrReplies(
    { path: '/api/sessions/s1/qr', answer: qrReply('FIRST') },
    { path: '/api/sessions/s1/pairing-code', method: 'POST', answer: old.promise },
    { path: '/api/sessions/s1/qr', answer: qrReply('SECOND') },
    { path: '/api/sessions/s1/pairing-code', method: 'POST', answer: current.promise },
  );
  const { result } = renderQrVisit();
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  rtl.act(() => {
    result.current.selectPairingTab(true);
    result.current.setPhoneNumber('15550000001');
  });
  let first!: Promise<void>, second!: Promise<void>;
  await rtl.act(async () => {
    first = result.current.handleGeneratePairingCode();
    await settleQrReply();
  });
  rtl.act(() => result.current.handleCloseQRModal());
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  rtl.act(() => {
    result.current.selectPairingTab(true);
    result.current.setPhoneNumber('15550000002');
  });
  await rtl.act(async () => {
    second = result.current.handleGeneratePairingCode();
    await settleQrReply();
  });
  rtl.act(() => result.current.applyQrPush({ sessionId: 's1', qrCode: 'NEW-QR' }));
  await rtl.act(async () => {
    current.resolve(new Response(JSON.stringify({ pairingCode: 'NEW-PAIR', status: 'qr_ready' })));
    await second;
  });
  await rtl.act(async () => {
    old.resolve(new Response(JSON.stringify({ pairingCode: 'OLD-PAIR', status: 'qr_ready' })));
    await first;
  });
  assert.equal(result.current.pairingCode, 'NEW-PAIR');
  assert.equal(result.current.requestingPairing, false);
});
