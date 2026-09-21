// Render smoke test for the Sessions page under the bare `node --test` runner. Mirrors
// Chats.test.ts's harness (same providers pattern, same recorded-fetch-stub approach, same loader
// hooks) but adds two things Chats does not need: RoleProvider must actually grant write access
// (useRole().canWrite gates every action button), and the WebSocket hook must be kept dormant
// (see the sessionStorage note below) rather than stubbed.
//
// This file exists to build the safety net BEFORE Sessions.tsx is decomposed into hooks/child
// components. The case that matters most pins the exact bug class that decomposition risks: the
// pairing panel (QR modal, Phone tab) renders only while `pairingMode` is true, and the tab
// buttons just flip that boolean — so `phoneNumber` only survives a QR<->Phone toggle today
// because Sessions.tsx itself owns the state. Moving it into an extracted child that unmounts on
// tab switch would silently discard it, exactly like the chat draft and staged attachment bugs
// Chats.test.ts caught.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
import { holdConnect, lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

const SESSION_QR: Session = {
  id: 'sess-qr-1',
  name: 'new-device',
  status: 'qr_ready',
  engineLoaded: true,
  phone: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// `disconnected` is a status the pre-engineLoaded fallback rule treats as NOT started (Start would
// be offered). engineLoaded: true overrides that — the gateway still holds a live engine (e.g. mid
// automatic-reconnect backoff), so the card must offer Stop/Unlink/Kill Stuck instead. Pins that
// the action gate reads session.engineLoaded, not session.status.
const SESSION_STALE_ENGINE: Session = {
  id: 'sess-stale-1',
  name: 'stale-engine',
  status: 'disconnected',
  engineLoaded: true,
  phone: '15550009999',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// `initializing` on a session that is STILL LINKED: the Baileys adapter parks one there for the
// whole reconnect backoff after a transient close. The card used to branch on status alone and paint
// it as the pairing placeholder, hiding the phone, so a linked account read as an unlinked one.
const SESSION_RECONNECTING: Session = {
  id: 'sess-reconnecting-1',
  name: 'reconnecting-bot',
  status: 'initializing',
  engineLoaded: true,
  phone: '15550002222',
  lastActive: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A reachout timelock leaves the account fully connected — `ready` plus a restriction is the normal
// shape, and the card must show it there. A restriction hidden behind a failed/disconnected status
// (the rule `lastError` follows) would be invisible in exactly the case that matters.
const SESSION_TIMELOCKED: Session = {
  id: 'sess-limited-1',
  name: 'limited-bot',
  status: 'ready',
  engineLoaded: true,
  phone: '15550001111',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  restriction: { kind: 'reachout_timelock', code: 'BIZ_QUALITY', expiresAt: '2026-08-04T09:00:00.000Z' },
};

const SESSIONS = [SESSION_QR, SESSION_STALE_ENGINE, SESSION_TIMELOCKED, SESSION_RECONNECTING];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];

function resetFetchCalls(): void {
  fetchCalls.length = 0;
  sessionProxy = { enabled: false, proxyType: null, proxyHost: null, hasCredentials: false };
  proxyGetFails = false;
  sessionListFailures = 0;
  distinctFailureMessages = false;
  startFailure = null;
  startGate = null;
  startResult = null;
}

function findFetchCall(method: string, path: string): FetchCall | undefined {
  return fetchCalls.find(c => c.method === method && c.path === path);
}

// URL router for every endpoint the page can reach. Anything else 404s loudly instead of resolving
// into a confusing downstream failure. Lifecycle actions (start/stop/logout/force-kill) share one stub
// that answers with a stopped row; `startFailure`, `startResult` and `startGate` below change how a start
// answers.
// Mutable so a test can set the starting value and observe what a PATCH wrote back.
let sessionConfig = { autoRejectCalls: false, maxReconnectAttempts: null as number | null, reconnectBaseDelay: 5000 };
let configPatchFails = false;
let proxyGetFails = false;
// How many of the next GET /api/sessions reads fail, as they do while the gateway is down.
let sessionListFailures = 0;
// Whether each failed read carries its own message, as a 502, a 504 and a dropped connection do.
let distinctFailureMessages = false;
// When set, POST .../start answers with this error, first applying `leaves` to the session's row: the
// state the gateway was left in, which is what the page reads back after the failure.
let startFailure: { status: number; message: string; leaves?: Partial<Session> } | null = null;
// When set, a successful POST .../start answers with the session's row merged with `answer`, and applies
// `leaves` (by default `answer` itself) to the row the page reads back, instead of answering a stopped row.
let startResult: { answer: Partial<Session>; leaves?: Partial<Session> } | null = null;
// When set, POST .../start answers, whichever way it answers, only once this settles.
let startGate: Promise<void> | null = null;
let sessionProxy = {
  enabled: false,
  proxyType: null as string | null,
  proxyHost: null as string | null,
  hasCredentials: false,
};

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ method, path, body });

    if (method === 'GET' && path === '/api/sessions') {
      if (sessionListFailures > 0) {
        sessionListFailures -= 1;
        const message = distinctFailureMessages
          ? `gateway unavailable (${sessionListFailures})`
          : 'gateway unavailable';
        return Promise.resolve(jsonResponse({ message }, 503));
      }
      return Promise.resolve(jsonResponse(SESSIONS));
    }

    if (method === 'POST' && path === '/api/sessions') {
      const payload = body as { name?: string; proxyUrl?: string; proxyType?: string } | undefined;
      const name = payload?.name ?? 'unnamed';
      return Promise.resolve(
        jsonResponse({
          id: `sess-new-${name}`,
          name,
          status: 'created',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }

    const sessionIdMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionIdMatch) {
      const found = SESSIONS.find(s => s.id === sessionIdMatch[1]);
      return found
        ? Promise.resolve(jsonResponse(found))
        : Promise.resolve(jsonResponse({ message: 'not found' }, 404));
    }
    if (method === 'DELETE' && sessionIdMatch) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    const configMatch = path.match(/^\/api\/sessions\/([^/]+)\/config$/);
    if (configMatch) {
      if (method === 'GET') return Promise.resolve(jsonResponse({ ...sessionConfig }));
      if (method === 'PATCH') {
        // Per-test switch: the revert case needs the write to fail while the initial read succeeds,
        // which a single stub response cannot express.
        if (configPatchFails) return Promise.resolve(jsonResponse({ message: 'nope' }, 500));
        Object.assign(sessionConfig, body as Record<string, unknown>);
        return Promise.resolve(jsonResponse({ ...sessionConfig }));
      }
    }

    const proxyMatch = path.match(/^\/api\/sessions\/([^/]+)\/proxy$/);
    if (proxyMatch) {
      if (method === 'GET' && proxyGetFails) return Promise.resolve(jsonResponse({ message: 'boom' }, 500));
      if (method === 'GET') return Promise.resolve(jsonResponse({ ...sessionProxy }));
      if (method === 'PATCH') {
        const payload = body as { proxyUrl?: string | null } | undefined;
        if (payload?.proxyUrl === null) {
          sessionProxy = { enabled: false, proxyType: null, proxyHost: null, hasCredentials: false };
        } else if (payload?.proxyUrl) {
          const parsed = new URL(payload.proxyUrl);
          const scheme = parsed.protocol.replace(':', '');
          sessionProxy = {
            enabled: true,
            proxyType: scheme,
            proxyHost: parsed.host,
            hasCredentials: !!(parsed.username || parsed.password),
          };
        }
        return Promise.resolve(jsonResponse({ ...sessionProxy }));
      }
    }

    const qrMatch = path.match(/^\/api\/sessions\/([^/]+)\/qr$/);
    if (method === 'GET' && qrMatch) {
      const found = SESSIONS.find(s => s.id === qrMatch[1]);
      if (!found) return Promise.resolve(jsonResponse({ message: 'not found' }, 404));
      return Promise.resolve(jsonResponse({ qrCode: 'data:image/png;base64,FAKE', status: found.status }));
    }

    const pairingMatch = path.match(/^\/api\/sessions\/([^/]+)\/pairing-code$/);
    if (method === 'POST' && pairingMatch) {
      return Promise.resolve(jsonResponse({ pairingCode: '12345678', status: 'qr_ready' }));
    }

    const lifecycleMatch = path.match(/^\/api\/sessions\/([^/]+)\/(start|stop|logout|force-kill)$/);
    if (method === 'POST' && lifecycleMatch) {
      const found = SESSIONS.find(s => s.id === lifecycleMatch[1]);
      const base = found ?? SESSION_STALE_ENGINE;
      const isStart = lifecycleMatch[2] === 'start';
      const answer = (): Response => {
        if (isStart && startFailure) {
          if (found) Object.assign(found, startFailure.leaves);
          return jsonResponse({ message: startFailure.message }, startFailure.status);
        }
        if (isStart && startResult) {
          const answered = { ...base, ...startResult.answer };
          if (found) Object.assign(found, startResult.leaves ?? startResult.answer);
          return jsonResponse(answered);
        }
        return jsonResponse({ ...base, status: 'disconnected', engineLoaded: false });
      };
      if (isStart && startGate) return startGate.then(answer);
      return Promise.resolve(answer());
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── Harness bootstrap ────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type SessionsModule = typeof import('./Sessions.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let Sessions: SessionsModule['Sessions'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // RoleProvider seeds from localStorage; 'admin' makes canWrite true, or every action button
  // (New Session, Stop/Start, Unlink, Delete, Kill Stuck) is hidden and there is nothing to test.
  window.localStorage.setItem('openwa_user_role', 'admin');
  // Deliberately NOT setting sessionStorage['openwa_api_key'] here: useWebSocket.connect() bails
  // with a console.warn when it's absent, so the page opens no socket. A case that drives the live
  // feed sets the key itself; the client it reaches is the socket.io double, which dials nothing.
  // Awaited, not just imported: catalogues are fetched now, so the import only starts the load and
  // the English copy these tests query by name renders as a raw key until it arrives.
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Sessions } = await import('./Sessions.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  window.sessionStorage.removeItem('openwa_api_key');
  resetSocketDouble();
  queryClient?.clear();
  queryClient = undefined;
});

function renderSessions(): { container: HTMLElement } {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Sessions))),
    ),
  );
}

