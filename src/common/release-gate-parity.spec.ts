import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { executableLines, executableLinesConservative } from './workflow-lines';

/**
 * The release workflow publishes the image and the GitHub Release from a tag push. A tag starts
 * release.yml ALONE (ci.yml triggers on branches), so whatever gate the tag path skips is a gate a
 * release never ran; the workflow's own header states the invariant ("a tag can never publish
 * something the branch gate would have refused"; "for the trees the image ships, the release gate
 * must not be laxer than the PR gate"). Both sides drifted before: check:contract-shapes and
 * test:docs ran only on branches, so an SDK wire-shape regression or a repo-file drift could ride a
 * tag to publication while the same commit would have failed CI.
 *
 * This locks the invariant structurally: every gate command (npm/npx lines) in ci.yml's lint and
 * test jobs must also run in release.yml's lint and test jobs (the workflow header and the check:audit step comment both state
 * the invariant; this spec makes it enforced). The release jobs may run MORE
 * (its lint also carries the audit gate); only the subset direction is asserted. The dashboard,
 * scripts-smoke and chart jobs run `cd dashboard && …`, shellcheck, scripts and helm rather than
 * bare npm/npx lines, so for them every whole `run` step is compared instead.
 */

const workflowDir = path.join(__dirname, '..', '..', '.github', 'workflows');

type Step = { run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const jobSteps = (file: string, job: string): Step[] => {
  const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
  const steps = workflow.jobs?.[job]?.steps ?? [];
  if (steps.length === 0) throw new Error(`${file} has no "${job}" job: the parity spec drifted`);
  return steps;
};

// The shell skips a space and a tab and nothing else, so only those come off a line: String.trim() would also
// drop U+00A0 and the other blanks the shell reads as part of a word, and count `<U+00A0>npm run x` as the
// command `npm run x` when the shell runs one named `<U+00A0>npm` (127).
const stripBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, '');

// The lines of these scripts that are an npm or npx command. They are compared whole, so they are read
// exactly; a caller that looks for a name inside them passes the conservative reading.
const commandLines = (runs: string[], read: (run: string) => string = executableLines): string[] =>
  runs.flatMap(run =>
    read(run)
      .split('\n')
      .map(stripBlanks)
      .filter(line => /^npx |^npm /.test(line)),
  );

const gateCommands = (file: string, job: string, read: (run: string) => string = executableLines): string[] =>
  commandLines(
    jobSteps(file, job).map(step => step.run ?? ''),
    read,
  );

// A whole run, compared whole: the blank lines a comment leaves and the newline that ends the block go too.
const runSteps = (file: string, job: string): string[] =>
  jobSteps(file, job)
    .filter(step => step.run !== undefined)
    .map(step => executableLines(step.run ?? '').replace(/^[ \t\n]+|[ \t\n]+$/g, ''));

describe('release gate parity (the tag path runs every branch gate)', () => {
  it.each(['lint', 'test', 'test-postgres'])('%s: every ci.yml gate command also runs in release.yml', job => {
    const ci = gateCommands('ci.yml', job);
    const release = gateCommands('release.yml', job);
    // Non-vacuity: both parsers must find real gate lanes, or the subset assertion below binds nothing.
    // The test lane legitimately has only 4-5 commands, so the floor is what the lane actually owns.
    expect(ci.length).toBeGreaterThanOrEqual(4);
    expect(release.length).toBeGreaterThanOrEqual(4);
    expect(ci.filter(command => !release.includes(command))).toEqual([]);
  });

  it.each(['dashboard', 'scripts-smoke', 'chart'])('%s: every ci.yml run step also runs in release.yml', job => {
    const ci = runSteps('ci.yml', job);
    const release = runSteps('release.yml', job);
    expect(ci.length).toBeGreaterThanOrEqual(4);
    expect(release.length).toBeGreaterThanOrEqual(4);
    expect(ci.filter(step => !release.includes(step))).toEqual([]);
  });

  it('does not count as a gate command a line that begins with a blank the shell does not skip', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(commandLines([`${nbsp}npm run lint\n  npm run test \t\n\t${nbsp}npx tsc`])).toEqual(['npm run test']);
  });

  it('the two gates this spec was born from still run on the tag path', () => {
    expect(gateCommands('release.yml', 'lint')).toContain('npm run check:contract-shapes');
    expect(gateCommands('release.yml', 'test')).toContain('npm run test:docs');
    // The postgres lane names its specs inline, so a spec added to ci.yml alone would otherwise
    // leave the tag path running a strictly weaker suite than the branch it was cut from.
    expect(gateCommands('release.yml', 'test-postgres', executableLinesConservative).join(' ')).toContain(
      'message-list-ordering.pg.spec.ts',
    );
  });
});

/**
 * Running the same commands is not enough: a gate stops a release only when its failure does. A step
 * that carries `continue-on-error` or an `if`, a publishing job that no longer waits for a gate job, or
 * a job of its own with a condition such as `always()` (which runs past a failed need) keeps every
 * command above in place and still lets a tag publish with the suite red.
 */
