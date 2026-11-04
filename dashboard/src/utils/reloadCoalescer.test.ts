import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReloadCoalescer } from './reloadCoalescer.ts';

// A reload the test settles by hand, in the order it was started.
function manualReloads() {
  const out: Array<{ resolve: (applied: boolean) => void; reject: (err: unknown) => void }> = [];
  const reload = () =>
    new Promise<boolean>((resolve, reject) => {
      out.push({ resolve, reject });
    });
  return { reload, out };
}

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test('a call with no reload out starts one at once and gets its result', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  const result = coalescer.run();
  assert.equal(out.length, 1);
  out[0].resolve(true);
  assert.equal(await result, true);
});

test('calls made while a reload is out share one trailing reload that starts after it settles', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  const first = coalescer.run();
  const absorbed = [coalescer.run(), coalescer.run(), coalescer.run(), coalescer.run()];
  assert.equal(out.length, 1, 'a call made while a reload was out started its own');

  out[0].resolve(false);
  assert.equal(await first, false);
  await settled();
  assert.equal(out.length, 2, 'the trailing reload did not start');

  // Every absorbed caller is answered by the trailing reload, not by the one that was out before it.
  out[1].resolve(true);
  assert.deepEqual(await Promise.all(absorbed), [true, true, true, true]);
  await settled();
  assert.equal(out.length, 2);
});

test('a call made while the trailing reload runs queues exactly one more', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  void coalescer.run();
  void coalescer.run();
  out[0].resolve(true);
  await settled();
  assert.equal(out.length, 2);

  const queued = [coalescer.run(), coalescer.run()];
  assert.equal(out.length, 2);
  out[1].resolve(true);
  await settled();
  assert.equal(out.length, 3);
  out[2].resolve(false);
  assert.deepEqual(await Promise.all(queued), [false, false]);
});

test('once everything has settled the next call starts a reload at once', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  void coalescer.run();
  out[0].resolve(true);
  await settled();
  void coalescer.run();
  assert.equal(out.length, 2);
});

test('cancel settles the callers waiting on the trailing reload with false and starts no second reload', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  const first = coalescer.run();
  const absorbed = [coalescer.run(), coalescer.run()];
  coalescer.cancel();
  assert.deepEqual(await Promise.all(absorbed), [false, false]);

  out[0].resolve(true);
  assert.equal(await first, true);
  await settled();
  assert.equal(out.length, 1, 'a cancelled trailing reload started');
});

test('the coalescer keeps working after a cancel', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  void coalescer.run();
  coalescer.cancel();
  out[0].resolve(true);
  await settled();

  const result = coalescer.run();
  assert.equal(out.length, 2, 'a call after a cancel did not run');
  out[1].resolve(true);
  assert.equal(await result, true);
});

test('a call made after a cancel, while the old reload is still out, trails it', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  void coalescer.run();
  coalescer.cancel();
  const later = coalescer.run();
  assert.equal(out.length, 1);
  out[0].resolve(false);
  await settled();
  assert.equal(out.length, 2);
  out[1].resolve(true);
  assert.equal(await later, true);
});

test('a reload that rejects releases the trailing reload and still answers its own caller', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  const first = coalescer.run();
  const absorbed = coalescer.run();
  out[0].reject(new Error('boom'));
  await assert.rejects(first, /boom/);
  await settled();
  assert.equal(out.length, 2, 'a failed reload starved the trailing one');
  out[1].resolve(true);
  assert.equal(await absorbed, true);

  await settled();
  void coalescer.run();
  assert.equal(out.length, 3, 'the slot stayed taken after a failure');
});

test('a trailing reload that rejects rejects its callers and frees the slot', async () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  void coalescer.run();
  const absorbed = coalescer.run();
  out[0].resolve(true);
  await settled();
  out[1].reject(new Error('boom'));
  await assert.rejects(absorbed, /boom/);
  await settled();
  void coalescer.run();
  assert.equal(out.length, 3);
});

test('a reload that throws before returning a promise counts as a failure', async () => {
  let calls = 0;
  const coalescer = createReloadCoalescer(() => {
    calls += 1;
    throw new Error('sync boom');
  });
  await assert.rejects(coalescer.run(), /sync boom/);
  await settled();
  await assert.rejects(coalescer.run(), /sync boom/);
  assert.equal(calls, 2);
});

// A reload that records the signal it was handed, settled by hand like manualReloads.
function signalledReloads() {
  const out: Array<{ signal: AbortSignal; resolve: (applied: boolean) => void }> = [];
  const reload = (signal: AbortSignal) =>
    new Promise<boolean>(resolve => {
      out.push({ signal, resolve });
    });
  return { reload, out };
}

test('a reload that outlasts its deadline is abandoned: its signal aborts and the next call starts a new one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reload, out } = signalledReloads();
  const coalescer = createReloadCoalescer(reload, { deadlineMs: 1_000 });
  const stuck = coalescer.run();
  t.mock.timers.tick(999);
  assert.equal(out[0].signal.aborted, false);

  t.mock.timers.tick(1);
  assert.equal(await stuck, false);
  assert.equal(out[0].signal.aborted, true);
  await settled();

  const next = coalescer.run();
  assert.equal(out.length, 2, 'a call after the deadline waited behind the abandoned reload');
  out[1].resolve(true);
  assert.equal(await next, true);
});

test('the trailing reload behind a stuck one starts when the stuck one is abandoned', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reload, out } = signalledReloads();
  const coalescer = createReloadCoalescer(reload, { deadlineMs: 1_000 });
  const stuck = coalescer.run();
  const waiting = [coalescer.run(), coalescer.run()];
  assert.equal(out.length, 1);

  t.mock.timers.tick(1_000);
  assert.equal(await stuck, false);
  await settled();
  assert.equal(out.length, 2, 'the trailing reload stayed behind the abandoned one');
  out[1].resolve(true);
  assert.deepEqual(await Promise.all(waiting), [true, true]);

  // What the abandoned reload answers later changes nothing.
  out[0].resolve(true);
  await settled();
  assert.equal(out.length, 2);
});

test('a reload that answers in time is not aborted and leaves no deadline behind', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reload, out } = signalledReloads();
  const coalescer = createReloadCoalescer(reload, { deadlineMs: 1_000 });
  const result = coalescer.run();
  t.mock.timers.tick(500);
  out[0].resolve(true);
  assert.equal(await result, true);

  t.mock.timers.tick(10_000);
  assert.equal(out[0].signal.aborted, false);
  await settled();
  void coalescer.run();
  assert.equal(out.length, 2);
});

test('cancel on a coalescer with nothing out leaves it usable, as React replays effect cleanups before any reload', () => {
  const { reload, out } = manualReloads();
  const coalescer = createReloadCoalescer(reload);
  coalescer.cancel();
  void coalescer.run();
  // Checked before anything is awaited: a coalescer left marked as running would hold this call forever.
  assert.equal(out.length, 1, 'a call after an idle cancel waited behind a reload that was never started');
});