// ── Smoke tests ──────────────────────────────────────────────────────────────

test('the session list renders, and action buttons gate on engineLoaded rather than status', async () => {
  const { screen, within } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  await screen.findByText('stale-engine');

  // stale-engine is `disconnected` (a status the old fallback rule treats as not-started, offering
  // Start) but engineLoaded: true — the card must offer Stop/Unlink/Kill Stuck instead, and never
  // Start, proving the gate reads engineLoaded rather than inferring it from status.
  const staleCard = screen.getByText('stale-engine').closest('.session-card') as HTMLElement;
  within(staleCard).getByRole('button', { name: 'Stop' });
  within(staleCard).getByRole('button', { name: 'Unlink' });
  within(staleCard).getByRole('button', { name: 'Kill Stuck' });
  assert.equal(within(staleCard).queryByRole('button', { name: 'Start' }), null);

  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  within(qrCard).getByRole('button', { name: 'Show QR' });
  within(qrCard).getByRole('button', { name: 'Proxy' });
});

test('a linked session that is reconnecting keeps its identity rows, not the pairing placeholder', async () => {
  const { screen, within } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('reconnecting-bot');
  const card = screen.getByText('reconnecting-bot').closest('.session-card') as HTMLElement;

  // The pill still says Starting..., which is honest: the engine really is between attempts.
  within(card).getByText('Starting...');
  // What must NOT be there: the pairing placeholder, which claims a QR is coming for an account that
  // is already linked.
  assert.equal(within(card).queryByText('Preparing QR code...'), null);
  assert.equal(card.querySelector('.qr-placeholder'), null);
  // What must be there: the number the operator needs to recognise the account.
  within(card).getByText('15550002222');
});