describe('release gate jobs can stop the publish jobs', () => {
  type GateStep = {
    name?: string;
    uses?: string;
    run?: string;
    env?: Record<string, unknown>;
    with?: Record<string, unknown>;
    if?: unknown;
    'continue-on-error'?: unknown;
  };
  type GateJob = {
    needs?: string | string[];
    if?: unknown;
    'continue-on-error'?: unknown;
    env?: Record<string, unknown>;
    strategy?: { matrix?: { platform?: string[] } };
    steps?: GateStep[];
  };
  const workflowEnv = (): Record<string, unknown> =>
    (yaml.load(fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8')) as { env?: Record<string, unknown> })
      .env ?? {};
  const jobs = (): Record<string, GateJob> =>
    (yaml.load(fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8')) as { jobs?: Record<string, GateJob> })
      .jobs ?? {};
  const GATES = ['lint', 'test', 'test-postgres', 'dashboard', 'scripts-smoke', 'chart', 'build'];
  // The jobs that put the image on the registries and the Release on GitHub.
  const PUBLISHERS = ['docker', 'promote', 'release'];
  const needsOf = (job: GateJob): string[] => (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []));
  // A job with a condition of its own (always(), failure(), ...) or continue-on-error can run, and
  // succeed, after one of its needs failed, so its needs say nothing about whether it ran on a green tree.
  const isSoft = (job: GateJob | undefined): boolean =>
    job?.if !== undefined || job?.['continue-on-error'] !== undefined;
  // What a job can only run after: its needs, and theirs wherever the job in between is not soft.
  const closure = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = isSoft(jobs()[start]) ? [] : [start];
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
      for (const need of needsOf(jobs()[name] ?? {})) {
        if (!seen.has(need)) {
          seen.add(need);
          if (!isSoft(jobs()[need])) queue.push(need);
        }
      }
    }
    return seen;
  };

  it.each(GATES)('%s runs unconditionally and a failing step fails the job', gate => {
    const job = jobs()[gate];
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    const softened = (job.steps ?? []).filter(step => step.if !== undefined || step['continue-on-error'] !== undefined);
    expect(softened).toEqual([]);
  });

  // The image gates and the check of what the public can pull are jobs of their own, so a failure of one
  // stops the publish jobs only while neither it nor one of its steps is allowed to fail. closure() above
  // would still list one as a need after such an edit.
  it.each(['boot-smoke', 'image-scan', 'verify-published'])('%s cannot fail without failing the job', gate => {
    const job = jobs()[gate];
    expect(job).toBeDefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect((job.steps ?? []).filter(step => step['continue-on-error'] !== undefined)).toEqual([]);
  });

  // The scanner's failure switch is an input, not continue-on-error, and a step with a condition of its own
  // can be skipped while its job stays green: `exit-code: 0` on the scan, or `if: false` on a smoke step,
  // turns a gate into a pass for whatever the image holds. Both are pinned here.
  it('image-scan fails the job on a CRITICAL or HIGH finding the ignore file does not name', () => {
    const trivy = (jobs()['image-scan'].steps ?? []).filter(step =>
      (step.uses ?? '').startsWith('aquasecurity/trivy-action'),
    );
    expect(trivy).toHaveLength(1);
    expect(String(trivy[0].with?.['exit-code'])).toBe('1');
    expect(trivy[0].with?.severity).toBe('CRITICAL,HIGH');
    expect(trivy[0].with?.trivyignores).toBe('.trivyignore');
  });

  // What the scan looks at is pinned as well as what it fails on: a scan of the checkout, of OS packages
  // alone, with a directory skipped, or of one architecture reads green for an image it did not inspect.
  it('image-scan reads the OS packages and libraries of the image on both architectures, skipping nothing', () => {
    const scan = (jobs()['image-scan'].steps ?? []).find(step => (step.uses ?? '').startsWith('aquasecurity/'));
    expect(scan?.with?.['scan-type']).toBe('image');
    expect(scan?.with?.['vuln-type']).toBe('os,library');
    for (const input of ['skip-dirs', 'skip-files', 'scanners', 'ignore-policy']) {
      expect(scan?.with?.[input]).toBeUndefined();
    }
    expect(jobs()['image-scan'].strategy?.matrix?.platform).toEqual(['linux/amd64', 'linux/arm64']);
  });

  // trivy-action leaves a TRIVY_* variable the caller set in force whenever the matching input is empty or
  // the action's default, so an environment value can skip a path, a scanner or a package type, retarget the
  // architecture or the image, while every input above still reads right.
  it('image-scan sets no scanner variable but the architecture, and scans the image the build staged', () => {
    const scanJob = jobs()['image-scan'];
    const scan = (scanJob.steps ?? []).find(step => (step.uses ?? '').startsWith('aquasecurity/'));
    expect(scan?.env).toEqual({ TRIVY_PLATFORM: '${{ matrix.platform }}' });
    expect(Object.keys({ ...workflowEnv(), ...(scanJob.env ?? {}) }).filter(key => key.startsWith('TRIVY_'))).toEqual(
      [],
    );
    expect(scan?.with?.['image-ref']).toBe('${{ steps.image.outputs.ref }}');
    const resolve = (scanJob.steps ?? []).find(step => step.name === 'Resolve staging image ref');
    expect(executableLinesConservative(resolve?.run ?? '')).toContain(
      'echo "ref=ghcr.io/${REPO,,}:smoke-${{ github.run_id }}" >> "$GITHUB_OUTPUT"',
    );
    // Written once: a later write to the same output wins, so none may be hidden behind a '#'.
    expect(executableLines(resolve?.run ?? '').split('GITHUB_OUTPUT')).toHaveLength(2);
  });

  // Promotion re-points tags, and is safe only because every one of them is checked to resolve to the
  // digest the build job produced and the gates tested. A comparison that no longer runs, or a digest
  // taken from anywhere else, keeps the step green for content nobody tested.
  it('promote tags only the digest the build produced, and finds both architectures on the release tag', () => {
    const steps = jobs().promote.steps ?? [];
    const tag = steps.find(step => step.name === 'Tag the smoke-tested image with the release tags');
    expect(tag).toBeDefined();
    expect(tag?.env?.EXPECTED_DIGEST).toBe('${{ needs.docker.outputs.digest }}');
    const verify = steps.find(step => step.name === 'Verify the release tag resolves and is multi-arch');
    expect(verify).toBeDefined();
    // The comparisons end the step when they fail, the steps cannot fail softly, and the digest they
    // compare against is assigned once, from the build job.
    const body = (text: string, start: string): string => {
      const lines = text.split('\n').map(stripBlanks);
      const from = lines.indexOf(start);
      const to = lines.indexOf('fi', from);
      return from === -1 || to === -1 ? '' : lines.slice(from, to).join('\n');
    };
    // Both readings: a line has to be there as written and found before any '#' that may start a comment,
    // and what must not be there has to be absent from everything the shell may run.
    for (const read of [executableLines, executableLinesConservative]) {
      const lines = read(tag?.run ?? '');
      expect(lines).toContain('if [ "$actual" != "$EXPECTED_DIGEST" ]; then');
      expect(lines).toContain('if [ "$promoted_digest" != "$EXPECTED_DIGEST" ]; then');
      expect(lines).toContain('docker buildx imagetools create --tag "$tag" "$staging"');
      const verifyLines = read(verify?.run ?? '');
      expect(verifyLines).toContain('for want in linux/amd64 linux/arm64; do');
      expect(verifyLines).toContain('grep -q "$want" /tmp/inspect.txt || { echo "MISSING PLATFORM: $want"; exit 1; }');
      expect(body(lines, 'if [ "$actual" != "$EXPECTED_DIGEST" ]; then')).toContain('exit 1');
      expect(body(lines, 'if [ "$promoted_digest" != "$EXPECTED_DIGEST" ]; then')).toContain('exit 1');
      expect(lines.match(/\bEXPECTED_DIGEST=/g) ?? []).toEqual([]);
      expect(lines.match(/^\s*actual=/gm) ?? []).toHaveLength(1);
      expect(verifyLines).toContain('ref="ghcr.io/${REPO,,}:${GITHUB_REF#refs/tags/v}"');
      expect(verifyLines).not.toMatch(/\|\|\s*true|;\s*true\b/);
    }
    for (const step of [tag, verify]) {
      expect(step?.['continue-on-error']).toBeUndefined();
      expect(step?.if).toBeUndefined();
    }
  });

  it.each(['boot-smoke', 'image-scan', 'verify-published'])(
    '%s has no step with a condition of its own but the documented one',
    gate => {
      const conditioned = (jobs()[gate].steps ?? [])
        .filter(step => step.if !== undefined)
        .map(step => `${step.name}: ${String(step.if)}`);
      // The boot check runs after a failed smoke step on purpose, so that its log is not lost.
      expect(conditioned).toEqual(
        gate === 'boot-smoke' ? ['Boot + liveness check on each architecture: ${{ !cancelled() }}'] : [],
      );
    },
  );

  it.each(PUBLISHERS)('%s has no condition of its own that lets it run after a failed gate', publisher => {
    const job = jobs()[publisher];
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
  });

  it.each(PUBLISHERS)('%s waits, directly or through unconditional jobs, for every gate job', publisher => {
    expect(jobs()[publisher]).toBeDefined();
    expect(GATES.filter(gate => !closure(publisher).has(gate))).toEqual([]);
  });

  // The image gates and the check of what the public can pull are jobs of their own. Dropping them from a
  // needs list leaves every command above in place, so a tag would move the release tags without the boot
  // check on both architectures or the vulnerability scan, or publish the Release without either.
  it('promote waits for the image gates, and the Release for promote and the anonymous pull check', () => {
    expect(['docker', 'boot-smoke', 'image-scan'].filter(gate => !closure('promote').has(gate))).toEqual([]);
    expect(['promote', 'verify-published'].filter(job => !needsOf(jobs().release).includes(job))).toEqual([]);
  });
});

/**
 * A tag is a prerelease or it is not, and every release channel has to agree. The image channels
 * (X.Y, latest) and the promote job treat any tag with a '-' suffix as a prerelease; when the
 * GitHub Release matched only -rc/-beta/-alpha, a tag such as v1.2.0-next.1 stayed off `latest` on
 * the registries yet became GitHub's "Latest" release, which is what the in-app update check reads.
 */
describe('one prerelease rule across the GitHub Release and the image channels', () => {
  type ReleaseStep = { uses?: string; run?: string; with?: { prerelease?: string; tags?: string } };
  const PREDICATE = "contains(github.ref_name, '-')";
  const steps = (): ReleaseStep[] => {
    const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8')) as {
      jobs?: Record<string, { steps?: ReleaseStep[] }>;
    };
    return Object.values(workflow.jobs ?? {}).flatMap(job => job.steps ?? []);
  };

  it('flags the GitHub Release prerelease by the predicate that keeps a tag off X.Y and latest', () => {
    const ghRelease = steps().filter(step => (step.uses ?? '').startsWith('softprops/action-gh-release'));
    expect(ghRelease).toHaveLength(1);
    expect((ghRelease[0].with?.prerelease ?? '').trim()).toBe(`\${{ ${PREDICATE} }}`);

    const tagRules = steps()
      .filter(step => (step.uses ?? '').startsWith('docker/metadata-action'))
      .map(step => step.with?.tags ?? '')
      .join('\n');
    const enables = [...tagRules.matchAll(/enable=\$\{\{\s*(.*?)\s*\}\}/g)].map(match => match[1]);
    // Non-vacuity: the X.Y and latest channels are both gated.
    expect(enables.length).toBeGreaterThanOrEqual(2);
    expect(enables.filter(expr => expr !== `!${PREDICATE}`)).toEqual([]);

    // The promote job's own skip for minor tags uses the same '-' test in bash.
    expect(steps().some(step => /\[\[ "\$REF_NAME" == \*-\* \]\]/.test(step.run ?? ''))).toBe(true);
  });
});

