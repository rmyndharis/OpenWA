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

const SESSIONS = [SESSION_QR, SESSION_STALE_ENGINE, SESSION_TIMELOCKED];

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
}

function findFetchCall(method: string, path: string): FetchCall | undefined {
  return fetchCalls.find(c => c.method === method && c.path === path);
}

// URL router for every endpoint the page can reach. Anything else 404s loudly instead of resolving
// into a confusing downstream failure. Lifecycle actions (start/stop/logout/force-kill/pairing-code)
// are stubbed generically even though none of the three cases below trigger them, per the brief's
// endpoint list — a future case exercising them should not need to touch this stub.
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

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse(SESSIONS));

    if (method === 'POST' && path === '/api/sessions') {
      const name = (body as { name?: string } | undefined)?.name ?? 'unnamed';
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
      return Promise.resolve(jsonResponse({ ...base, status: 'disconnected', engineLoaded: false }));
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
  // Deliberately NOT setting sessionStorage['openwa_api_key']: useWebSocket.connect() reads it and
  // bails with a console.warn when it's absent. Setting it would make socket.io actually dial
  // http://localhost/events and hit ECONNREFUSED in this environment.
  await import('../i18n/index.ts');
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Sessions } = await import('./Sessions.tsx'));
});

afterEach(() => {
  rtl.cleanup();
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
