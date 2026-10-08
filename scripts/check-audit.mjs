#!/usr/bin/env node
/**
 * Dependency-audit gate for the ROOT tree, with a per-advisory allowlist.
 *
 * `npm audit --audit-level=high` is all-or-nothing: it fails on any high, and the only lever it
 * offers is lowering the threshold for EVERYTHING. That lever is the wrong one — the audit job
 * exists to fence high-severity regressions, and dropping it to `critical` would silently un-gate
 * every future high to accommodate one advisory that has no fix.
 *
 * So the threshold stays, and an advisory is excused ONE AT A TIME, by id, with its reason recorded
 * next to it. An excused advisory is still visible in `npm audit` output; what changes is only
 * whether CI treats it as a stop.
 *
 * Two rules, and the second is the one that keeps this honest:
 *   1. Any advisory at `high` or `critical` whose id is not allowlisted FAILS.
 *   2. An allowlist entry whose advisory no longer appears ALSO FAILS. A carve-out that outlives
 *      its cause is how a gate quietly narrows, so removing it is not left to anyone remembering.
 *
 * Scope: the root tree only. `dashboard/` and `sdk/javascript/` keep a plain
 * `npm audit --audit-level=high`, because they have nothing to excuse and should stay stricter
 * than the root.
 *
 * Run locally: `npm run check:audit`.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Advisories CI will not stop on. Every entry states why, and what removes it.
 *
 * Keep this list empty whenever possible. An entry belongs here only when there is no patched
 * version to move to, the reachable path is understood, and the fix is upstream rather than ours.
 */
const ALLOWLIST = [];

const BLOCKING = new Set(['high', 'critical']);

/**
 * True when an `npm audit --json` payload is a registry failure rather than a real audit result.
 * npm returns `{ error: { summary } }` (no `vulnerabilities`, no `metadata`) when the audit endpoint
 * is unreachable or, as npm retires the legacy audit endpoint, returns an error. That is NOT a clean
 * tree: reading it as one would find zero advisories and flag every allowlist entry as stale. A
 * genuinely clean report carries no `error` key (it has `vulnerabilities: {}` and `metadata`), so
 * keying on `error` leaves a normal clean run clean. Anything unparseable is wrapped as an error too.
 */
export function auditUnavailable(report) {
  return report == null || typeof report !== 'object' || 'error' in report;
}

/**
 * `npm audit --json` exits non-zero exactly when it found something, so a throw is the normal path
 * and the payload is on stdout either way. Unparseable output, or an `{ error }` payload, means the
 * audit could not be performed and is wrapped as an error rather than read as "no vulnerabilities".
 */
function runAuditOnce() {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    raw = err?.stdout ?? '';
    if (!raw) return { error: { summary: err?.stderr?.trim() || err?.message || 'npm audit produced no output' } };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { error: { summary: 'npm audit output was not JSON (network or registry error)' } };
  }
}

/**
 * Runs the audit, retrying once when the endpoint does not answer. A transient blip clears on the
 * retry; a retired or persistently-down endpoint returns the last error report, which the caller
 * turns into a loud skip (or, on a required path, a failure) rather than a false "stale allowlist"
 * failure.
 */
function runAudit() {
  const ATTEMPTS = 2;
  let report;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    report = runAuditOnce();
    if (!auditUnavailable(report)) return report;
    if (attempt < ATTEMPTS) {
      console.error(`check:audit: npm audit endpoint did not answer, retrying (${attempt}/${ATTEMPTS})`);
    }
  }
  return report;
}

/**
 * Every distinct advisory in the report, keyed by its GHSA id.
 *
 * npm reports one entry per affected package, but only the directly-vulnerable one carries the
 * advisory OBJECT in `via`; the packages that merely depend on it carry a plain string naming their
 * parent. Collecting the objects is therefore what enumerates advisories rather than symptoms — the
 * extract-zip advisory shows up as five package entries and exactly one advisory.
 */