/**
 * check:audit skips when npm's audit endpoint cannot answer, so an npm outage does not block every
 * merge. The release and the weekly scan must not take that skip: one would publish, the other would
 * report the week clean, with no advisory checked. CHECK_AUDIT_REQUIRED=1 turns the skip into a failure.
 */
describe('the release and weekly audits fail when the audit cannot run', () => {
  type AuditStep = { run?: string; env?: Record<string, unknown> };
  type AuditWorkflow = { jobs?: Record<string, { steps?: AuditStep[] }> };
  const auditWorkflow = (file: string): AuditWorkflow =>
    yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as AuditWorkflow;
  // The steps that run the audit as a reading sees it. Both are used, for different questions: a step that
  // CERTAINLY runs it (conservative) has to be there, and every step that MAY run it (exact) is held to the
  // rule, or an extra one written as `echo x<U+00A0>#; npm run check:audit` takes the skip unseen.
  const auditSteps = (workflow: AuditWorkflow, read: (run: string) => string): AuditStep[] =>
    Object.values(workflow.jobs ?? {})
      .flatMap(job => job.steps ?? [])
      .filter(step => read(step.run ?? '').includes('npm run check:audit'));
  const unrequired = (workflow: AuditWorkflow): string[] => [
    ...(auditSteps(workflow, executableLinesConservative).length === 0 ? ['no step certainly runs the audit'] : []),
    ...auditSteps(workflow, executableLines)
      .filter(step => step.env?.CHECK_AUDIT_REQUIRED !== '1')
      .map(() => 'a step that may run the audit does not require it'),
  ];

  it.each(['release.yml', 'security-scan.yml'])('%s requires the audit', file => {
    expect(unrequired(auditWorkflow(file))).toEqual([]);
  });

  it.each(['release.yml', 'security-scan.yml'])('%s: refuses an audit step that does not require it', file => {
    const copy = (): AuditWorkflow => JSON.parse(JSON.stringify(auditWorkflow(file))) as AuditWorkflow;
    const anyJob = (workflow: AuditWorkflow): AuditStep[] => Object.values(workflow.jobs ?? {})[0].steps ?? [];
    // Each blank the shell reads as part of a word: the `#` after it is no comment, so the audit after the `;`
    // runs, with the skip.
    for (const code of [0xa0, 0x3000, 0xfeff, 0x2028]) {
      const blank = String.fromCharCode(code);
      const extra = copy();
      anyJob(extra).push({ run: `echo x${blank}#; npm run check:audit` });
      expect([code, unrequired(extra)]).toEqual([code, ['a step that may run the audit does not require it']]);
    }
    // The same line behind a space is a comment, and the real step with its requirement taken off is not.
    const comment = copy();
    anyJob(comment).push({ run: 'echo x # npm run check:audit' });
    expect(unrequired(comment)).toEqual([]);
    const lax = copy();
    for (const step of auditSteps(lax, executableLines)) step.env = { CHECK_AUDIT_REQUIRED: '0' };
    expect(unrequired(lax)).toEqual(['a step that may run the audit does not require it']);
    // A step that only names the audit behind such a blank and a `#` is no audit: one must really run.
    const named = copy();
    for (const step of auditSteps(named, executableLines))
      step.run = `echo x${String.fromCharCode(0xa0)}# npm run check:audit`;
    expect(unrequired(named)).toContain('no step certainly runs the audit');
  });

  it('docs/10 describes the weekly audit as required, not as the merge job', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '10-devops-infrastructure.md'), 'utf8');
    const paragraph = doc.split(/\n\s*\n/).find(block => block.includes('security-scan.yml'));
    expect(paragraph).toContain('`CHECK_AUDIT_REQUIRED=1`');
    expect(paragraph).not.toMatch(/exact\s+`audit`/);
  });

  it('ci.yml keeps the skip for merges', () => {
    const ci = auditWorkflow('ci.yml');
    expect(auditSteps(ci, executableLinesConservative).length).toBeGreaterThan(0);
    // Every step that may run it, not only one that certainly does.
    expect(auditSteps(ci, executableLines).some(step => step.env?.CHECK_AUDIT_REQUIRED !== undefined)).toBe(false);
  });
});

