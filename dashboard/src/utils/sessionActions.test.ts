import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canForceKillSession,
  canUnlinkSession,
  classifyUnlinkError,
  isSessionStarted,
  replaceSession,
} from './sessionActions.ts';
import type { Session } from '../services/api.ts';

// A minimal-but-complete Session factory for the pure-state assertions. Only id/name/status vary
// in the tests; the rest mirrors the dashboard Session type so the typed helper accepts it.
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'session-1',
    status: 'ready',
    phone: '+155512345',
    pushName: 'Alice',
    lastActive: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ENGINE_BACKED_STATUSES = ['initializing', 'qr_ready', 'authenticating', 'ready', 'action_required'] as const;
const ENGINELESS_STATUSES = ['created', 'failed'] as const;

// The gateway's `engineLoaded` is authoritative: it is read from the live engine map per request, and
// it is the precondition the lifecycle routes actually enforce. Status is not a proxy for it.
test('isSessionStarted: engineLoaded decides, whatever the status says', () => {
  for (const status of [...ENGINE_BACKED_STATUSES, ...ENGINELESS_STATUSES, 'disconnected'] as Session['status'][]) {
    assert.equal(isSessionStarted(makeSession({ status, engineLoaded: true })), true, `${status} + engine`);
    assert.equal(isSessionStarted(makeSession({ status, engineLoaded: false })), false, `${status} + no engine`);
  }
});

// The case that was unrepresentable before: `disconnected` means BOTH "mid automatic-reconnect, engine
// still registered, start() answers 400" and "stopped, no engine, Start is the right action".
test('isSessionStarted: a disconnected session mid-reconnect is started, a stopped one is not', () => {
  const reconnecting = makeSession({ status: 'disconnected', engineLoaded: true });
  const stopped = makeSession({ status: 'disconnected', engineLoaded: false });

  assert.equal(isSessionStarted(reconnecting), true);
  assert.equal(isSessionStarted(stopped), false);
  // So the wedged one offers the recovery actions and does NOT offer Start.
  assert.equal(canForceKillSession(reconnecting, true), true);
  assert.equal(canUnlinkSession(reconnecting, true), true);
  assert.equal(canForceKillSession(stopped, true), false);
  assert.equal(canUnlinkSession(stopped, true), false);
});

// A gateway older than the field sends no engineLoaded; the helper must not read `undefined` as false
// and hide every action. It falls back to the historical status set instead.
test('isSessionStarted: falls back to the status set when the gateway omits engineLoaded', () => {
  for (const status of ENGINE_BACKED_STATUSES) {
    assert.equal(isSessionStarted(makeSession({ status, engineLoaded: undefined })), true, status);
  }
  for (const status of [...ENGINELESS_STATUSES, 'disconnected'] as Session['status'][]) {
    assert.equal(isSessionStarted(makeSession({ status, engineLoaded: undefined })), false, status);
  }
});

test('canUnlinkSession: unlinkable is exactly started — Stop and Unlink share one precondition', () => {
  for (const status of ENGINE_BACKED_STATUSES) {
    const session = makeSession({ status, engineLoaded: true });
    assert.equal(canUnlinkSession(session, true), true, status);
    assert.equal(canUnlinkSession(session, true), isSessionStarted(session), `${status} must track Stop`);
  }
  for (const status of ENGINELESS_STATUSES) {
    assert.equal(canUnlinkSession(makeSession({ status, engineLoaded: false }), true), false, status);
  }
});

test('canUnlinkSession: a read-only role never sees the action, even for a started session', () => {
  assert.equal(canUnlinkSession(makeSession({ status: 'ready', engineLoaded: true }), false), false);
});

// Force-kill is the emergency hatch for a WEDGED engine, so it must be offered exactly when a live
// engine exists — never for FAILED, whose engine is evicted on the way to that status.
test('canForceKillSession: offered whenever an engine is loaded, hidden for terminal FAILED', () => {
  for (const status of ENGINE_BACKED_STATUSES) {
    assert.equal(
      canForceKillSession(makeSession({ status, engineLoaded: true }), true),
      true,
      `${status} is engine-backed and should offer kill`,
    );
  }
  assert.equal(canForceKillSession(makeSession({ status: 'failed', engineLoaded: false }), true), false);
  assert.equal(canForceKillSession(makeSession({ status: 'created', engineLoaded: false }), true), false);
});

