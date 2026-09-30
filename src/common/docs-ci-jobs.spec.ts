import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * `docs/09-testing-strategy.md` §9.6 restates the jobs in `.github/workflows/ci.yml` so a contributor
 * can read which gates must pass. Nothing bound the two, so the table rotted: three commits on a single
 * day added a job, added a lint step and widened a shellcheck scope, and none of them touched `docs/`.
 * The table stayed green while describing CI that no longer existed.
 *
 * This gate compares the two directly. A job added to the workflow without a row, a row left behind
 * after the workflow drops the job, a reordering, or a `build` dependency list that no longer matches
 * `needs:` all fail here.
 */
describe('docs/09 §9.6 matches the CI workflow', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  const workflow = (): string => {
    const yaml = read('.github', 'workflows', 'ci.yml');
    return yaml.slice(yaml.indexOf('\njobs:\n'));
  };

  /** Top-level job ids, in declaration order: two-space-indented keys under `jobs:`. */
  const declaredJobs = (): string[] => [...workflow().matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(match => match[1]);

  /** The `needs:` list of one job, as written. */
  const needsOf = (job: string): string[] => {
    const jobs = workflow();
    const header = `\n  ${job}:\n`;
    // Start past the job's own header line, or the search for the next job would match it at index 0.
    const rest = jobs.slice(jobs.indexOf(header) + header.length);
    const end = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m);
    const block = end === -1 ? rest : rest.slice(0, end);
    const needs = block.match(/^ {4}needs: \[([^\]]+)\]$/m);
    return needs ? needs[1].split(',').map(id => id.trim()) : [];
  };

  /** Parse the §9.6 table: `| \`job\` | prose |`, job ids backticked in the first column. */
  const section = (): string => {
    const doc = read('docs', '09-testing-strategy.md');
    return doc.slice(doc.indexOf('## 9.6'), doc.indexOf('## 9.7'));
  };

  const documentedRows = (): Map<string, string> => {
    const rows = new Map<string, string>();
    for (const line of section().split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      // A data row is `| `id` | checks |` — exactly two cells, the first a backticked id.
      if (cells.length !== 4) continue;
      const id = cells[1].match(/^`([a-z][a-z0-9-]*)`$/);
      if (id) rows.set(id[1], cells[2]);
    }
    return rows;
  };

  it('lists every workflow job, only those, in declaration order', () => {
    const declared = declaredJobs();
    const documented = [...documentedRows().keys()];

    // Guard both parsers: either one silently matching nothing would make this pass vacuously.
    expect(declared.length).toBeGreaterThan(5);
    expect(documented.length).toBeGreaterThan(5);
    expect(documented).toEqual(declared);
  });

  it("states the build job's full dependency list", () => {
    const row = documentedRows().get('build');
    expect(row).toBeDefined();

    // The row reads `... after a/b/c jobs pass`; compare token-for-token, so a merely
    // overlapping list — one id short, or naming `test-postgres` where `needs` says `test` — fails.
    const listed = row?.match(/after ([a-z0-9/-]+) jobs pass/);
    expect(listed).not.toBeNull();
    expect(listed?.[1].split('/')).toEqual(needsOf('build'));
  });
});

/**
 * `docs/10` §10.3 lists what the Scheduled Security Scan runs. A job added to that workflow can turn
 * the weekly run red, so a reader who meets the failure must find the job named there.
 */
describe('docs/10 names every Scheduled Security Scan job', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  it('mentions each job id in backticks', () => {
    const yaml = read('.github', 'workflows', 'security-scan.yml');
    const jobs = [...yaml.slice(yaml.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(m => m[1]);
    const doc = read('docs', '10-devops-infrastructure.md');
    const paragraph = doc.slice(doc.indexOf('`.github/workflows/security-scan.yml`'), doc.indexOf('## 10.4'));

    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.filter(job => !paragraph.includes(`\`${job}\``))).toEqual([]);
  });
});

/**
 * docs/04 and docs/16 describe `base-image-drift` in prose. It fails on either of two conditions, and
 * the docs/16 policy table lists what the weekly run checks, so a reader who meets a red run must find
 * both the job and the condition that tripped it.
 */
