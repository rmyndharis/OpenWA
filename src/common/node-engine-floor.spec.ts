import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `engines.node` is the only minimum a from-source install is told about, so it must not sit below
 * the floor of a package the lockfile installs: on such a Node, `npm ci` warns (or fails under
 * engine-strict) and the dependency may use an API the runtime lacks. The check reads only plain
 * `>=X.Y.Z` floors, the shape that actually raises the minimum; a `||` range already admits several
 * majors and is left to npm. Optional platform binaries are skipped, as npm skips them.
 */
describe('package.json engines.node covers every installed package floor', () => {
  const repo = join(__dirname, '..', '..');
  const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(repo, file), 'utf8')) as T;

  type Version = [number, number, number];
  const parse = (text: string): Version => {
    const [major = 0, minor = 0, patch = 0] = text.split('.').map(part => Number.parseInt(part, 10) || 0);
    return [major, minor, patch];
  };
  const below = (a: Version, b: Version): boolean => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const floorOf = (range: string): Version | null => {
    const match = /^\s*>=\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(range);
    return match ? parse(match[1]) : null;
  };

  const unmetFloors = (declared: string, packages: Record<string, { optional?: boolean; engines?: unknown }>) => {
    const own = floorOf(declared);
    if (!own) throw new Error(`engines.node must be a plain >= floor, got "${declared}"`);
    const unmet: string[] = [];
    for (const [path, meta] of Object.entries(packages)) {
      if (!path || meta.optional) continue;
      const range = (meta.engines as { node?: string } | undefined)?.node;
      const floor = typeof range === 'string' ? floorOf(range) : null;
      if (floor && below(own, floor)) unmet.push(`${path.replace(/^.*node_modules\//, '')} ${range}`);
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
      'node_modules/bin': { optional: true, engines: { node: '>=99' } },
    };
    expect(unmetFloors('>=22.13', packages)).toEqual(['high >=22.19.0']);
    expect(unmetFloors('>=22.19', packages)).toEqual([]);
  });
});