export function collectAdvisories(report) {
  const found = new Map();
  for (const entry of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if (!found.has(id)) {
        found.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return found;
}

/**
 * What to do when npm audit could not answer at all. On PR and push CI only this root-tree check
 * skips, and the skip is raised as a warning annotation on GitHub Actions rather than a log line
 * inside a green step. It does not keep the audit job green: the dashboard's plain `npm audit` step
 * in ci.yml fails closed on the same outage. A path that sets CHECK_AUDIT_REQUIRED=1 (the release
 * gate and the weekly scan) fails instead: publishing, or reporting a week clean, with no advisory
 * checked is not a skip those paths may take. A re-run clears a transient outage.
 */
export function unavailableOutcome(summary, env = process.env) {
  const required = env.CHECK_AUDIT_REQUIRED === '1';
  const text = `npm audit endpoint is unavailable after a retry (${summary}); advisories were not checked this run.`;
  const lines = [];
  if (env.GITHUB_ACTIONS === 'true') {
    // A workflow command ends at the first newline, and npm's summary can span several lines.
    const message = text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    lines.push(
      required
        ? `::error title=check:audit could not run::${message}`
        : `::warning title=check:audit skipped::${message}`,
    );
  }
  lines.push(
    required
      ? `check:audit FAILED: ${text} The audit is required on this path (CHECK_AUDIT_REQUIRED=1).`
      : `check:audit SKIPPED: ${text}`,
  );
  return { exitCode: required ? 1 : 0, lines };
}

/** The gate's verdict, split out so a spec can drive it without shelling out to npm. */
export function evaluate(report, allowlist = ALLOWLIST) {
  const advisories = collectAdvisories(report);
  const allowed = new Set(allowlist.map(a => a.id));
  const errors = [];

  for (const advisory of advisories.values()) {
    if (!BLOCKING.has(advisory.severity)) continue;
    if (allowed.has(advisory.id)) continue;
    errors.push(
      `${advisory.severity.toUpperCase()} ${advisory.id} in ${advisory.package}: ${advisory.title}\n` +
        `  ${advisory.url}\n` +
        '  Fix it, or — only if there is no patched version and the path is understood — add it to\n' +
        '  ALLOWLIST in scripts/check-audit.mjs with a reason and a removeWhen.',
    );
  }

  for (const entry of allowlist) {
    if (advisories.has(entry.id)) continue;
    errors.push(
      `Stale allowlist entry ${entry.id} (${entry.package}): the advisory no longer appears in npm audit.\n` +
        '  Remove it from ALLOWLIST in scripts/check-audit.mjs — an exception that outlives its cause\n' +
        '  narrows this gate for everything that comes after it.',
    );
  }

  return errors;
}

// Guarded so the spec can import the two functions above without running a real audit.
//
// Compare REAL PATHS, not a hand-built file URL. `import.meta.url` is percent-encoded, so any
// checkout path needing escaping (a space, a `#`, non-ASCII) made `file://${process.argv[1]}`
// differ and the gate exited 0 having run no audit at all. On Windows it never matched: argv[1] is
// a native path with backslashes and a drive letter. `fileURLToPath` decodes the URL to a native
// path and `realpathSync` resolves argv[1], symlinks included (Node realpaths the main module URL,
// so an unresolved path through a symlink never matched).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runAudit();

  // A registry that cannot answer the audit request must not be read as a clean tree. On a merge
  // path this step skips loudly rather than failing while npm's audit endpoint is down (or being
  // retired). That keeps the root step from failing, not the audit job green: the dashboard audit
  // step fails closed on the same outage. A required path fails. See unavailableOutcome.
  if (auditUnavailable(report)) {
    const outcome = unavailableOutcome(report?.error?.summary ?? 'no report');
    for (const line of outcome.lines) console.log(line);
    process.exit(outcome.exitCode);
  }

  const errors = evaluate(report);

  if (errors.length > 0) {
    console.error('check:audit failed:\n');
    for (const error of errors) console.error(`- ${error}\n`);
    process.exit(1);
  }

  const excused = ALLOWLIST.length;
  console.log(
    `check:audit passed — no unexcused high/critical advisories in the root tree` +
      (excused > 0 ? ` (${excused} allowlisted: ${ALLOWLIST.map(a => a.id).join(', ')})` : ''),
  );
}
