/**
 * Post-install hook (npm `postinstall`).
 *
 * Five conditional steps, each skipped when its target is absent so the hook is a no-op where the
 * piece is missing (the Docker builder stage copies package*.json long before any source):
 *
 *   1. `npm ci` inside dashboard/ when dashboard/ exists — the dashboard carries its own lockfile and
 *      the root install would otherwise leave it without dependencies. We run `npm ci` directly in
 *      dashboard/ with any `npm_config_allow_scripts` environment variable stripped so that npm 11
 *      does not reject `allow-scripts=true` from user `.npmrc` with EALLOWSCRIPTS. A failure here
 *      MUST abort the install: the old inline hook swallowed spawnSync's exit status, so a red
 *      dashboard install still reported `npm install` success and the breakage surfaced only at
 *      build/run time.
 *   2. `node scripts/patch-wwebjs-201832.js --best-effort` when the patcher exists. The patcher
 *      itself decides fatality: under --best-effort it warns and exits 0 for a pristine-but-
 *      unpatched tree (no `patch` binary, Baileys-only user), but exits 1 for a HALF-patched
 *      tree — which must never be waved through. So a non-zero status here is propagated as-is.
 *   3. `node scripts/patch-wwebjs-newsletter-preview.js --best-effort` when present. The production
 *      Docker stage runs it again without best-effort, making dependency drift a build failure.
 *   4. `node scripts/patch-wwebjs-status.js --best-effort` when present — the status posting
 *      repairs, gated the same way as step 3.
 *   5. `node scripts/patch-wwebjs-ready-sync.js --best-effort` when present — the readiness
 *      marker + hasSynced level-check, gated the same way.
 *
 * Structured like scripts/patch-wwebjs-201832.js: pure planning + injectable spawn, so the spec
 * (scripts/postinstall.spec.js, node:test) exercises every branch without a real npm run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Sanitize an environment object for child invocations.
 *
 * npm 11 rejects `--allow-scripts` in project-scoped installs (`npm ci`, `npm install`) when it
 * originates from the environment (`npm_config_allow_scripts`) rather than `.npmrc` or
 * `package.json`. When a root install is invoked with `allow-scripts=true` in `.npmrc`, npm
 * exports that setting to the lifecycle environment as `npm_config_allow_scripts`. Stripping it
 * prevents nested npm executions (`npm run dashboard:ci` -> `cd dashboard && npm ci`) from
 * failing with EALLOWSCRIPTS while preserving the user's `.npmrc` configuration.
 */
function sanitizeEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^npm_config_allow[_-]scripts$/i.test(key)) {
      delete clean[key];
    }
  }
  return clean;
}

/** The steps to run for a given repo root, in order. */
function planSteps(root, env = process.env) {
  const cleanEnv = sanitizeEnv(env);
  const steps = [];
  if (fs.existsSync(path.join(root, 'dashboard'))) {
    steps.push({
      name: 'dashboard dependencies (npm ci)',
      command: 'npm ci',
      options: { stdio: 'inherit', shell: true, cwd: path.join(root, 'dashboard'), env: cleanEnv },
    });
  }
  const patcher = path.join(root, 'scripts', 'patch-wwebjs-201832.js');
  if (fs.existsSync(patcher)) {
    steps.push({
      name: 'whatsapp-web.js backport (scripts/patch-wwebjs-201832.js --best-effort)',
      command: process.execPath,
      args: [patcher, '--best-effort'],
      options: { stdio: 'inherit', cwd: root, env: cleanEnv },
    });
  }
  const previewPatcher = path.join(root, 'scripts', 'patch-wwebjs-newsletter-preview.js');
  if (fs.existsSync(previewPatcher)) {
    steps.push({
      name: 'whatsapp-web.js newsletter preview backport (scripts/patch-wwebjs-newsletter-preview.js --best-effort)',
      command: process.execPath,
      args: [previewPatcher, '--best-effort'],
      options: { stdio: 'inherit', cwd: root, env: cleanEnv },
    });
  }
  const statusPatcher = path.join(root, 'scripts', 'patch-wwebjs-status.js');
  if (fs.existsSync(statusPatcher)) {
    steps.push({
      name: 'whatsapp-web.js status send repair (scripts/patch-wwebjs-status.js --best-effort)',
      command: process.execPath,
      args: [statusPatcher, '--best-effort'],
      options: { stdio: 'inherit', cwd: root, env: cleanEnv },
    });
  }
  const readySyncPatcher = path.join(root, 'scripts', 'patch-wwebjs-ready-sync.js');
  if (fs.existsSync(readySyncPatcher)) {
    steps.push({
      name: 'whatsapp-web.js ready-sync repair (scripts/patch-wwebjs-ready-sync.js --best-effort)',
      command: process.execPath,
      args: [readySyncPatcher, '--best-effort'],
      options: { stdio: 'inherit', cwd: root, env: cleanEnv },
    });
  }
  return steps;
}

/** Human-readable failure cause from a spawnSync result. */
function failureReason(res) {
  if (res.error) return `failed to start — ${res.error.message}`;
  if (typeof res.status === 'number' && res.status !== 0) return `exit code ${res.status}`;
  if (res.signal) return `killed by ${res.signal}`;
  return null;
}

/**
 * Run the planned steps, stopping at the first failure. Returns the process exit code (0 = all
 * steps ran clean or were absent). `spawn` is injectable for tests.
 */
function run(root = ROOT, spawn = spawnSync, env = process.env) {
  const steps = planSteps(root, env);
  if (!steps.length) {
    console.log('postinstall: no dashboard/ or patch script present — nothing to do.');
    return 0;
  }
  for (const step of steps) {
    const res = spawn(step.command, step.args, step.options);
    const reason = failureReason(res ?? {});
    if (reason) {
      console.error(
        `postinstall: ${step.name} failed (${reason}). The install is INCOMPLETE — ` +
          'fix the error above and re-run `npm install`.',
      );
      return 1;
    }
  }
  return 0;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { sanitizeEnv, planSteps, failureReason, run, ROOT };