/**
 * Each npm tree has its own lockfile, and `npm audit` in one directory never sees another's. A tree
 * the merge and weekly audits skip, or that Dependabot does not watch, collects advisories unseen.
 */
describe('every npm tree is audited and kept current', () => {
  const root = path.join(__dirname, '..', '..');
  const trees = (): string[] =>
    spawnSync('git', ['ls-files', '--', '*package-lock.json'], { cwd: root, encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .map(file => path.posix.dirname(file).replace(/^\.$/, ''));
  const auditCommand = (tree: string): string =>
    tree === '' ? 'npm run check:audit' : `cd ${tree} && npm audit --audit-level=high`;

  it('finds every tree', () => {
    expect(trees()).toEqual(expect.arrayContaining(['', 'dashboard', 'sdk/javascript']));
  });

  it.each(['ci.yml', 'security-scan.yml'])('%s audits every tree', file => {
    const runs = runSteps(file, 'audit');
    expect(trees().filter(tree => !runs.includes(auditCommand(tree)))).toEqual([]);
  });

  type ReleaseStep = { run?: string; 'continue-on-error'?: unknown; 'working-directory'?: string };
  type ReleaseWorkflow = {
    jobs: Record<string, { defaults?: { run?: { 'working-directory'?: string } }; steps: ReleaseStep[] }>;
  };
  const releaseWorkflow = (file: string): ReleaseWorkflow =>
    yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as ReleaseWorkflow;
  const auditsOf = (workflow: ReleaseWorkflow, job: string) => {
    const cwd = workflow.jobs[job].defaults?.run?.['working-directory'] ?? '';
    return workflow.jobs[job].steps.flatMap((step, index) =>
      executableLines(step.run ?? '')
        .split('\n')
        .map(line => /^(?:cd (\S+) && )?npm (?:run check:audit|audit --audit-level=high)$/.exec(stripBlanks(line)))
        .flatMap(match =>
          match ? [{ index, step, tree: path.posix.join(cwd, match[1] ?? '').replace(/^\.$/, '') }] : [],
        ),
    );
  };
  const releaseAudits = (file: string, job: string) => auditsOf(releaseWorkflow(file), job);

  // A tag starts only its own release workflow, so each one audits the trees it publishes: the image
  // carries the root and the dashboard, the npm package is built from the SDK. Exact, so moving a
  // tree from one path to the other is a deliberate edit here.
  it.each([
    ['release.yml', 'lint', ['', 'dashboard']],
    ['js-sdk-release.yml', 'build', ['sdk/javascript']],
  ])('%s %s audits exactly the trees it publishes', (file, job, published) => {
    const audits = releaseAudits(file, job);
    expect(audits.map(audit => audit.tree)).toEqual(published);
    // An audit allowed to fail gates nothing, and a step-level working-directory audits another tree.
    expect(
      audits.filter(({ step }) => step['continue-on-error'] !== undefined || step['working-directory'] !== undefined),
    ).toEqual([]);
  });

  // `npm audit` reads the lockfile alone, so a high advisory stops the build job before `npm ci`
  // runs any of the toolchain. Every step that may install, on any line of its script and not only as the
  // whole of one, comes after the audit, so the install is read exactly.
  // `npm ci`, `npm install`, `npm i` and `npm add`, with options before the subcommand (`npm --prefix x ci`).
  const INSTALL = /\bnpm(?:[ \t]+-\S+(?:[ \t]+[^\s-]\S*)?)*[ \t]+(?:ci|install|i|add)\b/;
  const installProblems = (workflow: ReleaseWorkflow, job: string): string[] => {
    const audit = auditsOf(workflow, job)[0]?.index ?? -1;
    const installs = workflow.jobs[job].steps.flatMap((step, index) =>
      INSTALL.test(executableLines(step.run ?? '')) ? [index] : [],
    );
    return [
      ...(audit === -1 ? ['no audit step'] : []),
      ...(installs.length === 0 ? ['no install step'] : []),
      ...installs.filter(index => index <= audit).map(index => `step ${index + 1} may install before the audit`),
    ];
  };

  it('js-sdk-release.yml audits the SDK before it installs it', () => {
    expect(installProblems(releaseWorkflow('js-sdk-release.yml'), 'build')).toEqual([]);
  });

  it('js-sdk-release.yml: refuses an install that may run before the audit', () => {
    const copy = (): ReleaseWorkflow =>
      JSON.parse(JSON.stringify(releaseWorkflow('js-sdk-release.yml'))) as ReleaseWorkflow;
    const auditAt = auditsOf(copy(), 'build')[0].index;
    const early = (run: string): ReleaseWorkflow => {
      const workflow = copy();
      workflow.jobs.build.steps.splice(auditAt, 0, { run });
      return workflow;
    };
    const before = [`step ${auditAt + 1} may install before the audit`];
    // After another command of the same script, and as the second command of a line.
    for (const run of [
      'echo start\nnpm ci',
      'cd . && npm install',
      'npm i left-pad',
      'echo x; npm ci --ignore-scripts',
      'npm --prefix . ci',
      'npm --no-fund --loglevel silent add left-pad',
      'if true; then\n  npm ci\nfi',
    ]) {
      expect([run, installProblems(early(run), 'build')]).toEqual([run, before]);
    }
    // Words that only look like one, and a comment, are not an install.
    for (const run of ['npm run install-hooks', 'npm pack # npm ci', '# npm ci']) {
      expect([run, installProblems(early(run), 'build')]).toEqual([run, []]);
    }
    const none = copy();
    none.jobs.build.steps = none.jobs.build.steps.filter(step => !/npm ci/.test(step.run ?? ''));
    expect(installProblems(none, 'build')).toEqual(['no install step']);
  });

  // The clients that are not npm packages publish runtime dependencies of their own, and the audit steps
  // above cannot see those manifests, so an advisory in one is raised only by Dependabot.
  it.each([
    ['pip', 'sdk/python/pyproject.toml'],
    ['maven', 'sdk/java/pom.xml'],
    ['composer', 'sdk/php/composer.json'],
    ['gomod', 'sdk/go/go.mod'],
  ])('Dependabot updates the %s manifest %s', (ecosystem, manifest) => {
    const tracked = spawnSync('git', ['ls-files', '--', manifest], { cwd: root, encoding: 'utf8' }).stdout.trim();
    expect(tracked).toBe(manifest);
    const dependabot = yaml.load(fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8')) as {
      updates: Array<{ 'package-ecosystem': string; directory: string }>;
    };
    const watched = dependabot.updates.filter(u => u['package-ecosystem'] === ecosystem).map(u => u.directory);
    expect(watched).toContain(`/${path.posix.dirname(manifest)}`);
  });

  it('Dependabot updates every tree', () => {
    const dependabot = yaml.load(fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8')) as {
      updates: Array<{ 'package-ecosystem': string; directory: string }>;
    };
    const watched = dependabot.updates.filter(u => u['package-ecosystem'] === 'npm').map(u => u.directory);
    expect(trees().filter(tree => !watched.includes(`/${tree}`))).toEqual([]);
  });
});

/**
 * The SDK's engines floor (>=18) is for the published package; its test toolchain needs a newer
 * Node. npm only warns when a locked package's engines exclude the running Node, so a toolchain bump
 * that drops a lane's Node still installs there, then tests on an unsupported runtime or fails at
 * startup on an optional native binding npm skipped. Each job that runs the SDK tests installs under
 * --engine-strict on exactly the lanes the test step runs on.
 */
describe('the JavaScript SDK tests run only on a Node their toolchain supports', () => {
  type LaneStep = { run?: string; if?: string };
  const lane = (file: string, job: string): LaneStep[] =>
    (
      yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
        jobs: Record<string, { steps: LaneStep[] }>;
      }
    ).jobs[job].steps;
  // A line of its own anywhere in a script counts, read exactly: `echo start` above `npm ci` in one run is
  // still an install, and a step that may run the tests is held to the lane as well.
  const engineStrictProblems = (steps: LaneStep[]): string[] => {
    const lines = (step: LaneStep): string => executableLines(step.run ?? '');
    const installs = steps.filter(step => /^[ \t]*npm ci\b/m.test(lines(step)));
    const tests = steps.filter(step => /^[ \t]*npm test\b/m.test(lines(step)));
    if (installs.length !== 1) return [`${installs.length} steps may install, expected 1`];
    if (tests.length !== 1) return [`${tests.length} steps may run the tests, expected 1`];
    const gate = tests[0].if;
    const want = gate ? `npm ci --engine-strict=\${{ ${gate} }}` : 'npm ci --engine-strict';
    return [
      ...(installs[0].if === undefined ? [] : ['the install has a condition of its own']),
      ...(installs[0].run === want ? [] : [`the install is ${installs[0].run ?? ''}, expected ${want}`]),
    ];
  };

  it.each([
    ['sdk-ci.yml', 'javascript'],
    ['js-sdk-release.yml', 'build'],
  ])('%s %s installs under --engine-strict wherever it runs npm test', (file, job) => {
    expect(engineStrictProblems(lane(file, job))).toEqual([]);
  });

  it.each([
    ['sdk-ci.yml', 'javascript'],
    ['js-sdk-release.yml', 'build'],
  ])('%s %s: refuses a second install, or tests that run beside one without the flag', (file, job) => {
    const copy = (): LaneStep[] => JSON.parse(JSON.stringify(lane(file, job))) as LaneStep[];
    const second = copy();
    second.unshift({ run: 'echo start\nnpm ci' });
    expect(engineStrictProblems(second)).toEqual(['2 steps may install, expected 1']);
    const tests = copy();
    tests.push({ run: 'echo start\nnpm test' });
    expect(engineStrictProblems(tests)).toEqual(['2 steps may run the tests, expected 1']);
    const loose = copy();
    for (const step of loose) if (/^[ \t]*npm ci\b/m.test(step.run ?? '')) step.run = 'npm ci';
    expect(engineStrictProblems(loose)).toEqual([
      expect.stringMatching(/^the install is npm ci, expected npm ci --engine-strict/),
    ]);
  });
});

/**
 * BuildKit's provenance and SBOM travel inside the image index unsigned, so nothing a user could check
 * tied a published image to this workflow. promote now records a signed build-provenance attestation
 * for the tested digest, and verify-published checks it on every promoted tag of both registries.
 */
describe('released images carry a verifiable build-provenance attestation', () => {
  type Perms = Record<string, string> | string | undefined;
  type AttestStep = { uses?: string; run?: string; with?: Record<string, string> };
  type AttestJob = { permissions?: Perms; steps?: AttestStep[] };
  const jobs = (): Record<string, AttestJob> =>
    (yaml.load(fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8')) as { jobs?: Record<string, AttestJob> })
      .jobs ?? {};
  const grant = (perms: Perms, key: string): string | undefined =>
    typeof perms === 'object' && perms !== null ? perms[key] : undefined;

  // Attesting first means a failed attestation leaves no release tag published. Every step that MAY re-point
  // a tag (exact) follows the attestation, and one CERTAINLY does (conservative); a re-point written as
  // `echo x<U+00A0>#; docker buildx imagetools create ...` is a command that runs, so it is held to the order.
  const attestProblems = (steps: AttestStep[]): string[] => {
    const attest = steps.findIndex(step =>
      /^actions\/attest(?:-build-provenance)?@[0-9a-f]{40}\b/.test(step.uses ?? ''),
    );
    const certain = steps.some(step => executableLinesConservative(step.run ?? '').includes('imagetools create'));
    const may = steps.flatMap((step, i) => (executableLines(step.run ?? '').includes('imagetools create') ? [i] : []));
    return [
      ...(attest === -1 ? ['no attest step'] : []),
      ...(certain ? [] : ['no step certainly re-points the tags']),
      ...may.filter(i => i <= attest).map(i => `step ${i + 1} may re-point a tag before the attestation`),
    ];
  };

  it('promote attests the tested digest before re-pointing the release tags', () => {
    const promote = jobs().promote;
    const steps = promote?.steps ?? [];
    expect(steps.length).toBeGreaterThan(1);
    expect(attestProblems(steps)).toEqual([]);
    const attest = steps.findIndex(step =>
      /^actions\/attest(?:-build-provenance)?@[0-9a-f]{40}\b/.test(step.uses ?? ''),
    );
    expect(steps[attest].with?.['subject-digest']).toContain('needs.docker.outputs.digest');
    expect(grant(promote?.permissions, 'id-token')).toBe('write');
    expect(grant(promote?.permissions, 'attestations')).toBe('write');
  });

  it('refuses a re-point that may run before the attestation, or that is only named', () => {
    const copy = (): AttestStep[] => JSON.parse(JSON.stringify(jobs().promote?.steps ?? [])) as AttestStep[];
    const attestAt = copy().findIndex(step => (step.uses ?? '').startsWith('actions/attest'));
    const REPOINT = 'docker buildx imagetools create --tag t s';
    for (const code of [0xa0, 0x3000, 0xfeff, 0x2028]) {
      const steps = copy();
      steps.splice(attestAt, 0, { run: `echo x${String.fromCharCode(code)}#; ${REPOINT}` });
      expect([code, attestProblems(steps)]).toEqual([
        code,
        [`step ${attestAt + 1} may re-point a tag before the attestation`],
      ]);
    }
    // The attestation moved behind the re-point.
    const moved = copy();
    moved.push(...moved.splice(attestAt, 1));
    expect(attestProblems(moved)).toEqual([
      expect.stringMatching(/^step \d+ may re-point a tag before the attestation$/),
    ]);
    // A re-point that is only named behind a blank and a `#` is no re-point at all.
    const named = copy();
    for (const step of named) {
      if (executableLines(step.run ?? '').includes('imagetools create')) {
        step.run = `echo x${String.fromCharCode(0xa0)}# ${REPOINT}`;
      }
    }
    expect(attestProblems(named)).toEqual(['no step certainly re-points the tags']);
  });

  // The signing grant stays on the one job that needs it, away from the build and test jobs.
  it.each(['docker', 'boot-smoke', 'image-scan'])('%s cannot mint an OIDC token', job => {
    expect(jobs()[job]).toBeDefined();
    expect(grant(jobs()[job].permissions, 'id-token')).toBeUndefined();
  });

  it('verify-published checks the attestation of every promoted tag', () => {
    const verify = jobs()['verify-published'];
    const run = (verify?.steps ?? []).map(step => executableLinesConservative(step.run ?? '')).join('\n');
    expect(run).toMatch(/gh attestation verify "oci:\/\/\$ref"/);
    // The same pins the operator checklist below uses, so a green release proves what docs/04 promises.
    expect(run).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"');
    expect(run).toContain('--source-ref "$GITHUB_REF"');
    expect(grant(verify?.permissions, 'attestations')).toBe('read');
  });

  // Without the two pins, `gh attestation verify` accepts any workflow in the repository on any ref,
  // which is less than the checklist promises. Image tags carry no `v`; release git tags do.
  it('the operator checklist pins the release workflow and the tag it ran on', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '04-security-design.md'), 'utf8');
    const command = /`(gh attestation verify [^`]*)`/.exec(doc)?.[1];
    expect(command).toContain('oci://ghcr.io/rmyndharis/openwa:<version>');
    expect(command).toContain('--signer-workflow rmyndharis/OpenWA/.github/workflows/release.yml');
    expect(command).toContain('--source-ref refs/tags/v<version>');
  });

  // The attest step first ran after v0.23.7, so the check would reject every image published before it.
  it('the operator checklist scopes the check to releases that carry an attestation', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '04-security-design.md'), 'utf8');
    const item = doc.split('\n').find(line => line.includes('`gh attestation verify '));
    expect(item).toMatch(/releases after 0\.23\.7/);
    expect(item).toMatch(/earlier images carry no attestation/);
  });
});

