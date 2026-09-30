import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { executableLines } from './workflow-lines';

/**
 * The published image has no `USER` directive by design: docker-entrypoint.sh starts as root to fix
 * named-volume ownership and then drops via `exec gosu openwa`. That drop is the only thing keeping
 * an internet-facing Node process (and its Chromium subprocess) off uid 0, and
 * `scripts/smoke-test-non-root.sh` is the only check of it.
 *
 * The script existed but no workflow ran it — its sole appearance in ci.yml was inside a comment
 * explaining why shellcheck names it. A change that left the process as root therefore passed lint,
 * every test job, the multi-arch build, the boot smoke and the image scan, and was promoted to
 * `latest`. These pin that the script is INVOKED, because a mention is not a gate.
 */

const workflowDir = path.join(__dirname, '..', '..', '.github', 'workflows');

type Step = { name?: string; run?: string; uses?: string; with?: unknown };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function workflowOf(file: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
}

function runCommandsOf(file: string): string[] {
  return Object.values(workflowOf(file).jobs ?? {}).flatMap(job =>
    (job.steps ?? []).map(step => executableLines(step.run ?? '')),
  );
}

/**
 * Jobs that execute a repo-relative path, paired with whether the job ever checks the repo out.
 *
 * Both spellings count: `./scripts/x.sh` and the bare `scripts/x.sh` an interpreter is handed
 * (`bash scripts/x.sh`). Matching only the dotted form would leave the gate blind to the other way
 * of writing the very call it exists to protect.
 */
