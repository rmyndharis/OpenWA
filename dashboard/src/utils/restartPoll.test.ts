import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restartPollAttempts } from './restartPoll.ts';

// The poll runs once a second, so an attempt count IS a deadline in seconds. It used to be a fixed
// 60, which never mattered: the poll hit the still-draining old process and "succeeded" within three
// seconds. Once it waits for real readiness, that 60 becomes the thing that decides whether the
// operator sees the dashboard or an error — and POST /infra/restart estimates up to 63s for a restart
// that brings up postgres + redis + minio. The ceiling must not sit below the server's own estimate.

test('no estimate: keeps the historical 60-attempt deadline', () => {
  assert.equal(restartPollAttempts(undefined), 60);
});

test('an estimate the floor already covers does not shorten the deadline', () => {
  assert.equal(restartPollAttempts(15), 60);
});

test('a full-profile restart gets more room than the server estimated', () => {
  // 15 base + 20 postgres + 13 redis + 15 minio — the worst case infra-config.controller computes.
  assert.equal(restartPollAttempts(63), 126);
});

test('a fractional estimate rounds up rather than truncating below it', () => {
  assert.equal(restartPollAttempts(40.5), 81);
});

test('a bogus estimate cannot hang the modal or shorten the deadline', () => {
  for (const bogus of [0, -1, NaN, Infinity]) {
    assert.equal(restartPollAttempts(bogus), 60, `estimate ${bogus}`);
  }
  assert.equal(restartPollAttempts(99999), 300);
});

// The two assertions below guard the WIRING, which is where the bug actually lived. A correct helper
// that nothing calls, or a correct deadline pointed at an endpoint that lies during shutdown, both
// pass every assertion above while reproducing #1019 in full. The failure is invisible until an
// operator restarts a production stack, so it has to be caught here.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the restart poll targets readiness, not a ping that survives the drain', () => {
  const api = read('../services/api.ts');
  const healthCheck = api.split('\n').find(line => line.trimStart().startsWith('healthCheck: () =>'));
  assert.ok(healthCheck, 'infraApi.healthCheck not found — update this guard, do not delete it');
  assert.match(
    healthCheck,
    /'\/health\/ready'/,
    'the poll must hit /health/ready: /infra/health answers 200 throughout the drain, so the poll ' +
      'latches onto the dying process and reloads the page into a gap (#1019)',
  );
});

test('the poll deadline comes from the helper rather than a bare constant', () => {
  assert.match(read('../hooks/useRestartFlow.ts'), /const maxAttempts = restartPollAttempts\(/);
});
