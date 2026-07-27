/**
 * Unit tests for scripts/postinstall.js (node:test — no jest, no deps).
 * Run: `npm run test:scripts`.
 *
 * The spawn is injected, so every branch (success, non-zero exit, spawn error, signal, fail-fast
 * ordering) is exercised without a real `npm run dashboard:ci`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planSteps, failureReason, run } = require('./postinstall.js');

const OK = { status: 0, signal: null, error: null };

/** Bare temp dir optionally holding a dashboard/ and/or the patch script. */
function makeRoot({ dashboard = false, patcher = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-postinstall-'));
  if (dashboard) fs.mkdirSync(path.join(root, 'dashboard'));
  if (patcher) {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'patch-wwebjs-201832.js'), '// stub\n');
  }
  return root;
}

/** spawnSync stand-in: records calls, replays the queued results in order. */
function fakeSpawn(results) {
  const calls = [];
  let i = 0;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return results[Math.min(i++, results.length - 1)];
  };
  return { calls, spawn };
}

test('planSteps: empty root plans nothing', () => {
  assert.deepEqual(planSteps(makeRoot()), []);
});

test('planSteps: dashboard only plans the dashboard install (shell, inherited stdio)', () => {
  const steps = planSteps(makeRoot({ dashboard: true }));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, 'npm run dashboard:ci');
  assert.equal(steps[0].options.shell, true);
  assert.equal(steps[0].options.stdio, 'inherit');
});

test('planSteps: patcher only plans the best-effort backport via the current node', () => {
  const steps = planSteps(makeRoot({ patcher: true }));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, process.execPath);
  assert.match(steps[0].args[0], /patch-wwebjs-201832\.js$/);
  assert.deepEqual(steps[0].args.slice(1), ['--best-effort']);
});

test('planSteps: both present plans dashboard first, patcher second', () => {
  const steps = planSteps(makeRoot({ dashboard: true, patcher: true }));
  assert.equal(steps.length, 2);
  assert.equal(steps[0].command, 'npm run dashboard:ci');
  assert.equal(steps[1].command, process.execPath);
});

test('run: nothing to do exits 0 and never spawns', () => {
  const { calls, spawn } = fakeSpawn([OK]);
  assert.equal(run(makeRoot(), spawn), 0);
  assert.equal(calls.length, 0);
});

test('run: all steps succeed exits 0', () => {
  const { calls, spawn } = fakeSpawn([OK, OK]);
  assert.equal(run(makeRoot({ dashboard: true, patcher: true }), spawn), 0);
  assert.equal(calls.length, 2);
});

test('run: non-zero dashboard install exits 1 and never reaches the patcher (fail-fast)', () => {
  const { calls, spawn } = fakeSpawn([{ status: 1, signal: null, error: null }]);
  assert.equal(run(makeRoot({ dashboard: true, patcher: true }), spawn), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npm run dashboard:ci');
});

test('run: spawn error (npm not found) exits 1', () => {
  const { spawn } = fakeSpawn([{ status: null, signal: null, error: new Error('spawn npm ENOENT') }]);
  assert.equal(run(makeRoot({ dashboard: true }), spawn), 1);
});

test('run: step killed by a signal exits 1', () => {
  const { spawn } = fakeSpawn([{ status: null, signal: 'SIGTERM', error: null }]);
  assert.equal(run(makeRoot({ dashboard: true }), spawn), 1);
});

test('run: non-zero patcher exit propagates (half-patched tree must stay fatal)', () => {
  const { calls, spawn } = fakeSpawn([{ status: 1, signal: null, error: null }]);
  assert.equal(run(makeRoot({ patcher: true }), spawn), 1);
  assert.equal(calls.length, 1);
});

test('failureReason: maps each spawnSync outcome to a cause (null = success)', () => {
  assert.equal(failureReason(OK), null);
  assert.equal(failureReason({ status: 2, signal: null, error: null }), 'exit code 2');
  assert.equal(failureReason({ status: null, signal: 'SIGKILL', error: null }), 'killed by SIGKILL');
  assert.match(failureReason({ status: null, signal: null, error: new Error('boom') }), /failed to start — boom/);
});
