import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `engines.node` is the only minimum a from-source install is told about, so it must not sit below
 * the floor of a package the lockfile installs: on such a Node, `npm ci` warns (or fails under
 * engine-strict) and the dependency may use an API the runtime lacks. Each package range is checked
 * against the declared floor itself, so a `||` range that skips the declared major (`^20 || >=24`
 * under `>=22`) is caught too. Optional platform binaries are skipped, as npm skips them.
 */
describe('package.json engines.node covers every installed package floor', () => {
  const repo = join(__dirname, '..', '..');
  const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(repo, file), 'utf8')) as T;
  // Hoisted by the lockfile (bullmq, sharp and ts-jest depend on it); it ships no types of its own.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const semver = require('semver') as {
    minVersion(range: string): { version: string; major: number } | null;
    satisfies(version: string, range: string): boolean;
  };

  const unmetFloors = (declared: string, packages: Record<string, { optional?: boolean; engines?: unknown }>) => {
    const own = /^\s*>=\s*v?\d+(?:\.\d+){0,2}\s*$/.test(declared) ? semver.minVersion(declared) : null;
    if (!own) throw new Error(`engines.node must be a plain >= floor, got "${declared}"`);
    const unmet: string[] = [];
    for (const [path, meta] of Object.entries(packages)) {
      if (!path || meta.optional) continue;
      const range = (meta.engines as { node?: string } | undefined)?.node;
      if (typeof range === 'string' && !semver.satisfies(own.version, range)) {
        unmet.push(`${path.replace(/^.*node_modules\//, '')} ${range}`);
      }
    }
    return unmet.sort();
  };

  it('is not below any non-optional package in package-lock.json', () => {
    const pkg = readJson<{ engines: { node: string } }>('package.json');
    const lock = readJson<{ packages: Record<string, { optional?: boolean; engines?: unknown }> }>('package-lock.json');

    // Guard the scan: a lockfile read that found no floors would pass vacuously.
    const floors = Object.values(lock.packages).filter(
      meta => typeof (meta.engines as { node?: unknown } | undefined)?.node === 'string',
    );
    expect(floors.length).toBeGreaterThan(50);
    expect(lock.packages[''].engines).toEqual(pkg.engines);

    expect(unmetFloors(pkg.engines.node, lock.packages)).toEqual([]);
  });

  it('names a package whose floor is above the declared one', () => {
    const packages = {
      '': {},
      'node_modules/high': { engines: { node: '>=22.19.0' } },
      'node_modules/multi': { engines: { node: '^20.19.0 || >=24' } },
      'node_modules/covered': { engines: { node: '^20.19.0 || >=22.12.0' } },
      'node_modules/any': { engines: { node: '*' } },
      'node_modules/bin': { optional: true, engines: { node: '>=99' } },
    };
    expect(unmetFloors('>=22.13', packages)).toEqual(['high >=22.19.0', 'multi ^20.19.0 || >=24']);
    expect(unmetFloors('>=22.19', packages)).toEqual(['multi ^20.19.0 || >=24']);
    expect(unmetFloors('>=24', packages)).toEqual([]);
  });

  // The SDK's engines floor (>=18) covers the published package only; its test toolchain needs more,
  // so every place that tells a contributor which Node runs those tests must state a floor that the
  // SDK lockfile actually supports.
  it.each([
    'docs/09-testing-strategy.md',
    'docs/18-sdk-design.md',
    '.github/workflows/sdk-ci.yml',
    'sdk/javascript/scripts/smoke.mjs',
  ])('%s states an SDK test floor every locked SDK package supports', file => {
    const lock = readJson<{ packages: Record<string, { optional?: boolean; engines?: unknown }> }>(
      'sdk/javascript/package-lock.json',
    );
    // Join wrapped comment lines so a floor split across two of them is still read.
    const text = readFileSync(join(repo, file), 'utf8').replace(/\s*\n\s*(?:#|\/\/)?\s*/g, ' ');
    const statements = [...text.matchAll(/needs? Node (\d+(?:\.\d+){0,2})\+(?: or (\d+(?:\.\d+){0,2})\+)?/g)];
    expect(statements.length).toBeGreaterThan(0);
    // Guard the scan: the published floor is below the toolchain's, so a scan that read no ranges fails here.
    expect(unmetFloors('>=18', lock.packages)).not.toEqual([]);
    // "20.19+ or 22.12+" admits 20.19 on the 20 line and 22.12 on the 22 line, and every later line from
    // its first release, so the lowest release each statement admits is checked on every LTS (even) line
    // through two past the last one it names: a bare "20.19+" answers for 22.0 too.
    const lowest = statements.flatMap(([statement, ...floors]) => {
      const named = floors.filter(Boolean).map(floor => semver.minVersion(floor)!);
      const last = named[named.length - 1].major;
      const lines: [string, string][] = [];
      for (let major = named[0].major; major <= last + 2; major += 2) {
        const version = named.find(v => v.major === major)?.version ?? (major > last ? `${major}.0.0` : undefined);
        if (version) lines.push([statement, version]);
      }
      return lines;
    });
    expect(
      lowest.map(([statement, version]) => [statement, version, unmetFloors(`>=${version}`, lock.packages)]),
    ).toEqual(lowest.map(([statement, version]) => [statement, version, []]));
  });
});
