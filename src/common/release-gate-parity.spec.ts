import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { executableLines } from './workflow-lines';

/**
 * The release workflow publishes the image and the GitHub Release from a tag push. A tag starts
 * release.yml ALONE (ci.yml triggers on branches), so whatever gate the tag path skips is a gate a
 * release never ran; the workflow's own header states the invariant ("a tag can never publish
 * something the branch gate would have refused"; "the release gate must not be laxer than the PR
 * gate"). Both sides drifted before: check:contract-shapes and test:docs ran only on branches, so
 * an SDK wire-shape regression or a repo-file drift could ride a tag to publication while the same
 * commit would have failed CI.
 *
 * This locks the invariant structurally: every gate command (npm/npx lines) in ci.yml's lint and
 * test jobs must also run in release.yml's lint and test jobs (the workflow header and the check:audit step comment both state
 * the invariant; this spec makes it enforced). The release jobs may run MORE
 * (its lint also carries the audit gate); only the subset direction is asserted.
 */

const workflowDir = path.join(__dirname, '..', '..', '.github', 'workflows');

type Step = { run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const gateCommands = (file: string, job: string): string[] => {
  const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
  const steps = workflow.jobs?.[job]?.steps ?? [];
  if (steps.length === 0) throw new Error(`${file} has no "${job}" job: the parity spec drifted`);
  return steps.flatMap(step =>
    executableLines(step.run ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^npx |^npm /.test(line)),
  );
};

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

  it('the two gates this spec was born from still run on the tag path', () => {
    expect(gateCommands('release.yml', 'lint')).toContain('npm run check:contract-shapes');
    expect(gateCommands('release.yml', 'test')).toContain('npm run test:docs');
    // The postgres lane names its specs inline, so a spec added to ci.yml alone would otherwise
    // leave the tag path running a strictly weaker suite than the branch it was cut from.
    expect(gateCommands('release.yml', 'test-postgres').join(' ')).toContain('message-list-ordering.pg.spec.ts');
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
  const auditSteps = (file: string): AuditStep[] => {
    const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
      jobs?: Record<string, { steps?: AuditStep[] }>;
    };
    return Object.values(workflow.jobs ?? {})
      .flatMap(job => job.steps ?? [])
      .filter(step => executableLines(step.run ?? '').includes('npm run check:audit'));
  };

  it.each(['release.yml', 'security-scan.yml'])('%s requires the audit', file => {
    const steps = auditSteps(file);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter(step => step.env?.CHECK_AUDIT_REQUIRED !== '1')).toEqual([]);
  });

  it('docs/10 describes the weekly audit as required, not as the merge job', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '10-devops-infrastructure.md'), 'utf8');
    const paragraph = doc.split(/\n\s*\n/).find(block => block.includes('security-scan.yml'));
    expect(paragraph).toContain('`CHECK_AUDIT_REQUIRED=1`');
    expect(paragraph).not.toMatch(/exact\s+`audit`/);
  });

  it('ci.yml keeps the skip for merges', () => {
    const steps = auditSteps('ci.yml');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some(step => step.env?.CHECK_AUDIT_REQUIRED !== undefined)).toBe(false);
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

  // Attesting first means a failed attestation leaves no release tag published.
  it('promote attests the tested digest before re-pointing the release tags', () => {
    const promote = jobs().promote;
    const steps = promote?.steps ?? [];
    expect(steps.length).toBeGreaterThan(1);
    const attest = steps.findIndex(step =>
      /^actions\/attest(?:-build-provenance)?@[0-9a-f]{40}\b/.test(step.uses ?? ''),
    );
    const retag = steps.findIndex(step => executableLines(step.run ?? '').includes('imagetools create'));
    expect(attest).toBeGreaterThan(-1);
    expect(retag).toBeGreaterThan(attest);
    expect(steps[attest].with?.['subject-digest']).toContain('needs.docker.outputs.digest');
    expect(grant(promote?.permissions, 'id-token')).toBe('write');
    expect(grant(promote?.permissions, 'attestations')).toBe('write');
  });

  // The signing grant stays on the one job that needs it, away from the build and test jobs.
  it.each(['docker', 'boot-smoke', 'image-scan'])('%s cannot mint an OIDC token', job => {
    expect(jobs()[job]).toBeDefined();
    expect(grant(jobs()[job].permissions, 'id-token')).toBeUndefined();
  });

  it('verify-published checks the attestation of every promoted tag', () => {
    const verify = jobs()['verify-published'];
    const run = (verify?.steps ?? []).map(step => executableLines(step.run ?? '')).join('\n');
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
    return steps.map(step => executableLines(step.run ?? '')).join('\n');
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

  // A full browser launch under QEMU user emulation is slow and unreliable, and the release gate
  // cannot fail on an emulator fault. An emulated platform runs the browser binary instead; the
  // daemon's own platform, and the host-platform run in ci.yml, still launch it.
  it.each([
    [undefined, true],
    ['linux/amd64', true],
    ['linux/arm64', false],
  ])('the engine library smoke on %s launches the browser: %s', (platform, launches) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-libs-docker-'));
    try {
      const calls = path.join(dir, 'calls');
      fs.writeFileSync(
        path.join(dir, 'docker'),
        `#!/bin/sh\nif [ "$1" = version ]; then echo amd64; exit 0; fi\nprintf '%s\\n@@end@@\\n' "$*" >> '${calls}'\n`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, OPENWA_SMOKE_IMAGE: 'img' };
      delete env.OPENWA_SMOKE_PLATFORM;
      if (platform) env.OPENWA_SMOKE_PLATFORM = platform;
      const result = spawnSync('sh', [path.join(__dirname, '..', '..', 'scripts', 'smoke-test-engine-libs.sh')], {
        env,
      });
      expect(result.status).toBe(0);
      const runs = fs.readFileSync(calls, 'utf8').split('@@end@@\n').filter(Boolean);
      expect(runs).toHaveLength(2);
      const browser = runs[1];
      expect(browser).toContain("require('whatsapp-web.js')");
      if (platform) expect(browser).toContain(`--platform ${platform}`);
      if (launches) {
        expect(browser).toContain('.launch(');
      } else {
        expect(browser).not.toContain('.launch(');
        expect(browser).toContain('--version');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