function jobsRunningRepoScripts(file: string): Array<{ job: string; scripts: string[]; hasCheckout: boolean }> {
  const REPO_PATH = /(?:^|[\s'"])(\.\/[\w./-]+|(?:scripts|bin|tools)\/[\w./-]+)/g;
  return Object.entries(workflowOf(file).jobs ?? {})
    .map(([job, def]) => {
      const steps = def.steps ?? [];
      const scripts = steps.flatMap(step => [...(step.run ?? '').matchAll(REPO_PATH)].map(m => m[1]));
      return { job, scripts, hasCheckout: steps.some(step => (step.uses ?? '').startsWith('actions/checkout')) };
    })
    .filter(entry => entry.scripts.length > 0);
}

describe('the non-root drop is enforced, not merely documented', () => {
  // A `run:` extractor that silently matched nothing would make every assertion below vacuously
  // pass. Anchor it on a script the workflows have always invoked.
  it('extracts run commands from the workflows', () => {
    expect(runCommandsOf('ci.yml').join('\n')).toContain('smoke-test-backup-restore.sh');
  });

  // The extractor's own defect, pinned: a mention is not an invocation. Disabling a step by commenting
  // it out is the exact shape that let the script go unrun while this file reported it enforced.
  it('does not count a commented-out invocation as running the script', () => {
    expect(executableLines('# ./scripts/smoke-test-non-root.sh\necho skipped')).not.toContain('smoke-test-non-root.sh');
    expect(executableLines('  OPENWA_SMOKE_IMAGE="$IMAGE" ./scripts/smoke-test-non-root.sh # run it')).toContain(
      'smoke-test-non-root.sh',
    );
    // A '#' inside a quoted string is data; truncating there would drop a real command.
    expect(executableLines('echo "tag #1" && ./scripts/smoke-test-non-root.sh')).toContain('smoke-test-non-root.sh');
  });

  // BOTH paths. The tag path is the one that promotes to `latest`, so a check present only on the PR
  // path leaves the publishing route unguarded — the asymmetry this workflow's own audit step forbids.
  it.each(['ci.yml', 'release.yml'])('invokes the non-root smoke test from %s', file => {
    const invocations = runCommandsOf(file).filter(run => run.includes('smoke-test-non-root.sh'));
    expect(invocations.length).toBeGreaterThan(0);
  });

  // The Dockerfile relies on the entrypoint's gosu drop rather than a USER directive. If that ever
  // changes to a real USER line the smoke test still passes, but this records WHY the directive is
  // absent, so its absence is never read as an oversight and "fixed" by deleting the drop.
  it('keeps the entrypoint gosu drop the image depends on', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    expect(entrypoint).toMatch(/exec\s+gosu\s+openwa/);
  });

  // A start as any other uid (runAsUser, `--user`) holds no CAP_CHOWN or CAP_SETUID, so it must leave
  // before the first chown and the gosu drop: under `set -e` either one exits, and the container
  // restarts in a loop. It must also refuse a data volume it cannot write, naming the cause.
  it('lets a non-root start skip every chown and the gosu drop', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    const exit = entrypoint.search(/^if \[ "\$\(id -u\)" != 0 \]; then\n\s+exec "\$@"\nfi$/m);
    const firstChown = entrypoint.search(/^\s*(?:chown|find\b.*-exec chown)\b/m);
    expect(exit).toBeGreaterThan(-1);
    expect(firstChown).toBeGreaterThan(exit);
    expect(entrypoint.search(/^exec gosu openwa/m)).toBeGreaterThan(exit);
    expect(entrypoint).toMatch(/FATAL: \$dir is not writable by uid/);
  });

  // runAsUser, fsGroup and `--user` name a number, so the image has to guarantee it rather than take
  // whatever `useradd -r` finds free after the apt layers.
  it('pins the openwa uid and gid that the chart and docs name', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    const values = fs.readFileSync(path.join(__dirname, '..', '..', 'charts', 'openwa', 'values.yaml'), 'utf8');
    expect(dockerfile).toMatch(/^RUN groupadd -r -g 997 openwa && useradd -r -u 997 -g openwa openwa$/m);
    expect(values).toMatch(/runAsUser: 997/);
    expect(values).toMatch(/fsGroup: 997/);
  });

  // The Dockerfile explains the missing USER directive by pointing at the entrypoint. A line number
  // goes stale on the next entrypoint edit and sends the reader to the wrong statement.
  it('does not cite entrypoint line numbers from the Dockerfile', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('docker-entrypoint.sh ends with');
    expect(dockerfile).not.toMatch(/docker-entrypoint\.sh:\d/);
    expect(dockerfile).not.toMatch(/chowns? on lines? \d/);
  });

  // Chromium's Singleton* locks, a relocated session profile and a backup staging copy are all
  // symlinks under /app/data. A bind mount that refuses to chown a symlink (Docker Desktop file
  // sharing) failed a recursive chown under `set -e` and crash-looped the container (#1722), and a
  // lock cleanup can only cover the default path. The ownership fix itself has to skip links.
  // `-h` too: find tests the type before the batched chown runs, so without it a path replaced by a
  // link in between would have root re-own the link's target. Only wrong-owned paths are chowned: a
  // chown is a metadata write even when nothing changes, so re-owning the whole volume on every start
  // held boot for minutes on a large one. The ownership test is parenthesised so `! -type l` still
  // governs both of its branches.
  it('re-owns only wrong-owned paths under /app/data, never symlinks', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    const cleanup = entrypoint.search(/^rm -f \/app\/data\/sessions\/\*\/Singleton\*/m);
    const chown = entrypoint.search(
      /^find \/app\/data ! -type l \\\( ! -user openwa -o ! -group openwa \\\) -exec chown -h openwa:openwa \{\} \+$/m,
    );
    expect(entrypoint).not.toMatch(/^\s*chown\s+-R\b.*\/app\/data/m);
    // Swallowing the failure would hide a real refusal (NFS root_squash, SELinux).
    expect(entrypoint).not.toMatch(/-exec chown[^\n]*\|\|/);
    expect(cleanup).toBeGreaterThan(-1);
    expect(chown).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(chown);
  });
});

/**
 * Invoking the script is not the same as being able to run it. `boot-smoke` in release.yml called
 * `./scripts/smoke-test-non-root.sh` from a job that never checks the repo out — the file is simply
 * absent from the workspace, so the step exits 127 and the ONLY path that publishes `latest` fails
 * at every tag. Fail-closed, but the release path was broken rather than guarded.
 *
 * The gate above could not see it: it binds the text of `run:`, and the text was correct. This binds
 * the precondition instead, for every job in every workflow — a repo-relative command needs the repo.
 */
