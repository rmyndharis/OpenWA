import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadArchivedMedia } from './archivedMediaLoad.ts';

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
});

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code });

test('a burst of loads starts at least 100 ms apart, under the gateway per-second throttle', async () => {
  const starts: number[] = [];
  const { signal } = new AbortController();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      loadArchivedMedia(signal, async () => {
        starts.push(Date.now());
        return 'x';
      }),
    ),
  );
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i] - starts[i - 1] >= 100,
      `loads ${i - 1} and ${i} started ${starts[i] - starts[i - 1]} ms apart`,
    );
  }
});

test('a load aborted while it waits for its turn never starts', async () => {
  // Three loads ahead of it keep the next turn a few hundred milliseconds away.
  const ahead = Array.from({ length: 3 }, () => loadArchivedMedia(new AbortController().signal, async () => 'x'));
  const controller = new AbortController();
  let ran = false;
  const waiting = loadArchivedMedia(controller.signal, async () => {
    ran = true;
    return 'x';
  });
  controller.abort();
  await assert.rejects(waiting);
  await Promise.all(ahead);
  assert.equal(ran, false);
});

test('loads that gave up their turn leave no gap for the loads behind them', async () => {
  // Four previews from the chat the operator just left: the first starts at once, the rest are still
  // waiting when it unmounts. The next chat's first preview must not sit out their turns.
  const left = Array.from({ length: 6 }, () => new AbortController());
  const started: number[] = [];
  const first = loadArchivedMedia(left[0].signal, async () => {
    started.push(Date.now());
    return 'x';
  });
  const abandoned = left
    .slice(1)
    .map(controller => assert.rejects(loadArchivedMedia(controller.signal, async () => 'x')));
  for (const controller of left.slice(1)) controller.abort();
  await first;
  await Promise.all(abandoned);
  const t0 = Date.now();
  await loadArchivedMedia(new AbortController().signal, async () => {
    started.push(Date.now());
    return 'y';
  });
  assert.ok(started[1] - started[0] < 300, `the next chat waited ${started[1] - started[0]} ms behind abandoned turns`);
  assert.ok(Date.now() - t0 < 300);
});

// 429: the per-IP throttle. 503: on S3 the gateway refuses a download at once while 50 are open.
for (const code of [429, 503]) {
  test(`a load refused once with ${code} is retried and then resolves`, async () => {
    let calls = 0;
    const outcome = await loadArchivedMedia(
      new AbortController().signal,
      async () => {
        calls += 1;
        if (calls === 1) throw status(code);
        return 'bytes';
      },
      5,
    ).catch((e: { status?: number }) => `refused ${e.status}`);
    assert.equal(`${outcome} after ${calls} call(s)`, 'bytes after 2 call(s)');
  });
}

for (const code of [404, 500]) {
  test(`a load failing with ${code} is not retried`, async () => {
    let calls = 0;
    await assert.rejects(
      loadArchivedMedia(
        new AbortController().signal,
        async () => {
          calls += 1;
          throw status(code);
        },
        5,
      ),
    );
    assert.equal(calls, 1);
  });
}

test('a load whose signal is already aborted rejects without starting', async () => {
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  await assert.rejects(
    loadArchivedMedia(controller.signal, async () => {
      ran = true;
      return 'x';
    }),
  );
  assert.equal(ran, false);
});

test('a load that leaves the queue takes only its own turn with it', async () => {
  const ran: number[] = [];
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const loads = controllers.map((controller, i) =>
    loadArchivedMedia(controller.signal, async () => {
      ran.push(i);
      return i;
    }).catch(() => -1),
  );
  controllers[2].abort();
  // A turn dropped with it would leave the fourth load pending for good.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.all(loads),
    new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), 3000);
    }),
  ]);
  clearTimeout(timer);
  assert.notEqual(outcome, 'timeout');
  assert.deepEqual(ran, [0, 1, 3]);
});