test('a never-linked session still gets the pairing placeholder', async () => {
  const { screen, within } = rtl;
  resetFetchCalls();
  renderSessions();

  // Same status family, no bound phone: this one really is waiting to be paired.
  await screen.findByText('new-device');
  const card = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  assert.ok(card.querySelector('.qr-placeholder'));
  within(card).getByRole('button', { name: 'Show QR' });
});

test('creating a session issues POST /api/sessions with the entered name', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  fireEvent.click(screen.getByRole('button', { name: 'New Session' }));

  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByPlaceholderText('e.g., marketing-bot'), { target: { value: 'backup-bot' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

  // The optimistic row alone would pass even if the POST body were wrong — assert the wire call.
  await waitFor(() => {
    const call = findFetchCall('POST', '/api/sessions');
    assert.ok(call, 'expected a POST to /sessions');
    assert.deepEqual(call!.body, { name: 'backup-bot' });
  });

  await screen.findByText('backup-bot');
});

test('opening the proxy modal fetches GET /api/sessions/:id/proxy', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Proxy' }));

  await screen.findByRole('dialog');
  await waitFor(() => {
    assert.ok(findFetchCall('GET', '/api/sessions/sess-qr-1/proxy'), 'expected a GET to /proxy');
  });
});

test('saving proxy settings issues PATCH /api/sessions/:id/proxy', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Proxy' }));

  const dialog = await screen.findByRole('dialog');
  const toggle = within(dialog).getByRole('checkbox');
  fireEvent.click(toggle);
  fireEvent.change(within(dialog).getByLabelText('Proxy URL'), {
    target: { value: 'http://user:pass@proxy.internal:8080' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    const call = findFetchCall('PATCH', '/api/sessions/sess-qr-1/proxy');
    assert.ok(call, 'expected a PATCH to /proxy');
    assert.deepEqual(call!.body, {
      proxyUrl: 'http://user:pass@proxy.internal:8080',
    });
  });
});

test('a typed pairing phone number survives toggling to the QR tab and back', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Show QR' }));

  // Wait for the eager GET .../qr fetch triggered by opening the modal to settle before driving
  // tab interactions, so its async setQrData doesn't land in the middle of the sequence below.
  await screen.findByAltText('QR');

  fireEvent.click(screen.getByRole('tab', { name: 'Link with Phone Number' }));
  const phoneInput = screen.getByLabelText('Phone Number') as HTMLInputElement;
  fireEvent.change(phoneInput, { target: { value: '919876543210' } });
  assert.equal(phoneInput.value, '919876543210');

  fireEvent.click(screen.getByRole('tab', { name: 'QR Code' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Link with Phone Number' }));

  assert.equal(
    (screen.getByLabelText('Phone Number') as HTMLInputElement).value,
    '919876543210',
    'the typed pairing phone number was lost after toggling tabs',
  );
});

// Nothing server-side refuses a pairing code for a number linked elsewhere, so the panel has to say
// what it can cost before the operator types one.
test('the phone pairing tab warns that a code can unlink an existing session', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Show QR' }));
  await screen.findByAltText('QR');

  fireEvent.click(screen.getByRole('tab', { name: 'Link with Phone Number' }));

  assert.ok(
    screen.getByText(/can make WhatsApp unlink that device/i),
    'the phone pairing tab offered a code with no warning',
  );
});

test('stopping a session dismisses its own open QR modal', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Show QR' }));

  // Wait for the eager GET .../qr fetch triggered by opening the modal to settle, same as the
  // toggle-persistence case above, so the assertion below isn't racing that fetch's state update.
  await screen.findByAltText('QR');
  assert.ok(screen.getByRole('dialog'), 'expected the QR modal to be open before stopping the session');

  // SESSION_QR has engineLoaded: true, so isSessionStarted puts a no-confirmation Stop button on
  // this same card (see the first test's engineLoaded-gate assertion) — the simplest deterministic
  // trigger for applySessionResponse, which is what calls the pairing hook's dismissQrForSession.
  // A neutered dismisser would leave this modal open, pointed at a session with no engine left.
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Stop' }));

  await waitFor(() => {
    assert.ok(findFetchCall('POST', '/api/sessions/sess-qr-1/stop'), 'expected a POST to the stop endpoint');
  });

  await waitFor(() => {
    // Never hand a live DOM node to assert.equal/deepEqual: on failure Node's assert machinery
    // inspects it for the diff, and a jsdom element wired up by React (parentNode/ownerDocument/the
    // internal fiber back-references) is cyclic enough that the inspection can hang the process
    // instead of failing fast. Reduce to a boolean first.
    assert.ok(!screen.queryByRole('dialog'), 'the QR modal stayed open after its session stopped');
  });
});