describe('a job that runs a repo script checks the repo out', () => {
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  // Non-vacuity control: the finder must actually see jobs, or every assertion below passes on an
  // empty set. Anchor on a workflow known to run repo scripts.
  it('finds jobs that run repo-relative scripts', () => {
    expect(workflows.length).toBeGreaterThan(0);
    const all = workflows.flatMap(f => jobsRunningRepoScripts(f));
    expect(all.length).toBeGreaterThan(0);
    expect(all.some(e => e.scripts.some(s => s.includes('scripts/')))).toBe(true);
  });

  it.each(workflows)('%s: every job running ./… also runs actions/checkout', file => {
    const offenders = jobsRunningRepoScripts(file)
      .filter(entry => !entry.hasCheckout)
      .map(entry => `${entry.job} runs ${entry.scripts.join(', ')} without actions/checkout`);
    expect(offenders).toEqual([]);
  });
});

/**
 * A job granted `id-token: write` can mint a registry publish credential, so every tool it installs
 * runs with that ability. A floating spec (`npm@latest`, a bare major) resolves to whatever was
 * published most recently at tag time; pin the exact version the way the Dockerfile pins its npm.
 *
 * Python installs cannot be pinned that way: `pip install` resolves the ranges in pyproject.toml, and
 * `python -m build` fetches its build backend into an isolated environment no pin reaches. The same
 * holds for pipx, uv, uvx, poetry and pyproject-build. So an id-token job runs none of them; the
 * install, test and build happen in a job without the grant.
 *
 * Only these two families are checked: other installers (npx, a local npm install, gem, go) in an
 * id-token job are not caught here.
 */
