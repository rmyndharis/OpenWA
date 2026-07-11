import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReconnectState } from './reconnectState.ts';

test('initial connect (never connected before): no invalidate', () => {
  assert.deepEqual(
    nextReconnectState({ isConnected: true, hadConnected: false, wasDisconnected: false }),
    { invalidate: false, hadConnected: true, wasDisconnected: false },
  );
});

test('disconnect before any connect (noise): no gap marked, no invalidate', () => {
  assert.deepEqual(
    nextReconnectState({ isConnected: false, hadConnected: false, wasDisconnected: false }),
    { invalidate: false, hadConnected: false, wasDisconnected: false },
  );
});

test('disconnect after the first connect: mark a gap, no invalidate', () => {
  assert.deepEqual(
    nextReconnectState({ isConnected: false, hadConnected: true, wasDisconnected: false }),
    { invalidate: false, hadConnected: true, wasDisconnected: true },
  );
});

test('reconnect after a gap (wasDisconnected): invalidate', () => {
  assert.deepEqual(
    nextReconnectState({ isConnected: true, hadConnected: true, wasDisconnected: true }),
    { invalidate: true, hadConnected: true, wasDisconnected: false },
  );
});

test('stays connected: no invalidate, stays hadConnected', () => {
  assert.deepEqual(
    nextReconnectState({ isConnected: true, hadConnected: true, wasDisconnected: false }),
    { invalidate: false, hadConnected: true, wasDisconnected: false },
  );
});