// A node that died mid-pairing leaves a row reading `qr_ready` with no engine behind it. Reconnect on
// that card has to start the session: the QR modal alone polls GET /qr, which answers 400 until one
// is started.
test('Reconnect on a qr_ready card with no engine loaded starts the session', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  SESSIONS.push({ ...SESSION_QR, id: 'sess-orphan-1', name: 'orphan-qr', engineLoaded: false });
  try {
    renderSessions();

    await screen.findByText('orphan-qr');
    const card = screen.getByText('orphan-qr').closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      assert.ok(findFetchCall('POST', '/api/sessions/sess-orphan-1/start'), 'expected a POST to the start endpoint');
    });
  } finally {
    SESSIONS.pop();
  }
});

test('a start that answers with its engine up opens the QR modal', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  startResult = { answer: { status: 'initializing', engineLoaded: true } };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-started-1', name: 'started', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('started')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));

    await screen.findByRole('dialog');
  } finally {
    SESSIONS.pop();
  }
});

// A start of a session that was already linked elsewhere comes back `ready`. The modal's own guard
// reads the sessions state of the render that began the start, which predates both the answer and the
// re-read, so the decision has to be taken from the re-read itself.
test('a start whose re-read shows the session ready opens no QR modal', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  startResult = {
    answer: { status: 'initializing', engineLoaded: true },
    leaves: { status: 'ready', engineLoaded: true },
  };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-ready-1', name: 'already-linked', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('already-linked')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));
    await waitFor(() => assert.ok(findFetchCall('POST', '/api/sessions/sess-ready-1/start')));
    // The re-read lands as this card turning Connected, which is also when the handler has decided
    // about the modal; the Start button is gone by then, so it cannot be the settle signal here.
    await waitFor(() => assert.ok(within(card).queryByText('Connected')));
    assert.ok(!screen.queryByRole('dialog'), 'a QR modal opened over a session that came back ready');
  } finally {
    SESSIONS.pop();
  }
});

// A start can answer 200 with an engine that is gone by the time the list is read back: a stop that landed
// while it ran retires it, and an engine can fail right after answering. The re-read decides, not the
// answer, since a QR modal over that session could only spin.
test('a start whose re-read shows no engine opens no QR modal', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  startResult = {
    answer: { status: 'initializing', engineLoaded: true },
    leaves: { status: 'created', engineLoaded: false },
  };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-retired-1', name: 'retired', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('retired')).closest('.session-card') as HTMLElement;
    const startButton = (): HTMLButtonElement => within(card).getByRole('button', { name: 'Start' });
    fireEvent.click(startButton());
    // The button is released in the same update that would open the modal, so once it is enabled again
    // the handler has finished and the modal's state is settled.
    await waitFor(() => assert.ok(findFetchCall('POST', '/api/sessions/sess-retired-1/start')));
    await waitFor(() => assert.ok(!startButton().disabled));
    assert.ok(!screen.queryByRole('dialog'), 'a QR modal opened for a start that left no engine');
  } finally {
    SESSIONS.pop();
  }
});

// A failed re-read says nothing about the engine, so a start the gateway accepted still opens the modal.
test('a start whose re-read fails still opens the QR modal', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  startResult = {
    answer: { status: 'initializing', engineLoaded: true },
    leaves: { status: 'created', engineLoaded: false },
  };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-unread-1', name: 'unread', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('unread')).closest('.session-card') as HTMLElement;
    sessionListFailures = 1;
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));

    await screen.findByRole('dialog');
  } finally {
    SESSIONS.pop();
  }
});