describe('a job that can mint a publish credential pins global npm installs and runs no Python installer', () => {
  type Permissions = Record<string, string> | string | null | undefined;
  type OidcJob = { permissions?: Permissions; steps?: Step[] };
  type OidcWorkflow = { permissions?: Permissions; jobs?: Record<string, OidcJob> };
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const GLOBAL_INSTALL = /\bnpm\s+(?:install|i|add)\s+(?:-g|--global)\s+([^\n;&|]+)/g;
  // `pip`, `pip3`, `python -m pip` and `uv pip` all contain `pip install`.
  const PYTHON_INSTALL =
    /\bpip[\d.]*\s+(?:install|wheel|download)\b|\bpython[\d.]*\s+-m\s+build\b|\bpyproject-build\b|\bpipx\s+(?:install|run)\b|\buvx\b|\buv\s+(?:sync|build|run|add|tool)\b|\bpoetry\s+(?:install|build|add)\b/g;

  // A job without its own `permissions` inherits the workflow-level block; `write-all` grants id-token too.
  const grantsIdToken = (perms: Permissions): boolean =>
    perms === 'write-all' || (typeof perms === 'object' && perms !== null && perms['id-token'] === 'write');

  const oidcJobRuns = (source: string | OidcWorkflow): Array<{ job: string; run: string }> => {
    const workflow =
      typeof source === 'string'
        ? (yaml.load(fs.readFileSync(path.join(workflowDir, source), 'utf8')) as OidcWorkflow)
        : source;
    return Object.entries(workflow.jobs ?? {})
      .filter(([, def]) => grantsIdToken(def.permissions !== undefined ? def.permissions : workflow.permissions))
      .flatMap(([job, def]) => (def.steps ?? []).map(step => ({ job, run: executableLines(step.run ?? '') })));
  };

  const globalInstallsInOidcJobs = (source: string | OidcWorkflow): Array<{ job: string; spec: string }> =>
    oidcJobRuns(source).flatMap(({ job, run }) =>
      [...run.matchAll(GLOBAL_INSTALL)].flatMap(match =>
        match[1]
          .trim()
          .split(/\s+/)
          .filter(arg => !arg.startsWith('-'))
          .map(spec => ({ job, spec })),
      ),
    );

  const pythonInstallsInOidcJobs = (source: string | OidcWorkflow): string[] =>
    oidcJobRuns(source).flatMap(({ job, run }) => [...run.matchAll(PYTHON_INSTALL)].map(m => `${job}: ${m[0]}`));

  // Non-vacuity: the JS SDK release job installs its own npm, so the finder must see it.
  it('finds the global npm install in the JS SDK publish job', () => {
    expect(globalInstallsInOidcJobs('js-sdk-release.yml').map(entry => entry.spec)).toEqual([
      expect.stringMatching(/^npm@/),
    ]);
  });

  it('treats a job that inherits id-token: write or write-all from the workflow as able to mint', () => {
    const job = { steps: [{ run: 'npm install -g npm@latest' }] };
    expect(globalInstallsInOidcJobs({ permissions: { 'id-token': 'write' }, jobs: { publish: job } })).toHaveLength(1);
    expect(globalInstallsInOidcJobs({ permissions: 'write-all', jobs: { publish: job } })).toHaveLength(1);
    expect(globalInstallsInOidcJobs({ jobs: { publish: { ...job, permissions: 'write-all' } } })).toHaveLength(1);
    // A job-level block replaces the workflow-level one, so it can also withdraw the grant.
    expect(
      globalInstallsInOidcJobs({ permissions: 'write-all', jobs: { publish: { ...job, permissions: {} } } }),
    ).toHaveLength(0);
  });

  it.each(workflows)('%s: global installs in id-token jobs are pinned to an exact version', file => {
    const floating = globalInstallsInOidcJobs(file).filter(entry => !/@\d+\.\d+\.\d+$/.test(entry.spec));
    expect(floating).toEqual([]);
  });

  // Non-vacuity: the single-job shape the PyPI release used to have, and the Python install that
  // still exists in the release workflow, just outside the id-token job.
  it('finds pip installs and python -m build in an id-token job', () => {
    const singleJob: OidcWorkflow = {
      jobs: {
        publish: {
          permissions: { contents: 'read', 'id-token': 'write' },
          steps: [
            { run: "pip install -e '.[dev]'\npytest" },
            { run: 'python -m pip install --upgrade build\npython -m build' },
          ],
        },
      },
    };
    expect(pythonInstallsInOidcJobs(singleJob)).toEqual([
      'publish: pip install',
      'publish: pip install',
      'publish: python -m build',
    ]);
    expect(runCommandsOf('python-sdk-release.yml').join('\n')).toMatch(PYTHON_INSTALL);
  });

  it('finds the other Python installers and build frontends in an id-token job', () => {
    const commands = [
      'pipx install twine',
      'pipx run build',
      'uvx twine upload dist/*',
      'uv sync',
      'uv build',
      'uv tool install twine',
      'poetry install',
      'poetry build',
      'pyproject-build',
      'python -m pip wheel .',
    ];
    const job: OidcWorkflow = {
      jobs: { publish: { permissions: { 'id-token': 'write' }, steps: commands.map(run => ({ run })) } },
    };
    expect(pythonInstallsInOidcJobs(job)).toHaveLength(commands.length);
  });

  it.each(workflows)('%s: id-token jobs run no Python installer or build frontend', file => {
    expect(pythonInstallsInOidcJobs(file)).toEqual([]);
  });
});

/**
 * The operator-facing text around the entrypoint, the probes and the backup scripts states what they
 * do. Each of these was once true of an earlier version and outlived the change that made it false.
 */
