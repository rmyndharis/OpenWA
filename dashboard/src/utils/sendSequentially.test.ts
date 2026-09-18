import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendSequentially } from './sendSequentially.ts';

const noSleep = async () => {};

test('sends to every target in order and counts the successes', async () => {
  const calls: string[] = [];
  const result = await sendSequentially(
    ['a', 'b', 'c'],
    async target => {
      calls.push(target);
    },
    { delayMs: 3000, sleep: noSleep },
  );
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(result, { sent: 3, failures: [] });
});

test('waits the delay between targets but not before the first or after the last', async () => {
  const events: string[] = [];
  await sendSequentially(
    ['a', 'b', 'c'],
    async target => {
      events.push(`send:${target}`);
    },
    {
      delayMs: 3000,
      sleep: async ms => {
        events.push(`sleep:${ms}`);
      },
    },
  );
  assert.deepEqual(events, ['send:a', 'sleep:3000', 'send:b', 'sleep:3000', 'send:c']);
});

test('a failing target is recorded and the remaining targets are still sent', async () => {
  const calls: string[] = [];
  const result = await sendSequentially(
    ['a', 'b', 'c'],
    async target => {
      calls.push(target);
      if (target === 'b') throw new Error('Group not found');
    },
    { delayMs: 3000, sleep: noSleep },
  );
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(result, { sent: 2, failures: [{ target: 'b', error: 'Group not found' }] });
});

test('a non-Error rejection is stringified', async () => {
  const result = await sendSequentially(
    ['a'],
    async () => {
      throw 'offline';
    },
    { delayMs: 0, sleep: noSleep },
  );
  assert.deepEqual(result.failures, [{ target: 'a', error: 'offline' }]);
});

test('reports progress before each send', async () => {
  const progress: string[] = [];
  await sendSequentially(['a', 'b'], async () => {}, {
    delayMs: 0,
    sleep: noSleep,
    onProgress: (current, total) => progress.push(`${current}/${total}`),
  });
  assert.deepEqual(progress, ['1/2', '2/2']);
});

test('an empty target list sends nothing', async () => {
  let called = false;
  const result = await sendSequentially(
    [],
    async () => {
      called = true;
    },
    { delayMs: 3000, sleep: noSleep },
  );
  assert.equal(called, false);
  assert.deepEqual(result, { sent: 0, failures: [] });
});