test('canForceKillSession: a read-only role never sees the action, even for a started session', () => {
  assert.equal(canForceKillSession(makeSession({ status: 'ready', engineLoaded: true }), false), false);
});

// ── replaceSession ────────────────────────────────────────────────────────────

// The authoritative API response replaces the matching row verbatim — losing phone:null was the
// original bug, so the test pins that the exact response object is stored, not a merge.
test('replaceSession: the exact authoritative response replaces the matching row, including phone:null', () => {
  const before = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];
  const updated = makeSession({ id: 'b', status: 'disconnected', phone: null, pushName: null, lastActive: null });
  const result = replaceSession(before, updated);

  assert.equal(result.length, 2);
  assert.deepEqual(result[1], updated);
  assert.equal(result[1].phone, null);
  assert.equal(result[1].pushName, null);
  assert.equal(result[1].lastActive, null);
});

test('replaceSession: unrelated rows keep their identity and order', () => {
  const a = makeSession({ id: 'a', name: 'alpha' });
  const b = makeSession({ id: 'b', name: 'bravo' });
  const c = makeSession({ id: 'c', name: 'charlie' });
  const updated = makeSession({ id: 'b', status: 'disconnected' });
  const result = replaceSession([a, b, c], updated);

  assert.deepEqual(
    result.map(s => s.id),
    ['a', 'b', 'c'],
  );
  assert.equal(result[0], a, 'unrelated row keeps identity');
  assert.equal(result[2], c, 'unrelated row keeps identity');
  assert.equal(result[1], updated, 'matching row is the exact response object');
});

test('replaceSession: nullable pushName / lastActive are accepted and preserved', () => {
  const before = [makeSession({ id: 'a', pushName: 'Alice', lastActive: '2025-01-01T00:00:00.000Z' })];
  const updated = makeSession({ id: 'a', pushName: null, lastActive: null });
  const result = replaceSession(before, updated);
  assert.equal(result[0].pushName, null);
  assert.equal(result[0].lastActive, null);
});

test('replaceSession: a response whose id is absent does not drop other rows (no match → no change)', () => {
  const a = makeSession({ id: 'a' });
  const b = makeSession({ id: 'b' });
  const orphan = makeSession({ id: 'zzz', status: 'disconnected' });
  const result = replaceSession([a, b], orphan);
  assert.deepEqual(
    result.map(s => s.id),
    ['a', 'b'],
  );
  assert.equal(result[0], a);
  assert.equal(result[1], b);
});

test('replaceSession: an empty list stays empty', () => {
  assert.deepEqual(replaceSession([], makeSession({ id: 'a' })), []);
});

// ── classifyUnlinkError ───────────────────────────────────────────────────────
//
// Only the gateway's own stable code SESSION_LOGOUT_INCOMPLETE means "stopped locally but the
// unlink operation is incomplete". A bare OR JSON reverse-proxy 502 without that exact code stays
// generic — the request may never have reached the gateway, so nothing was stopped.

test('classifyUnlinkError: the SESSION_LOGOUT_INCOMPLETE code yields incomplete', () => {
  const err = new Error('Session was stopped locally, but the logout operation is incomplete') as Error & {
    status?: number;
    code?: string;
  };
  err.status = 502;
  err.code = 'SESSION_LOGOUT_INCOMPLETE';
  assert.equal(classifyUnlinkError(err), 'incomplete');
});

test('classifyUnlinkError: a bare reverse-proxy 502 (no code) stays generic', () => {
  const err = new Error('HTTP 502') as Error & { status?: number; code?: string };
  err.status = 502;
  assert.equal(classifyUnlinkError(err), 'generic');
});

test('classifyUnlinkError: a JSON 502 WITHOUT the exact code stays generic', () => {
  const err = new Error('some upstream proxy error') as Error & { status?: number; code?: string };
  err.status = 502;
  err.code = 'UPSTREAM_TIMEOUT'; // a foreign code, even on a 502, is not our gateway signal
  assert.equal(classifyUnlinkError(err), 'generic');
});

test('classifyUnlinkError: everything else is generic', () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    const err = new Error('x') as Error & { status?: number; code?: string };
    err.status = status;
    assert.equal(classifyUnlinkError(err), 'generic', String(status));
  }
  assert.equal(classifyUnlinkError(new Error('network down')), 'generic'); // no status at all
  assert.equal(classifyUnlinkError(undefined), 'generic');
});