describe('deployment docs describe what the entrypoint, probes and backup scripts do', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

  // A non-root start leaves before the re-own, so there a host chown is the fix, not a no-op.
  it('scopes "a host chown is not a fix" to the root start', () => {
    const bullet = read('docs/12-troubleshooting-faq.md')
      .split('\n')
      .find(line => line.includes('of the host directory is not a fix'));
    expect(bullet).toMatch(/root start/);
  });

  // A non-root start never re-owns what the restore writes, and a root helper pod is refused in a
  // namespace enforcing Pod Security "restricted". The helper runs as the app user, so both hold.
  it('runs the Helm restore helper as the app user, and scopes the compose re-own to the root start', () => {
    const doc = read('docs/11-operational-runbooks.md');
    const helper = doc.slice(
      doc.indexOf('  name: openwa-restore'),
      doc.indexOf('> EOF', doc.indexOf('  name: openwa-restore')),
    );
    expect(helper).toMatch(/runAsNonRoot: true/);
    expect(helper).toMatch(/runAsUser: 997/);
    expect(helper).toMatch(/fsGroup: 997/);
    expect(helper).toMatch(/seccompProfile: \{ type: RuntimeDefault \}/);
    expect(helper).toMatch(/allowPrivilegeEscalation: false/);
    expect(helper).toMatch(/capabilities: \{ drop: \[ALL\] \}/);
    const handBack = doc
      .replace(/\n> # /g, ' ')
      .split(/[.;] /)
      .find(sentence => sentence.includes('hands the restored files back'));
    expect(handBack).toMatch(/root start/);
  });

  // Session auto-start is detached: boot does not wait for it, so no probe covers it.
  it('does not claim the startupProbe covers session restore', () => {
    expect(read('docs/13-horizontal-scaling.md')).not.toMatch(/off during boot \([^)]*session/);
    expect(read('scripts/check-chart-behaviour.mjs')).not.toMatch(/sessions to restore/);
  });

  // The chart's liveness budget lives in statefulset.yaml; a copied figure goes stale.
  it('does not restate the chart liveness budget in session comments', () => {
    for (const file of ['src/modules/session/session.service.ts', 'src/modules/session/session.service.spec.ts']) {
      expect(read(file)).not.toMatch(/the chart's (?:budget )?is ~\d+s/);
    }
  });

  // The startupProbe suspends liveness until it first succeeds, so a closed port at boot meets it, not liveness.
  it('names the startupProbe as the budget a closed port at boot runs against', () => {
    for (const file of ['src/modules/session/session.service.ts', 'src/modules/session/session.service.spec.ts']) {
      const text = read(file).replace(/\n\s*\/\/ ?/g, ' ');
      expect(text).not.toMatch(/every liveness\s+probe/i);
      expect(text).not.toMatch(/the chart's liveness budget/);
      expect(text).toMatch(/the chart's startupProbe budget/);
    }
  });

  // The note is written for any archive holding engine state, including one taken with sessions stopped.
  it('words the ENGINE-STATE-NOTE as a possibility in the restore.sh header', () => {
    const phrase = 'ENGINE-STATE-NOTE (engine auth state that may have been copied while the app ran)';
    const header = read('scripts/restore.sh')
      .split('\n')
      .filter(line => line.startsWith('#'))
      .map(line => line.replace(/^#\s*/, ''))
      .join(' ');
    expect(header).toContain(phrase);
    expect(read('docs/11-operational-runbooks.md')).toContain(phrase);
  });
});

/**
 * `ghcr.io/<repo>:main` is the channel an operator pulls to track main. Two things once decided which
 * commit it pointed at: whichever push run finished its build last, even an older commit's, and a push
 * that happened before the non-root smoke test, so an image that failed the smoke had already moved it.
 * The branch tag is now a final step that runs only after the smoke passes and only while the commit is
 * still the branch head; the build itself publishes nothing but the immutable `:<sha>` tag.
 */
describe('ci.yml moves the branch image tag only for the tested branch head', () => {
  type CiStep = Step & { if?: string; id?: string };
  type CiWorkflow = {
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
    jobs?: Record<string, { steps?: CiStep[] }>;
  };
  const ci = (): CiWorkflow => workflowOf('ci.yml');
  const dockerSteps = (): CiStep[] => ci().jobs?.docker?.steps ?? [];

  it('finds the docker job and its steps', () => {
    expect(dockerSteps().length).toBeGreaterThan(3);
  });

  // One group per pull request, so a new push cancels the superseded run; one group per push run
  // (run_id), so pushes to main are never queued behind, or cancelled by, each other.
  it('cancels superseded pull request runs without grouping push runs together', () => {
    const concurrency = ci().concurrency;
    expect(concurrency?.['cancel-in-progress']).toBe(true);
    expect(concurrency?.group).toContain('github.event.pull_request.number');
    expect(concurrency?.group).toContain('github.run_id');
    // github.ref would put every push to main in one group, where a third push cancels the pending
    // run of the second and that commit never gets tests or an image.
    expect(concurrency?.group).not.toMatch(/github\.ref\b/);
  });

  it('never publishes the branch tag from the build step', () => {
    const tagRules = dockerSteps()
      .filter(step => (step.uses ?? '').startsWith('docker/metadata-action'))
      .map(step => String((step.with as { tags?: string } | undefined)?.tags ?? ''));
    expect(tagRules.length).toBe(1);
    expect(executableLines(tagRules.join('\n'))).not.toContain('type=ref,event=branch');
  });

  it('re-points the branch tag as the last step, after the smoke, on push, only at the branch head', () => {
    const steps = dockerSteps();
    const smoke = steps.findIndex(step => executableLines(step.run ?? '').includes('smoke-test-non-root.sh'));
    const retag = steps.findIndex(step => executableLines(step.run ?? '').includes('imagetools create'));
    expect(smoke).toBeGreaterThan(-1);
    expect(retag).toBeGreaterThan(smoke);
    // Last, so every check added to this job gates the branch tag, not only the non-root smoke.
    expect(retag).toBe(steps.length - 1);
    const step = steps[retag];
    expect(step.if ?? '').toContain("github.event_name == 'push'");
    const run = executableLines(step.run ?? '');
    expect(run).toMatch(/git ls-remote/);
    expect(run).toMatch(/GITHUB_SHA/);
  });
});

/**
 * A job without `timeout-minutes` runs to GitHub's 360-minute default. A hung dashboard test run once
 * held its job for half an hour and still reported green, and a stalled apt mirror held another for
 * over an hour, so every job carries its own bound: a hang turns into a prompt red job instead.
 */
describe('every workflow job declares a bounded timeout', () => {
  type TimedWorkflow = { jobs?: Record<string, { 'timeout-minutes'?: unknown }> };
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const jobs = workflows.flatMap(file =>
    Object.entries((workflowOf(file) as TimedWorkflow).jobs ?? {}).map(([job, def]) => ({
      id: `${file}:${job}`,
      timeout: def['timeout-minutes'],
    })),
  );

  it('finds the jobs of every workflow', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(30);
  });

  it('gives each job a timeout between 1 and 120 minutes', () => {
    const unbounded = jobs
      .filter(({ timeout }) => !(Number.isInteger(timeout) && (timeout as number) > 0 && (timeout as number) <= 120))
      .map(({ id, timeout }) => `${id} (${String(timeout)})`);
    expect(unbounded).toEqual([]);
  });
});

/**
 * The dashboard's unit tests stalled for half an hour on a leaked timer and still reported green,
 * because node:test waits for the event loop to drain and nothing bounded it. The per-test timeout
 * turns that into a failure naming the file; the step timeout backstops a hang the runner cannot
 * attribute to a test.
 */
describe('the dashboard unit tests are bounded', () => {
  const dashboardScripts = (): Record<string, string> =>
    (
      JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

  it('runs test:unit and test:cov with a per-test timeout, and test through test:unit', () => {
    const scripts = dashboardScripts();
    expect(scripts['test:unit']).toMatch(/--test-timeout=\d+/);
    expect(scripts['test:cov']).toMatch(/--test-timeout=\d+/);
    // --test-force-exit would hide the very leak the timeout exposes.
    expect(scripts['test:unit']).not.toContain('--test-force-exit');
    expect(scripts.test).toBe('npm run test:unit');
  });

  it.each(['ci.yml', 'release.yml'])('%s bounds the dashboard unit test step', file => {
    type TimedStep = Step & { 'timeout-minutes'?: unknown };
    const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
      jobs?: Record<string, { steps?: TimedStep[] }>;
    };
    const steps = Object.values(workflow.jobs ?? {})
      .flatMap(job => job.steps ?? [])
      .filter(step => executableLines(step.run ?? '').includes('npm run test:unit'));
    expect(steps.length).toBe(1);
    expect(steps[0]['timeout-minutes']).toEqual(expect.any(Number));
  });
});
