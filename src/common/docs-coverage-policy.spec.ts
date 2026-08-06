import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docs/09-testing-strategy.md` §9.5 restates the coverage floors from `package.json`, and calls that
 * file the authoritative gate. A restated table has no mechanism keeping it accurate: it was written
 * when there were eight scopes and would quietly rot now that there are more than thirty, leaving
 * contributors reading a floor the build does not enforce.
 *
 * This gate makes the two agree. It is deliberately a plain comparison of both directions — a scope
 * added to the config without the document, or left in the document after the config drops it, fails
 * here, as does any changed number.
 */
describe('docs/09 §9.5 matches the enforced coverage floors', () => {
  const METRICS = ['branches', 'functions', 'lines', 'statements'] as const;
  type Thresholds = Record<(typeof METRICS)[number], number>;

  const enforced = (): Map<string, Thresholds> => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      jest: { coverageThreshold: Record<string, Thresholds> };
    };
    return new Map(
      Object.entries(pkg.jest.coverageThreshold).map(([scope, t]) => [
        // The document names the global group "Global" and drops the leading `./` from paths.
        scope === 'global' ? 'Global' : scope.replace(/^\.\//, ''),
        t,
      ]),
    );
  };

  /** Parse the §9.5 table: `| scope | 58% | 58% | 66% | 65% |`, with paths written in backticks. */
  const documented = (): Map<string, Thresholds> => {
    const doc = readFileSync(join(__dirname, '..', '..', 'docs', '09-testing-strategy.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 9.5'), doc.indexOf('## 9.6'));
    const rows = new Map<string, Thresholds>();
    for (const line of section.split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      // A data row is `| name | n% | n% | n% | n% |` — 4 numeric cells after the name.
      if (cells.length !== 7 || !METRICS.every((_, i) => /^\d+%$/.test(cells[i + 2]))) continue;
      const name = cells[1].replace(/`/g, '');
      rows.set(name, Object.fromEntries(METRICS.map((m, i) => [m, Number.parseInt(cells[i + 2], 10)])) as Thresholds);
    }
    return rows;
  };

  it('documents every enforced scope, and only those, with the same numbers', () => {
    const actual = enforced();
    const claimed = documented();

    // Guard the parser itself: an expression that silently matched nothing would make this vacuous.
    expect(claimed.size).toBeGreaterThan(8);
    expect([...claimed.keys()].sort()).toEqual([...actual.keys()].sort());
    for (const [scope, thresholds] of actual) {
      expect({ scope, ...claimed.get(scope) }).toEqual({ scope, ...thresholds });
    }
  });
});