/**
 * Every jest lane stubs @whiskeysockets/baileys and puppeteer, and boot never loads Baileys or
 * launches the browser, so nothing ran either engine library before a release. Two hermetic checks
 * close that: the real-library inbound lane over the build, and the in-image library smoke on every
 * architecture the release publishes.
 */
describe('both paths exercise the real engine libraries', () => {
  type EngineStep = { run?: string; env?: Record<string, string> };
  const jobRun = (file: string, job: string): string => {
    const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
      jobs?: Record<string, { steps?: EngineStep[] }>;
    };
    const steps = workflow.jobs?.[job]?.steps ?? [];
    if (steps.length === 0) throw new Error(`${file} has no "${job}" job: the parity spec drifted`);
    // Every caller looks for a name inside the lines, so this is a check that something IS run.
    return steps.map(step => executableLinesConservative(step.run ?? '')).join('\n');
  };

  it.each(['ci.yml', 'release.yml'])('%s build job runs the real-library lane', file => {
    expect(jobRun(file, 'build')).toContain('npm run test:engine-real');
  });

  it('ci.yml loads both engine libraries in the built image', () => {
    expect(jobRun('ci.yml', 'docker')).toContain('./scripts/smoke-test-engine-libs.sh');
  });

  it('release.yml loads both engine libraries on both architectures', () => {
    const run = jobRun('release.yml', 'boot-smoke');
    expect(run).toContain('./scripts/smoke-test-engine-libs.sh');
    expect(run).toMatch(/for platform in linux\/amd64 linux\/arm64/);
    expect(run).toContain('OPENWA_SMOKE_PLATFORM="$platform"');
  });

  // A failure on one architecture must not hide the other's result: both are probed, the step
  // still fails, and the boot check after it still runs and reports.
  it('release.yml probes both architectures and still boots them when one fails', () => {
    type Step = { name?: string; if?: string; run?: string };
    const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8')) as {
      jobs?: Record<string, { steps?: Step[] }>;
    };
    const steps = workflow.jobs?.['boot-smoke']?.steps ?? [];
    const libs = steps.findIndex(step => (step.run ?? '').includes('./scripts/smoke-test-engine-libs.sh'));
    const boot = steps.findIndex(step => /docker run --platform/.test(step.run ?? ''));
    expect(libs).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(libs);
    expect(steps[boot].if).toBe('${{ !cancelled() }}');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-libs-'));
    try {
      fs.mkdirSync(path.join(dir, 'scripts'));
      const stub = path.join(dir, 'scripts', 'smoke-test-engine-libs.sh');
      fs.writeFileSync(stub, '#!/bin/sh\necho "$OPENWA_SMOKE_PLATFORM" >> probed\nexit 1\n', { mode: 0o755 });
      // The runner's default shell for `run:` steps.
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', steps[libs].run ?? ''], {
        cwd: dir,
        env: { ...process.env, IMAGE: 'img' },
      });
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(path.join(dir, 'probed'), 'utf8').trim().split('\n')).toEqual([
        'linux/amd64',
        'linux/arm64',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Runs scripts/smoke-test-engine-libs.sh against a stub `docker` that records every call. What follows the
   * image name is what the container would run: a `find` runs on the host inside a synthetic /app (the image's
   * working directory), the migration CLI prints `listing`, and anything else is only recorded.
   */
  const smokeAgainstStubDocker = (
    options: { platform?: string; layout?: (app: string) => void; listing?: string } = {},
  ): { status: number | null; stderr: string; runs: string[] } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-libs-docker-'));
    try {
      const app = path.join(dir, 'app');
      fs.mkdirSync(path.join(app, 'node_modules', '.bin'), { recursive: true });
      options.layout?.(app);
      const calls = path.join(dir, 'calls');
      fs.writeFileSync(
        path.join(dir, 'docker'),
        [
          '#!/bin/sh',
          'if [ "$1" = version ]; then echo amd64; exit 0; fi',
          `printf '%s\\n@@end@@\\n' "$*" >> '${calls}'`,
          'while [ "$#" -gt 0 ] && [ "$1" != img ]; do shift; done',
          'if [ "$#" -gt 0 ]; then shift; fi',
          'case "$1" in',
          `  find) cd '${app}' && exec "$@" ;;`,
          '  npm) printf "%s" "$MIGRATION_LISTING" ;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      // The CLI underlines each line it lists where the environment advertises color.
      const esc = String.fromCharCode(27);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        OPENWA_SMOKE_IMAGE: 'img',
        MIGRATION_LISTING: options.listing ?? `${esc}[4m[ ] AddMessageStatus1770108659848${esc}[24m\n`,
      };
      delete env.OPENWA_SMOKE_PLATFORM;
      if (options.platform) env.OPENWA_SMOKE_PLATFORM = options.platform;
      const result = spawnSync('sh', [path.join(__dirname, '..', '..', 'scripts', 'smoke-test-engine-libs.sh')], {
        env,
      });
      const runs = fs.readFileSync(calls, 'utf8').split('@@end@@\n').filter(Boolean);
      return { status: result.status, stderr: result.stderr.toString(), runs };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  // A full browser launch under QEMU user emulation is slow and unreliable, and the release gate
  // cannot fail on an emulator fault. An emulated platform runs the browser binary instead; the
  // daemon's own platform, and the host-platform run in ci.yml, still launch it.
  it.each([
    [undefined, true],
    ['linux/amd64', true],
    ['linux/arm64', false],
  ])('the engine library smoke on %s launches the browser: %s', (platform, launches) => {
    const { status, runs } = smokeAgainstStubDocker({ platform });
    expect(status).toBe(0);
    expect(runs).toHaveLength(4);
    const browser = runs[1];
    expect(browser).toContain("require('whatsapp-web.js')");
    if (platform) expect(browser).toContain(`--platform ${platform}`);
    if (launches) {
      expect(browser).toContain('.launch(');
    } else {
      expect(browser).not.toContain('.launch(');
      expect(browser).toContain('--version');
    }
  });

  // The image is built per platform, so the toolchain check and the migration CLI run on each, an
  // emulated one included.
  it.each([undefined, 'linux/amd64', 'linux/arm64'])(
    'the engine library smoke on %s checks the toolchain and runs the migration CLI',
    platform => {
      const [toolchain, migrations] = smokeAgainstStubDocker({ platform }).runs.slice(2);
      expect(toolchain).toContain('find node_modules node_modules/.bin');
      expect(migrations).toContain('npm run --silent migration:show:prod');
      if (platform) {
        expect(toolchain).toContain(`--platform ${platform}`);
        expect(migrations).toContain(`--platform ${platform}`);
      }
    },
  );

  // npm ci --omit=dev keeps typescript and ts-node (devDependencies that valibot and typeorm list as optional
  // peers), so the Dockerfile removes both with their bin links and the smoke proves it on the built image.
  // A bin link left behind by a removal that stopped halfway is dangling, which a plain existence test misses.
  const danglingBin = (app: string, name: string, target: string): void =>
    fs.symlinkSync(target, path.join(app, 'node_modules', '.bin', name));
  const leftovers: Array<[string, string, (app: string) => void]> = [
    [
      'a typescript package',
      'node_modules/typescript',
      app => fs.mkdirSync(path.join(app, 'node_modules', 'typescript')),
    ],
    ['a ts-node package', 'node_modules/ts-node', app => fs.mkdirSync(path.join(app, 'node_modules', 'ts-node'))],
    ['a dangling tsc link', 'node_modules/.bin/tsc', app => danglingBin(app, 'tsc', '../typescript/bin/tsc')],
    [
      'a dangling tsserver link',
      'node_modules/.bin/tsserver',
      app => danglingBin(app, 'tsserver', '../typescript/bin/tsserver'),
    ],
    [
      'a dangling ts-script link',
      'node_modules/.bin/ts-script',
      app => danglingBin(app, 'ts-script', '../ts-node/dist/bin-script-deprecated.js'),
    ],
    [
      'a dangling ts-node-esm link',
      'node_modules/.bin/ts-node-esm',
      app => danglingBin(app, 'ts-node-esm', '../ts-node/dist/bin-esm.js'),
    ],
  ];

  it('the engine library smoke passes an image without the TypeScript toolchain', () => {
    // The neighbours a loose pattern would catch: the typeorm package and its CLI link, and tslib.
    const { status, runs } = smokeAgainstStubDocker({
      layout: app => {
        fs.mkdirSync(path.join(app, 'node_modules', 'typeorm'));
        fs.mkdirSync(path.join(app, 'node_modules', 'tslib'));
        fs.writeFileSync(path.join(app, 'node_modules', '.bin', 'typeorm'), '');
      },
    });
    expect(status).toBe(0);
    expect(runs).toHaveLength(4);
  });

  it.each(leftovers)('the engine library smoke fails on %s left in the image', (_what, leftover, layout) => {
    const { status, stderr } = smokeAgainstStubDocker({ layout });
    expect(status).not.toBe(0);
    expect(stderr).toContain(leftover);
  });

  it('the engine library smoke fails when the migration CLI lists no migration', () => {
    const { status, stderr } = smokeAgainstStubDocker({ listing: '' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('migration:show:prod');
  });

  it('the lane script names the spec it runs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const specs = (pkg.scripts['test:engine-real'] ?? '').split(/\s+/).filter(token => token.endsWith('.spec.mjs'));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(fs.existsSync(path.join(__dirname, '..', '..', spec))).toBe(true);
  });
});

/**
 * trivy-action installs Trivy through contrib/install.sh, which downloads the tarball from get.trivy.dev. That
 * name returned NXDOMAIN on 2026-11-04 and the weekly scan failed before it started; the scan a release waits
 * for installs Trivy the same way. Both scan jobs install the pinned release from GitHub themselves, against a
 * digest kept in scripts/install-trivy.sh, and tell the action to use that binary.
 */
describe('the image scans install the pinned Trivy release themselves', () => {
  type ScanStep = { uses?: string; run?: string; with?: Record<string, unknown> };
  const scanSteps = (file: string): ScanStep[] =>
    (
      yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
        jobs?: Record<string, { steps?: ScanStep[] }>;
      }
    ).jobs?.['image-scan']?.steps ?? [];
  const script = path.join(__dirname, '..', '..', 'scripts', 'install-trivy.sh');

  it.each(['release.yml', 'security-scan.yml'])('%s installs Trivy before the scan and has the action use it', file => {
    const steps = scanSteps(file);
    const install = steps.findIndex(step => step.run?.trim() === './scripts/install-trivy.sh');
    const scan = steps.findIndex(step => (step.uses ?? '').startsWith('aquasecurity/trivy-action'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(install);
    expect(String(steps[scan].with?.['skip-setup-trivy'])).toBe('true');
    expect(steps.filter(step => (step.uses ?? '').startsWith('aquasecurity/setup-trivy'))).toEqual([]);
  });

  it('install-trivy.sh pins a release and its SHA-256, verifies the download, and can be executed', () => {
    const text = fs.readFileSync(script, 'utf8');
    expect(text).toMatch(/^VERSION=\d+\.\d+\.\d+$/m);
    expect(text).toMatch(/^SHA256=[0-9a-f]{64}$/m);
    // Lines the shell runs: a comment that names the check, or a `|| true` after it, does not count as the check.
    const code = executableLines(text);
    expect(code).toMatch(/^set -eu$/m);
    expect(code).toMatch(/^echo "\$SHA256 {2}\$archive" \| sha256sum --check --strict -$/m);
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
  });
});
