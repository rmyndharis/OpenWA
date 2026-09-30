import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditUnavailable, collectAdvisories, evaluate, unavailableOutcome } from './check-audit.mjs';

/**
 * The report shape is taken from a real `npm audit --json` run, not invented: one advisory
 * (extract-zip) surfaces as FIVE package entries, and only the directly-vulnerable one carries the
 * advisory object in `via`. The other four name their parent as a plain string. A gate that counted
 * package entries instead of advisories would need four more allowlist ids for one problem.
 */
const advisory = {
  source: 1139346,
  name: 'extract-zip',
  url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
  severity: 'high',
  title: 'extract-zip unvalidated symlink path traversal',
};

const puppeteerReport = {
  vulnerabilities: {
    'extract-zip': { name: 'extract-zip', severity: 'high', via: [advisory] },
    '@puppeteer/browsers': { name: '@puppeteer/browsers', severity: 'high', via: ['extract-zip'] },
    puppeteer: { name: 'puppeteer', severity: 'high', via: ['@puppeteer/browsers'] },
    'puppeteer-core': { name: 'puppeteer-core', severity: 'high', via: ['@puppeteer/browsers'] },
    'whatsapp-web.js': { name: 'whatsapp-web.js', severity: 'high', via: ['puppeteer'] },
  },
};

const ALLOW = [{ id: 'GHSA-jmr9-qjv8-65gv', package: 'extract-zip', reason: 'x', removeWhen: 'y' }];

test('five package entries for one advisory collapse to a single advisory', () => {
  const found = collectAdvisories(puppeteerReport);
  assert.equal(found.size, 1);
  assert.equal(found.get('GHSA-jmr9-qjv8-65gv').package, 'extract-zip');
});

test('the allowlisted advisory passes', () => {
  assert.deepEqual(evaluate(puppeteerReport, ALLOW), []);
});

// The load-bearing negative. Without this the gate could allowlist everything and still look green.
test('the SAME advisory fails once it is not allowlisted', () => {
  const errors = evaluate(puppeteerReport, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /GHSA-jmr9-qjv8-65gv/);
  assert.match(errors[0], /HIGH/);
});

test('a DIFFERENT high advisory still fails while one is allowlisted', () => {
  const report = {
    vulnerabilities: {
      ...puppeteerReport.vulnerabilities,
      tar: {
        name: 'tar',
        severity: 'high',
        via: [{ name: 'tar', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 'x' }],
      },
    },
  };
  const errors = evaluate(report, ALLOW);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /GHSA-aaaa-bbbb-cccc/);
});

test('critical is blocking too, not just high', () => {
  const report = {
    vulnerabilities: {
      x: {
        name: 'x',
        severity: 'critical',
        via: [
          { name: 'x', url: 'https://github.com/advisories/GHSA-crit-0000-0000', severity: 'critical', title: 'x' },
        ],
      },
    },
  };
  assert.equal(evaluate(report, []).length, 1);
});

test('moderate and low do not block', () => {
  const report = {
    vulnerabilities: {
      x: {
        name: 'x',
        severity: 'moderate',
        via: [{ name: 'x', url: 'https://github.com/advisories/GHSA-mod-0000-0000', severity: 'moderate', title: 'x' }],
      },
    },
  };
  assert.deepEqual(evaluate(report, []), []);
});

/**
 * The rule that stops the carve-out outliving its cause. When whatsapp-web.js ships a puppeteer
 * carrying @puppeteer/browsers 3.x the advisory disappears, and without this the entry would sit
 * there indefinitely, quietly excusing an id nobody re-examines.
 */
test('an allowlist entry whose advisory is gone fails as stale', () => {
  const errors = evaluate({ vulnerabilities: {} }, ALLOW);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Stale allowlist entry GHSA-jmr9-qjv8-65gv/);
});

