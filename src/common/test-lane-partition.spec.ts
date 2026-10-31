import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * The doc-lint suites live in two hand-maintained lists in package.json: the `test:docs` script
 * runs them as explicit positionals, and the jest `testPathIgnorePatterns` array keeps them out of
 * the default unit lane. Nothing else knows the lists are a pair, so a suite added to one but not
 * the other drifts silently — excluded from `jest` yet never enumerated by `test:docs`, it runs in
 * no lane at all. And a rename that only reaches one list empties that lane the same way. Only a
 * spec that reads package.json the way both lanes do can see either drift.
 */
describe('Test lane partition', () => {
  const repoRoot = join(__dirname, '..', '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: { 'test:docs'?: string; 'test:scripts'?: string };
    jest?: { testPathIgnorePatterns?: string[]; coveragePathIgnorePatterns?: string[] };
  };

  /** Every spec path the `test:docs` script names as a positional, however the flags are ordered. */
  const docLane = (): Set<string> =>
    new Set((pkg.scripts['test:docs'] ?? '').split(/\s+/).filter(token => token.endsWith('.spec.ts')));

  /** The ignore patterns with `/node_modules/` dropped — it excludes dependency code, not a lane. */
  const unitLaneExcludes = (): string[] =>
    (pkg.jest?.testPathIgnorePatterns ?? []).filter(pattern => pattern !== '/node_modules/');

  /** A spec path as the ignore patterns write it: dots escaped, anchored at the end. */
  const asPattern = (path: string): string => `${path.replace(/\./g, '\\.')}$`;

  /** An ignore pattern back as the spec path the script would name. */
  const asPath = (pattern: string): string => pattern.replace(/\\\./g, '.').replace(/\$$/, '');

  it('lists the same suites in the test:docs script and the ignore patterns', () => {
    const docs = docLane();
    const excluded = unitLaneExcludes();

    // Guard the parser: lists that scanned to nothing would make the equality below pass vacuously.
    expect(docs.size).toBeGreaterThan(20);
    expect(excluded.length).toBeGreaterThan(20);

    const onlyInScript = [...docs].filter(path => !excluded.includes(asPattern(path)));
    const onlyInIgnored = excluded.filter(pattern => !docs.has(asPath(pattern)));
    if (onlyInScript.length || onlyInIgnored.length) {
      throw new Error(
        'test:docs and testPathIgnorePatterns name different suites — a suite listed in one but ' +
          'not the other runs in no lane (the unit lane ignores it, the docs lane never invokes ' +
          'it). Add the suite to both lists in package.json. ' +
          `Only in test:docs: ${onlyInScript.join(', ') || '(none)'}. ` +
          `Only in testPathIgnorePatterns: ${onlyInIgnored.join(', ') || '(none)'}.`,
      );
    }
  });

  /**
   * `coveragePathIgnorePatterns` exists to keep the doc-lint suites out of the coverage
   * DENOMINATORS: excluded from the unit lane, they would otherwise be counted as source files with
   * 0% coverage and drag every floor down. So it has to mirror the ignore list, and it has to
   * contain nothing else.
   *
   * The second half is the one that bites. Adding a real source path here removes that code from
   * every ratio silently: the floors keep passing, on a smaller denominator, and coverage that
   * never existed reads as coverage that does. The commit that introduced the array said it was
   * "enforced by the lane-partition spec"; it never was, and this is that enforcement.
   */
  it('keeps the coverage ignore list a mirror of the test ignore list, and nothing more', () => {
    const testIgnores = pkg.jest?.testPathIgnorePatterns ?? [];
    const coverageIgnores = pkg.jest?.coveragePathIgnorePatterns ?? [];

    // Vacuity guard: two empty arrays are trivially equal.
    expect(coverageIgnores.length).toBeGreaterThan(20);

    const testSet = new Set(testIgnores);
    const coverageSet = new Set(coverageIgnores);
    expect({
      onlyInCoverage: [...coverageSet].filter(p => !testSet.has(p)),
      onlyInTest: [...testSet].filter(p => !coverageSet.has(p)),
    }).toEqual({ onlyInCoverage: [], onlyInTest: [] });

    // A pattern that is neither `/node_modules/` nor a single spec file is a source path, and a
    // source path here deletes that code from the coverage ratios.
    const notASpec = coverageIgnores.filter(p => p !== '/node_modules/' && !p.endsWith('\\.spec\\.ts$'));
    expect(notASpec).toEqual([]);
  });

  /**
   * `scripts/` has its own lane. `test:scripts` hands node:test an explicit list of positionals,
   * and jest never looks in that directory, so the two lanes cannot cover for each other: a spec
   * written under `scripts/` and left out of that string runs NOWHERE, and nothing fails to say so.
   *
   * Unlike the doc lane above there is no second list to compare against, so the comparison is
   * against the directory itself. That also catches the reverse, a renamed or deleted spec still
   * named by the script, which makes the whole node:test invocation exit non-zero on a file it
   * cannot open.
   */
  it('runs every spec under scripts/ in the test:scripts lane', () => {
    const isSpec = (name: string): boolean => name.endsWith('.spec.js') || name.endsWith('.spec.mjs');
    const onDisk = readdirSync(join(repoRoot, 'scripts'))
      .filter(isSpec)
      .map(name => `scripts/${name}`);
    const named = (pkg.scripts['test:scripts'] ?? '').split(/\s+/).filter(isSpec);

    // Vacuity guard: an empty directory scan or an unparsed script would pass the diff below.
    expect(onDisk.length).toBeGreaterThan(10);
    expect(named.length).toBeGreaterThan(10);

    expect({
      neverRun: onDisk.filter(path => !named.includes(path)).sort(),
      namedButAbsent: named.filter(path => !onDisk.includes(path)).sort(),
    }).toEqual({ neverRun: [], namedButAbsent: [] });
  });

  /**
   * The PostgreSQL specs self-skip unless DATABASE_TYPE=postgres, so the unit lane reports one as
   * skipped, which is green. The only lane that sets it is the `test-postgres` job, and that job
   * names its specs inline. jest reads those positionals as OR'd regex filters, so a stale name
   * matches nothing and still exits 0, and a new spec left off the list runs nowhere. Diff each
   * workflow's list against the files on disk.
   */
  /** Every `*.spec.ts` path the workflow's `test-postgres` job names on a run line. */
  const postgresJobSpecs = (file: string): string[] => {
    const workflow = yaml.load(readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8')) as {
      jobs?: Record<string, { steps?: { run?: string }[] }>;
    };
    return (workflow.jobs?.['test-postgres']?.steps ?? [])
      .flatMap(step => (step.run ?? '').split(/\s+/))
      .filter(token => token.endsWith('.spec.ts'));
  };

  it.each(['ci.yml', 'release.yml'])('runs every *.pg.spec.ts in the %s test-postgres job', file => {
    const isPgSpec = (path: string): boolean => path.endsWith('.pg.spec.ts');
    const onDisk = (readdirSync(join(repoRoot, 'src'), { recursive: true }) as string[])
      .filter(isPgSpec)
      .map(path => `src/${path.split('\\').join('/')}`);
    const named = postgresJobSpecs(file).filter(isPgSpec);

    // Vacuity guard: a scan or a parse that found nothing would pass the diff below.
    expect(onDisk.length).toBeGreaterThanOrEqual(5);
    expect(named.length).toBeGreaterThanOrEqual(5);

    expect({
      neverRun: onDisk.filter(path => !named.includes(path)).sort(),
      namedButAbsent: named.filter(path => !onDisk.includes(path)).sort(),
    }).toEqual({ neverRun: [], namedButAbsent: [] });
  });

  /**
   * A spec that picks its dialect from DATABASE_TYPE is not a `*.pg.spec.ts`, so the scan above never
   * sees it, yet its PostgreSQL half runs only in this job. Dropping it from both workflows at once
   * leaves release-gate-parity green (the two still agree) and the scenarios silently SQLite-only. A
   * hand-kept list cannot see a spec nobody added to it, so the list is every plain spec on disk that
   * compares DATABASE_TYPE with postgres (`===`, `!==`, or the loose forms). A spec that reads the variable
   * into another name first is not seen; compare it in place.
   */
  const dialectSwitchedSpecs = (): string[] =>
    (readdirSync(join(repoRoot, 'src'), { recursive: true }) as string[])
      .map(path => `src/${path.split('\\').join('/')}`)
      .filter(path => path.endsWith('.spec.ts') && !path.endsWith('.pg.spec.ts'))
      .filter(path => /DATABASE_TYPE\s*[!=]==?\s*['"]postgres['"]/.test(readFileSync(join(repoRoot, path), 'utf8')))
      .sort();

  it.each(['ci.yml', 'release.yml'])('runs the dialect-switched specs in the %s test-postgres job', file => {
    const onDisk = dialectSwitchedSpecs();
    const named = postgresJobSpecs(file).filter(path => !path.endsWith('.pg.spec.ts'));

    // Vacuity guard: the scan must find the twelve specs that switch today.
    expect(onDisk.length).toBeGreaterThanOrEqual(12);
    expect({
      neverRun: onDisk.filter(path => !named.includes(path)),
      unlisted: named.filter(path => !onDisk.includes(path)).sort(),
    }).toEqual({ neverRun: [], unlisted: [] });
  });

  it('names suites that exist on disk', () => {
    const paths = [...new Set([...docLane(), ...unitLaneExcludes().map(asPath)])];
    expect(paths.length).toBeGreaterThan(20);

    // A renamed spec leaves a stale entry in whichever list was not updated — and an empty lane.
    const missing = paths.filter(path => !existsSync(join(repoRoot, path)));
    expect(missing).toEqual([]);
  });
});
