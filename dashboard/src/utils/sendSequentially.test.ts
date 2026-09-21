import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendSequentially } from './sendSequentially.ts';

const noSleep = async () => {};
const refusal = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

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
  assert.deepEqual(result, { sent: 3, failures: [], notAttempted: [] });
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

test('really waits between targets when no sleep is injected', async () => {
  const sentAt: number[] = [];
  await sendSequentially(
    ['a', 'b'],
    async () => {
      sentAt.push(performance.now());
    },
    { delayMs: 20 },
  );
  assert.equal(sentAt.length, 2);
  assert.ok(sentAt[1] - sentAt[0] >= 15, `second send came ${sentAt[1] - sentAt[0]}ms after the first`);
});

test('a failing target is recorded with its status and the rest are still sent', async () => {
  const calls: string[] = [];
  const result = await sendSequentially(
    ['a', 'b', 'c'],
    async target => {
      calls.push(target);
      if (target === 'b') throw refusal(404);
    },
    { delayMs: 3000, sleep: noSleep },
  );
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(result, {
    sent: 2,
    failures: [{ target: 'b', error: 'HTTP 404', status: 404 }],
    notAttempted: [],
  });
});

test('a failure matching stopOn ends the run and reports the rest as not attempted', async () => {
  const calls: string[] = [];
  const result = await sendSequentially(
    ['a', 'b', 'c', 'd'],
    async target => {
      calls.push(target);
      if (target === 'b') throw refusal(429);
    },
    { delayMs: 3000, sleep: noSleep, stopOn: err => (err as { status?: number }).status === 429 },
  );
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(result, {
    sent: 1,
    failures: [{ target: 'b', error: 'HTTP 429', status: 429 }],
    notAttempted: ['c', 'd'],
    stoppedBy: 'refusal',
  });
});

test('aborting stops before the next target', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const result = await sendSequentially(
    ['a', 'b', 'c'],
    async target => {
      calls.push(target);
      controller.abort();
    },
    { delayMs: 3000, sleep: noSleep, signal: controller.signal },
  );
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(result, { sent: 1, failures: [], notAttempted: ['b', 'c'], stoppedBy: 'abort' });
});

test('aborting during the wait ends it without waiting out the delay', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const result = await sendSequentially(
    ['a', 'b'],
    async () => {
      setTimeout(() => controller.abort(), 10);
    },
    { delayMs: 60_000, signal: controller.signal },
  );
  assert.ok(performance.now() - started < 5_000, 'the abort did not cut the wait short');
  assert.deepEqual(result, { sent: 1, failures: [], notAttempted: ['b'], stoppedBy: 'abort' });
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
  assert.deepEqual(result, { sent: 0, failures: [], notAttempted: [] });
});
