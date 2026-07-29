import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canUnlinkSession, classifyUnlinkError, isSessionStarted } from './sessionActions.ts';

// Every status with a live engine must be "started": the card picks Stop vs Start from this, and
// offering Start to a started session gets a 400 and then a QR modal that can never resolve.
test('isSessionStarted: every status that holds a live engine counts as started', () => {
  for (const status of ['initializing', 'connecting', 'qr_ready', 'authenticating', 'ready', 'action_required']) {
    assert.equal(isSessionStarted(status), true, status);
  }
  for (const status of ['created', 'idle', 'disconnected', 'failed']) {
    assert.equal(isSessionStarted(status), false, status);
  }
});

test('canUnlinkSession: unlinkable is exactly started — Stop and Unlink share one precondition', () => {
  for (const status of ['initializing', 'connecting', 'qr_ready', 'authenticating', 'ready', 'action_required']) {
    assert.equal(canUnlinkSession(status, true), true, status);
    assert.equal(canUnlinkSession(status, true), isSessionStarted(status), `${status} must track Stop`);
  }
  for (const status of ['created', 'idle', 'disconnected', 'failed']) {
    assert.equal(canUnlinkSession(status, true), false, status);
  }
});

test('canUnlinkSession: a read-only role never sees the action, even for a started session', () => {
  assert.equal(canUnlinkSession('ready', false), false);
});

test('classifyUnlinkError: the gateway 502 means the unlink was unconfirmed, not a plain failure', () => {
  const err = new Error('Session was stopped locally, but WhatsApp did not confirm') as Error & {
    status?: number;
  };
  err.status = 502;
  assert.equal(classifyUnlinkError(err), 'unconfirmed');
});

// A reverse proxy answers 502 too, and then nothing was stopped — telling the operator to retry the
// unlink would be wrong. The API client's non-JSON fallback message is what distinguishes them.
test('classifyUnlinkError: a reverse-proxy 502 is generic, not unconfirmed', () => {
  const err = new Error('HTTP 502') as Error & { status?: number };
  err.status = 502;
  assert.equal(classifyUnlinkError(err), 'generic');
});

test('classifyUnlinkError: everything else is generic', () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    const err = new Error('x') as Error & { status?: number };
    err.status = status;
    assert.equal(classifyUnlinkError(err), 'generic', String(status));
  }
  assert.equal(classifyUnlinkError(new Error('network down')), 'generic'); // no status at all
  assert.equal(classifyUnlinkError(undefined), 'generic');
});