describe('docs/04 and docs/16 describe the base-image-drift job in full', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  it.each(['04-security-design.md', '16-risk-management.md'])('%s gives both failure conditions', file => {
    const lines = read('docs', file)
      .split('\n')
      .filter(line => line.includes('`base-image-drift`'));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/FROM digests disagree/);
      expect(line).toMatch(
        /served that image for 7 or more days, or for 3 or more days with the pin last changed 28 or more days ago/,
      );
    }
  });

  it('lists the drift check in the docs/16 policy table row', () => {
    const row = read('docs', '16-risk-management.md')
      .split('\n')
      .find(line => line.startsWith('| Scheduled Security Scan'));

    expect(row).toMatch(/base-image drift/);
  });
});

/**
 * The drift step runs against stubbed `docker` and `git`, so its grace can be checked without a
 * registry. node:22-slim can sit unchanged for weeks, so an old pin says nothing on its own: the run
 * must wait until the tag has served the new image long enough for a Monday Dependabot run to see it.
 */
describe('base-image-drift grace', () => {
  const PIN = 'a'.repeat(64);
  const LIVE = 'b'.repeat(64);
  const DAY = 86400;

  // The step reads the image build time with real jq; without it every run takes the "could not
  // read" branch and the failing cases report a bare status mismatch. Fail by name instead of skipping.
  beforeAll(() => {
    if (spawnSync('jq', ['--version']).status !== 0) {
      throw new Error('jq is required: the base-image-drift step parses the image build time with it');
    }
  });

  const script = (): string => {
    const doc = yaml.load(
      readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'security-scan.yml'), 'utf8'),
    ) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const step = doc.jobs['base-image-drift'].steps.find(
      s => s.name === 'Compare the Dockerfile pin with node:22-slim',
    );
    if (!step?.run) throw new Error('drift step not found');
    return step.run;
  };

  const run = (opts: {
    live: string;
    liveDays: number | null;
    pinDays: number;
  }): { status: number | null; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const now = Math.floor(Date.now() / 1000);
      const image =
        opts.liveDays === null
          ? '{}'
          : JSON.stringify({
              'linux/amd64': {
                created: new Date((now - opts.liveDays * DAY) * 1000).toISOString().replace('Z', '123456Z'),
              },
            });
      writeFileSync(
        join(dir, 'Dockerfile'),
        `FROM docker.io/node:22-slim@sha256:${PIN} AS builder\nFROM docker.io/node:22-slim@sha256:${PIN}\n`,
      );
      const stubs: Record<string, string> = {
        docker: `case "$*" in *Manifest.Digest*) echo sha256:${opts.live} ;; *) echo '${image}' ;; esac`,
        git: `echo ${now - opts.pinDays * DAY}`,
      };
      for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      const res = spawnSync('bash', ['-e', '-c', script()], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      return { status: res.status, out: res.stdout + res.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('passes when the pin matches the tag', () => {
    expect(run({ live: PIN, liveDays: 0, pinDays: 90 }).status).toBe(0);
  });

  it('passes when an old pin meets a tag that moved yesterday', () => {
    const res = run({ live: LIVE, liveDays: 1, pinDays: 21 });
    expect(res.status).toBe(0);
    expect(res.out).toContain('::notice::');
  });

  it('fails once the tag has served the new image for a week', () => {
    const res = run({ live: LIVE, liveDays: 8, pinDays: 21 });
    expect(res.status).toBe(1);
    expect(res.out).toContain('::error file=Dockerfile::');
  });

  it('fails a pin 28 or more days old once the tag has served the new image for 3 days', () => {
    expect(run({ live: LIVE, liveDays: 3, pinDays: 30 }).status).toBe(1);
  });

  // The pin's age counts from when it was set, not from when it went stale: a tag quiet for a month
  // that moved yesterday must still wait for the Monday Dependabot run.
  it('passes the first move after a quiet month until a Dependabot run has seen it', () => {
    const res = run({ live: LIVE, liveDays: 1, pinDays: 30 });
    expect(res.status).toBe(0);
    expect(res.out).toContain('::notice::');
  });

  it('skips the run when the build time of the live image cannot be read', () => {
    const res = run({ live: LIVE, liveDays: null, pinDays: 21 });
    expect(res.status).toBe(0);
    expect(res.out).toContain('::warning::');
  });
});