// A start refused before any engine exists (the concurrency cap) leaves no engine behind. A QR modal
// opened over that session can only spin, since its poll waits for a qr_ready that never comes, and the
// refusal itself is recorded nowhere the operator could find it.
test('a start refused without an engine shows the error instead of a QR modal', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  startFailure = { status: 400, message: 'Maximum concurrent sessions reached (1)' };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-capped-1', name: 'capped', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('capped')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));

    const alert = await screen.findByRole('alert');
    assert.ok(alert.classList.contains('toast-error'), 'the start failure was not shown as an error toast');
    within(alert).getByText('Start Failed');
    within(alert).getByText('Maximum concurrent sessions reached (1)');
    await waitFor(() => {
      assert.ok(findFetchCall('POST', '/api/sessions/sess-capped-1/start'));
    });
    assert.ok(!screen.queryByRole('dialog'), 'a QR modal opened for a session with no engine');
  } finally {
    SESSIONS.pop();
  }
});

// A reverse proxy can time out a start the gateway is still carrying out. The engine is registered, so
// the QR modal is still where the operator should wait.
test('a start that errors while its engine is coming up still opens the QR modal', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  startFailure = {
    status: 504,
    message: 'Gateway Timeout',
    leaves: { status: 'initializing', engineLoaded: true },
  };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-slow-1', name: 'slow-start', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('slow-start')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));

    await screen.findByRole('dialog');
    assert.ok(!screen.queryByRole('alert'), 'a start still in flight was reported as failed');
  } finally {
    SESSIONS.pop();
  }
});

// The toast carries what the gateway answered for THIS start. The row's lastError is left to the card:
// it can be the terse cause behind a diagnostic 504, or a reason left from an earlier attempt.
test('a failed start reports the gateway answer, not the row lastError', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  startFailure = {
    status: 504,
    message: 'WhatsApp Web authentication timed out.',
    leaves: { status: 'failed', engineLoaded: false, lastError: 'auth timeout' },
  };
  SESSIONS.push({ ...SESSION_QR, id: 'sess-nolaunch-1', name: 'no-launch', status: 'created', engineLoaded: false });
  try {
    renderSessions();

    const card = (await screen.findByText('no-launch')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));

    const alert = await screen.findByRole('alert');
    within(alert).getByText('WhatsApp Web authentication timed out.');
    assert.ok(!within(alert).queryByText('auth timeout'), 'the toast showed the row lastError');
    assert.ok(!screen.queryByRole('dialog'), 'a QR modal opened for a session with no engine');
  } finally {
    SESSIONS.pop();
  }
});

// A start can wait seconds before its engine exists (a logout teardown still settling), with nothing on
// the card to show it. A second click would be refused as "already starting" while the first succeeds.
test('Start and Reconnect stay disabled while that session start is in flight', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  let release: () => void = () => undefined;
  startGate = new Promise<void>(resolve => {
    release = resolve;
  });
  SESSIONS.push(
    { ...SESSION_QR, id: 'sess-pending-1', name: 'pending-start', status: 'created', engineLoaded: false },
    { ...SESSION_QR, id: 'sess-pending-2', name: 'pending-reconnect', status: 'failed', engineLoaded: false },
  );
  const starts = (id: string): number =>
    fetchCalls.filter(c => c.method === 'POST' && c.path === `/api/sessions/${id}/start`).length;
  try {
    renderSessions();

    const startCard = (await screen.findByText('pending-start')).closest('.session-card') as HTMLElement;
    const reconnectCard = screen.getByText('pending-reconnect').closest('.session-card') as HTMLElement;
    const startButton = (): HTMLButtonElement => within(startCard).getByRole('button', { name: 'Start' });
    const reconnectButton = (): HTMLButtonElement => within(reconnectCard).getByRole('button', { name: 'Reconnect' });

    fireEvent.click(startButton());
    await waitFor(() => assert.ok(startButton().disabled, 'Start stayed clickable during its start'));
    assert.ok(!reconnectButton().disabled, 'a start disabled another session');
    fireEvent.click(startButton());
    assert.equal(starts('sess-pending-1'), 1);

    fireEvent.click(reconnectButton());
    await waitFor(() => assert.ok(reconnectButton().disabled, 'Reconnect stayed clickable during its start'));

    release();
    await waitFor(() =>
      assert.ok(!startButton().disabled && !reconnectButton().disabled, 'a button stayed disabled after its start'),
    );
  } finally {
    SESSIONS.pop();
    SESSIONS.pop();
  }
});

function pushSessionStatus(sessionId: string, status: string): void {
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  rtl.act(() => {
    socket.receive('message', {
      type: 'event',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { event: 'session.status', sessionId, data: { status } },
    });
  });
}

// Every FAILED write evicts the engine, so the modal can never show a code again. Covers a start that
// returned 200 and failed afterwards, which is the only way a QR-stage failure surfaces on Baileys.
test('a failed status push closes that session QR modal', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  renderSessions();

  const card = (await screen.findByText('new-device')).closest('.session-card') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: 'Show QR' }));
  await screen.findByAltText('QR');

  pushSessionStatus(SESSION_STALE_ENGINE.id, 'failed');
  assert.ok(screen.queryByRole('dialog'), "another session's failure closed this QR modal");

  pushSessionStatus(SESSION_QR.id, 'failed');

  await waitFor(() => assert.ok(!screen.queryByRole('dialog'), 'the QR modal stayed open after its session failed'));
});

