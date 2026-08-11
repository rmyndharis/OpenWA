import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
