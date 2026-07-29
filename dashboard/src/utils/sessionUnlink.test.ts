import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canUnlinkSession, classifyUnlinkError } from './sessionUnlink.ts';

test('canUnlinkSession: only started states are unlinkable (they have a live engine)', () => {
  for (const status of ['ready', 'initializing', 'connecting', 'qr_ready']) {
    assert.equal(canUnlinkSession(status, true), true, status);
  }
  for (const status of ['created', 'idle', 'disconnected', 'failed', 'action_required']) {
    assert.equal(canUnlinkSession(status, true), false, status);
  }
});

test('canUnlinkSession: a read-only role never sees the action, even for a started session', () => {
  assert.equal(canUnlinkSession('ready', false), false);
});

test('classifyUnlinkError: 502 means the unlink was unconfirmed, not a plain failure', () => {
  const err = new Error('Session was stopped locally, but WhatsApp did not confirm') as Error & {
    status?: number;
  };
  err.status = 502;
  assert.equal(classifyUnlinkError(err), 'unconfirmed');
});

test('classifyUnlinkError: everything else is generic', () => {
  for (const status of [400, 401, 403, 404, 500]) {
    const err = new Error('x') as Error & { status?: number };
    err.status = status;
    assert.equal(classifyUnlinkError(err), 'generic', String(status));
  }
  assert.equal(classifyUnlinkError(new Error('network down')), 'generic'); // no status at all
  assert.equal(classifyUnlinkError(undefined), 'generic');
});