// `disconnected` covers both an engine inside its reconnect backoff and one that is gone, so the modal
// closes only once the re-read says there is no engine.
test('a disconnected push closes the QR modal once the re-read shows no engine', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const row: Session = { ...SESSION_QR, id: 'sess-dropped-1', name: 'dropped', status: 'qr_ready', engineLoaded: true };
  SESSIONS.push(row);
  try {
    renderSessions();

    const card = (await screen.findByText('dropped')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Show QR' }));
    await screen.findByAltText('QR');

    Object.assign(row, { status: 'disconnected', engineLoaded: false });
    pushSessionStatus(row.id, 'disconnected');

    await waitFor(() => assert.ok(!screen.queryByRole('dialog'), 'the QR modal stayed open with no engine left'));
  } finally {
    SESSIONS.pop();
  }
});

// The disconnect handler blanks the code, then asks the server whether an engine is still
// registered, and closes the modal on the answer. A reconnect can finish inside that window and push
// a fresh, scannable code; closing then would throw it away.
test('a QR pushed while the disconnect re-read is in flight keeps the modal open', async () => {
  const { screen, fireEvent, within, waitFor, act } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const row: Session = { ...SESSION_QR, id: 'sess-raced-1', name: 'raced', status: 'qr_ready', engineLoaded: true };
  SESSIONS.push(row);
  try {
    renderSessions();

    const card = (await screen.findByText('raced')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Show QR' }));
    await screen.findByAltText('QR');

    // The server answer will say the engine is gone, which is what used to close the modal outright.
    Object.assign(row, { status: 'disconnected', engineLoaded: false });
    // Counted BEFORE the push: the mount already read the list once, so waiting for "a GET happened"
    // would be satisfied by that one and would settle before the handler's own re-read resolves.
    const readsBeforeDisconnect = fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
    pushSessionStatus(row.id, 'disconnected');

    // A fresh code lands before that answer is applied.
    const socket = lastSocket();
    assert.ok(socket, 'expected the page to have opened a socket');
    act(() => {
      socket.receive('message', {
        type: 'event',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          event: 'session.qr',
          sessionId: row.id,
          data: { qrCode: 'data:image/png;base64,FRESH' },
        },
      });
    });

    // The fresh code is on screen, so the push really landed in the modal that is being judged.
    await waitFor(() =>
      assert.equal((screen.getByAltText('QR') as HTMLImageElement).src, 'data:image/png;base64,FRESH'),
    );
    // And the handler's re-read has resolved, so the close decision has already been taken.
    await waitFor(() =>
      assert.ok(
        fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length > readsBeforeDisconnect,
      ),
    );
    assert.ok(screen.queryByRole('dialog'), 'the modal closed over a QR code that had just arrived');
  } finally {
    SESSIONS.pop();
  }
});

test('a disconnected push keeps the QR modal while the engine is still registered', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const row: Session = { ...SESSION_QR, id: 'sess-backoff-1', name: 'backoff', status: 'qr_ready', engineLoaded: true };
  SESSIONS.push(row);
  try {
    renderSessions();

    const card = (await screen.findByText('backoff')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Show QR' }));
    await screen.findByAltText('QR');

    row.status = 'disconnected';
    pushSessionStatus(row.id, 'disconnected');

    // The push drops engineLoaded, so the card offers Start until the re-read restores it and brings Stop
    // back: once Stop is there, the re-read has been applied.
    await within(card).findByRole('button', { name: 'Stop' });
    assert.ok(screen.queryByRole('dialog'), 'the QR modal closed while the engine was still registered');
  } finally {
    SESSIONS.pop();
  }
});

// The code on screen belongs to the connection that just dropped, so it is cleared even when the
// modal stays: the engine reconnects and pushes a fresh one, and a dead code must not be scannable
// in the meantime.
test('a disconnected push blanks the displayed QR code', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const row: Session = { ...SESSION_QR, id: 'sess-blank-1', name: 'blanked', status: 'qr_ready', engineLoaded: true };
  SESSIONS.push(row);
  try {
    renderSessions();

    const card = (await screen.findByText('blanked')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Show QR' }));
    await screen.findByAltText('QR');

    row.status = 'disconnected';
    pushSessionStatus(row.id, 'disconnected');

    await waitFor(() => assert.ok(!screen.queryByAltText('QR'), 'the dead QR code stayed on screen'));
    assert.ok(screen.queryByRole('dialog'), 'the QR modal closed while the engine was still registered');
  } finally {
    SESSIONS.pop();
  }
});

// A re-read that fails says nothing about the engine, so the modal stays.
test('a disconnected push keeps the QR modal when the re-read fails', async () => {
  const { screen, fireEvent, within, act } = rtl;
  resetFetchCalls();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const row: Session = { ...SESSION_QR, id: 'sess-unknown-1', name: 'unknown', status: 'qr_ready', engineLoaded: true };
  SESSIONS.push(row);
  try {
    renderSessions();

    const card = (await screen.findByText('unknown')).closest('.session-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Show QR' }));
    await screen.findByAltText('QR');

    sessionListFailures = 1;
    pushSessionStatus(row.id, 'disconnected');

    await screen.findByText('gateway unavailable');
    // Let the re-read's continuation run and any state it sets render before looking.
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    assert.ok(screen.queryByRole('dialog'), 'the QR modal closed on a re-read that failed');
  } finally {
    SESSIONS.pop();
  }
});

