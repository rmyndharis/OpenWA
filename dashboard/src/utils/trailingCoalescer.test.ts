import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrailingCoalescer } from './trailingCoalescer.ts';

test('a burst of events for one key collapses into a single trailing request', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const coalescer = createTrailingCoalescer<string>(key => sent.push(key), 750);

  coalescer.call('chat-A');
  coalescer.call('chat-A');
  coalescer.call('chat-A');
  coalescer.call('chat-A');

  t.mock.timers.tick(749);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, ['chat-A']);
  coalescer.cancel();
});

test('the trailing call fires after the quiet window, not at burst time', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const coalescer = createTrailingCoalescer<string>(key => sent.push(key), 750);

  coalescer.call('chat-A');
  t.mock.timers.tick(400);
  coalescer.call('chat-A'); // restarts the quiet window
  t.mock.timers.tick(400);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(350);
  assert.deepEqual(sent, ['chat-A']);
  coalescer.cancel();
});

test('different keys coalesce independently', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const coalescer = createTrailingCoalescer<string>(key => sent.push(key), 750);

  coalescer.call('chat-A');
  coalescer.call('chat-B');
  coalescer.call('chat-A');

  t.mock.timers.tick(750);
  assert.deepEqual(sent.sort(), ['chat-A', 'chat-B']);
  coalescer.cancel();
});

test('cancel() drops pending calls so nothing fires late', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const coalescer = createTrailingCoalescer<string>(key => sent.push(key), 750);

  coalescer.call('chat-A');
  coalescer.call('chat-B');
  coalescer.cancel();

  t.mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

test('flush() fires every pending key immediately (unmount/navigation does not lose the call)', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const coalescer = createTrailingCoalescer<string>(key => sent.push(key), 750);

  coalescer.call('chat-A');
  coalescer.call('chat-B');
  coalescer.flush();

  assert.deepEqual(sent.sort(), ['chat-A', 'chat-B']);
  // Nothing is left pending: a later tick must not re-fire, and cancel() is a no-op.
  coalescer.cancel();
  t.mock.timers.tick(10_000);
  assert.deepEqual(sent.sort(), ['chat-A', 'chat-B']);
});

test('flush() with nothing pending is a no-op', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const coalescer = createTrailingCoalescer<string>(key => sent.push(key), 750);

  coalescer.flush();
  t.mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});