test('a clean report with an empty allowlist passes', () => {
  assert.deepEqual(evaluate({ vulnerabilities: {} }, []), []);
});

// npm omits the key entirely when nothing is found; treating that as a crash would fail every
// green build, and treating a crash as "clean" would fail open. It must simply be empty.
test('a report with no vulnerabilities key is clean, not a crash', () => {
  assert.deepEqual(evaluate({}, []), []);
  assert.equal(collectAdvisories(undefined).size, 0);
});

// The endpoint-failure discriminator. npm returns `{ error }` (no vulnerabilities, no metadata) when
// the audit endpoint is down or retired; that must read as "could not audit", not as a clean tree,
// or the stale-allowlist rule fires against every entry. A genuinely clean report has no `error` key.
test('an { error } payload reads as audit-unavailable, not clean', () => {
  assert.equal(auditUnavailable({ error: { summary: 'audit endpoint returned an error' } }), true);
  assert.equal(auditUnavailable(null), true);
  assert.equal(auditUnavailable('not an object'), true);
});

test('a clean or vulnerable report is not audit-unavailable', () => {
  assert.equal(auditUnavailable({}), false);
  assert.equal(auditUnavailable({ vulnerabilities: {} }), false);
  assert.equal(auditUnavailable(puppeteerReport), false);
});

// PR CI keeps the skip so an npm outage does not block every merge, but it must show on the run as a
// warning annotation rather than a plain log line inside a green job.
test('an unavailable audit skips with exit 0 outside a required path', () => {
  const plain = unavailableOutcome('down', {});
  assert.equal(plain.exitCode, 0);
  assert.equal(
    plain.lines.some(line => line.startsWith('::warning')),
    false,
  );
  const actions = unavailableOutcome('down', { GITHUB_ACTIONS: 'true' });
  assert.equal(actions.exitCode, 0);
  assert.match(actions.lines[0], /^::warning title=check:audit skipped::.*down/);
});

// The release and the weekly scan set CHECK_AUDIT_REQUIRED=1: publishing, or reporting a week clean,
// with no advisory checked at all is not a skip they may take.
test('an unavailable audit fails when the path requires it', () => {
  const required = unavailableOutcome('down', { CHECK_AUDIT_REQUIRED: '1', GITHUB_ACTIONS: 'true' });
  assert.equal(required.exitCode, 1);
  assert.match(required.lines.join('\n'), /required on this path/);
  assert.match(required.lines[0], /^::error title=check:audit could not run::/);
  assert.equal(unavailableOutcome('down', { CHECK_AUDIT_REQUIRED: '0' }).exitCode, 0);
});

test('the annotation stays on one line when npm reports a multi-line summary', () => {
  const [annotation] = unavailableOutcome('100% down\nretry later', { GITHUB_ACTIONS: 'true' }).lines;
  assert.equal(annotation.includes('\n'), false);
  assert.match(annotation, /100%25 down%0Aretry later/);
});

// End to end through the real entrypoint, with `npm` replaced by a shim that answers like a down
// audit endpoint, so the exit code the workflow sees is the one asserted.
test(
  'the script exits by CHECK_AUDIT_REQUIRED when npm audit cannot answer',
  { skip: process.platform === 'win32' },
  () => {
    const bin = mkdtempSync(join(tmpdir(), 'check-audit-'));
    try {
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho \'{"error":{"summary":"endpoint down"}}\'\nexit 1\n');
      chmodSync(join(bin, 'npm'), 0o755);
      const script = fileURLToPath(new URL('./check-audit.mjs', import.meta.url));
      const run = extra =>
        spawnSync(process.execPath, [script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_ACTIONS: '',
            CHECK_AUDIT_REQUIRED: '',
            ...extra,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
          },
        });
      const skipped = run({});
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.match(skipped.stdout, /check:audit SKIPPED/);
      const required = run({ CHECK_AUDIT_REQUIRED: '1' });
      assert.equal(required.status, 1);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);