test('a restricted session shows the restriction on its card, even while it is ready', async () => {
  const { screen, within } = rtl;
  resetFetchCalls();
  renderSessions();

  const card = (await screen.findByText('limited-bot')).closest('.session-card') as HTMLElement;

  within(card).getByText('Restriction');
  const value = within(card).getByText('New chats blocked');
  // The raw engine token and the expiry ride in the tooltip: `code` is searchable but not readable,
  // so it must not become the visible label.
  assert.match(value.getAttribute('title') ?? '', /BIZ_QUALITY/);
  assert.match(value.getAttribute('title') ?? '', /until/);
});

test('an unrestricted session shows no restriction row', async () => {
  const { screen, within } = rtl;
  resetFetchCalls();
  renderSessions();

  const card = (await screen.findByText('stale-engine')).closest('.session-card') as HTMLElement;

  assert.equal(within(card).queryByText('Restriction'), null);
});

// ── Live feed banner ─────────────────────────────────────────────────────────

test('Refresh on a feed that never connected re-reads the list once the socket is back', async () => {
  const { screen, fireEvent, waitFor, act, within } = rtl;
  resetFetchCalls();
  sessionListFailures = 1;
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  holdConnect();
  renderSessions();

  // The gateway is down at mount: the list read fails, and nothing is rendered to go stale.
  await screen.findByText('gateway unavailable');
  const listReads = (): number => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  assert.equal(listReads(), 1);

  // A rejected handshake: socket.io decodes the CONNECT ack and the server's close from one polling
  // payload, so React batches both handlers and `isConnected` never renders true on this mount.
  const rejected = lastSocket();
  assert.ok(rejected, 'expected the page to have opened a socket');
  act(() => {
    rejected.receive('connect');
    rejected.receive('disconnect', 'io server disconnect');
  });
  const banner = await screen.findByRole('alert');
  screen.getByText('Live updates disconnected');

  fireEvent.click(within(banner).getByRole('button', { name: 'Refresh' }));
  const redialed = lastSocket();
  assert.ok(redialed && redialed !== rejected, 'expected Refresh to open a fresh socket');
  act(() => redialed.receive('connect'));

  // Every push sent while the feed was dead is gone, so the recovered page must re-read the list, and
  // the error from the failed mount read must not sit on top of the cards it now shows.
  await waitFor(() => assert.equal(listReads(), 2));
  await screen.findByText('new-device');
  // Compared as booleans: a failing assert.equal renders both operands, and a jsdom node never finishes.
  assert.equal(
    screen.queryByText('gateway unavailable') === null,
    true,
    'expected the re-read to clear the failed read error',
  );
  assert.equal(screen.queryByRole('alert') === null, true, 'expected the feed banner to be gone once connected');
});

test('a failed mount read is retried when the feed first connects after its own retries', async () => {
  const { screen, waitFor, act } = rtl;
  resetFetchCalls();
  sessionListFailures = 1;
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  holdConnect();
  renderSessions();

  await screen.findByText('gateway unavailable');
  const listReads = (): number => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  assert.equal(listReads(), 1);

  // socket.io's manager retried the handshake on its own and it went through: this is the socket's
  // FIRST connect, so the feed reports no reconnect and nothing else re-reads the list.
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('connect'));

  await waitFor(() => assert.equal(listReads(), 2));
  await screen.findByText('new-device');
  assert.equal(
    screen.queryByText('gateway unavailable') === null,
    true,
    'expected the retry to clear the failed read error',
  );
});

test('a later failure on the same connection is retried too, once the first recovery succeeded', async () => {
  const { screen, waitFor, act } = rtl;
  resetFetchCalls();
  sessionListFailures = 1;
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  holdConnect();
  renderSessions();

  await screen.findByText('gateway unavailable');
  const listReads = (): number => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('connect'));

  // The connect spends the one retry this connect is allowed and the read succeeds, so the page is
  // healthy again, and the allowance must come back with it.
  await waitFor(() => assert.equal(listReads(), 2));
  await screen.findByText('new-device');

  // Much later, on the SAME socket: a restriction push re-reads the list and that read fails. Nothing
  // else on the page re-reads (the banner's Refresh renders only on a dead feed), so a spent allowance
  // would leave the operator with a stale list under a red box and no control to clear it.
  sessionListFailures = 1;
  act(() => {
    socket.receive('message', {
      type: 'event',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { event: 'session.restriction', sessionId: SESSION_QR.id, data: {} },
    });
  });

  await waitFor(() => assert.equal(listReads(), 4));
  await waitFor(() =>
    assert.equal(
      screen.queryByText('gateway unavailable') === null,
      true,
      'expected the retry to clear the failed read error',
    ),
  );
});

test('a connect retries a failed list read once, even when each failure carries a new message', async () => {
  const { screen, act } = rtl;
  resetFetchCalls();
  sessionListFailures = 10;
  distinctFailureMessages = true;
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  holdConnect();
  renderSessions();

  await screen.findByText('gateway unavailable (9)');
  const listReads = (): number => fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/sessions').length;
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  act(() => socket.receive('connect'));

  await screen.findByText('gateway unavailable (8)');
  // Give a re-read driven by the changed error time to fire before counting.
  await act(() => new Promise(resolve => setTimeout(resolve, 50)));
  assert.equal(listReads(), 2);
});

test('a read-only key gets no Show QR button, since the QR is operator-only', async () => {
  const { screen, within } = rtl;
  resetFetchCalls();
  window.localStorage.setItem('openwa_user_role', 'viewer');
  try {
    renderSessions();
    const card = (await screen.findByText('new-device')).closest('.session-card') as HTMLElement;
    // The pairing placeholder still renders; only the action that would poll a 403 is gone.
    assert.ok(card.querySelector('.qr-placeholder'));
    assert.equal(within(card).queryByRole('button', { name: 'Show QR' }) === null, true);
  } finally {
    window.localStorage.setItem('openwa_user_role', 'admin');
  }
});

// ── Auto-reject toggle ───────────────────────────────────────────────────────

async function openDetailFor(name: string): Promise<HTMLInputElement> {
  const { screen, within } = rtl;
  const card = (await screen.findByText(name)).closest('.session-card') as HTMLElement;
  rtl.fireEvent.click(within(card).getByRole('button', { name: 'View' }));
  // The config is fetched when the modal opens, so the toggle only appears once that read lands —
  // findBy, not getBy.
  return (await screen.findByRole('checkbox')) as HTMLInputElement;
}

test('the auto-reject toggle reflects the stored config and patches only the key it owns', async () => {
  resetFetchCalls();
  sessionConfig = { autoRejectCalls: false, maxReconnectAttempts: null, reconnectBaseDelay: 5000 };
  configPatchFails = false;
  renderSessions();

  const toggle = await openDetailFor('new-device');
  assert.equal(toggle.checked, false);

  rtl.fireEvent.click(toggle);
  await rtl.waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PATCH')));

  const patch = fetchCalls.find(c => c.method === 'PATCH');
  assert.match(patch?.path ?? '', /\/api\/sessions\/[^/]+\/config$/);
  // Only autoRejectCalls: sending the whole object would rewrite the two reconnect keys this screen
  // never showed the operator, and a merge patch exists precisely to avoid that.
  assert.deepEqual(patch?.body, { autoRejectCalls: true });
  await rtl.waitFor(() => assert.equal((rtl.screen.getByRole('checkbox') as HTMLInputElement).checked, true));
});

test('a rejected write reverts the toggle instead of leaving it showing a state the gateway never accepted', async () => {
  resetFetchCalls();
  sessionConfig = { autoRejectCalls: false, maxReconnectAttempts: null, reconnectBaseDelay: 5000 };
  configPatchFails = true;
  renderSessions();

  const toggle = await openDetailFor('new-device');
  assert.equal(toggle.checked, false);

  rtl.fireEvent.click(toggle);
  await rtl.waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PATCH')));

  // The optimistic flip must not survive the failure: a toggle left on would tell the operator calls
  // are being auto-rejected when the gateway still has it off.
  await rtl.waitFor(() => assert.equal((rtl.screen.getByRole('checkbox') as HTMLInputElement).checked, false));
  configPatchFails = false;
});

test('a failed proxy read offers no Save, so it cannot clear a proxy nobody could see', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  // The session HAS a proxy, with credentials the API deliberately never returns. Reading it fails.
  sessionProxy = { enabled: true, proxyType: 'socks5', proxyHost: 'proxy.internal:1080', hasCredentials: true };
  proxyGetFails = true;
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Proxy' }));

  const dialog = await screen.findByRole('dialog');
  await waitFor(() => assert.ok(findFetchCall('GET', '/api/sessions/sess-qr-1/proxy')));

  // No editable form and no Save: an "off" toggle here would read as "no proxy configured", and
  // saving from that state sends proxyUrl:null, destroying the stored URL and its credentials.
  await waitFor(() => assert.equal(within(dialog).queryByRole('button', { name: 'Save' }), null));
  assert.equal(within(dialog).queryByRole('checkbox'), null);
  assert.equal(findFetchCall('PATCH', '/api/sessions/sess-qr-1/proxy'), undefined);
});

test('saving without retyping the URL leaves the stored proxy and its credentials alone', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetFetchCalls();
  sessionProxy = { enabled: true, proxyType: 'http', proxyHost: 'proxy.internal:8080', hasCredentials: true };
  renderSessions();

  await screen.findByText('new-device');
  const qrCard = screen.getByText('new-device').closest('.session-card') as HTMLElement;
  fireEvent.click(within(qrCard).getByRole('button', { name: 'Proxy' }));

  const dialog = await screen.findByRole('dialog');
  await waitFor(() => assert.ok(findFetchCall('GET', '/api/sessions/sess-qr-1/proxy')));
  // The URL field is deliberately empty: credentials are never sent back to render.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
  assert.equal(
    findFetchCall('PATCH', '/api/sessions/sess-qr-1/proxy'),
    undefined,
    'an untouched form must not write, or it would replace a credentialed URL with nothing',
  );
});
