import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Documentation may describe the release being prepared before its tag exists, and several pages do:
 * the migration guide and the runbooks tell an operator what changes "from 0.23.6" while
 * `package.json` still carries the version before it. Nothing bound the two, so a version named in
 * prose was only ever checked by someone reading it, and a typo, or a page left behind when the
 * release number changed, would ship pointing operators at a version that never existed.
 *
 * The rule this pins is the narrow one that is always true: a version OLDER than or equal to the
 * package version is history and is not this spec's business, while a NEWER one is a forward
 * reference to the release being prepared, so there may be exactly one of them. The day the tag is
 * cut, bumping `package.json` is enough: the references become history and this spec falls silent.
 *
 * It does NOT also assert that the changelog is still open. `## [Unreleased]` is kept in the file
 * across every release, empty between them, so that assertion could never fail and only read as
 * though something were being checked.
 *
 * WHAT IT CANNOT SEE, stated rather than assumed. The docs name far more third-party versions than
 * ours, so the scan below is a heuristic with two deliberate holes:
 *
 *  - only versions sharing the package's MAJOR count. While the project is on `0.x` that is what
 *    separates our `0.23.6` from `1.34.7` (whatsapp-web.js) or `7.0.0` (Baileys). The cost is that a
 *    forward reference across a major bump is invisible, and it has to be: `1.0.0` appears about
 *    eighteen times already, as a plugin manifest version, a roadmap milestone and a spec URL.
 *  - only versions that read as prose. A version glued to a preceding operator or colon belongs to
 *    something else (`httpx>=0.25.0`, `prom/alertmanager:v0.26.0`) and is skipped, as is one inside
 *    quotes, which is a literal in an example rather than a sentence about this project.
 *
 * Both holes fail SILENT, never loud: they can let a stale reference through, and that is the right
 * direction for a gate nobody can override.
 */
const ROOT = join(__dirname, '..', '..');

/**
 * A semantic version that reads as prose: at the start of a line, or after whitespace, a backtick,
 * an opening paren, or the markdown that wraps a word (`*`, `_`, `[`), with an optional `v`.
 * Deliberately NOT after `=`, `<`, `>`, `~`, `^`, `:`, `/` or a quote, which is where a dependency
 * constraint, an image tag or a JSON literal puts one.
 */
const PROSE_SEMVER = /(?:^|[\s`(*_[])v?(\d+)\.(\d+)\.(\d+)\b/gm;

export type Semver = [number, number, number];

function isNewer(a: Semver, b: Semver): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

/**
 * Versions named in `text` that are newer than `current` and share its major, keyed by the numeric
 * form so `v0.23.6` and `0.23.6` are one entry rather than two. Exported for this file's own tests:
 * a gate that is only ever run against the live tree has no negative case.
 */
export function forwardVersionsIn(text: string, current: Semver): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PROSE_SEMVER)) {
    const version: Semver = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (version[0] !== current[0]) continue;
    if (!isNewer(version, current)) continue;
    found.add(version.join('.'));
  }
  return [...found].sort();
}

function packageVersion(): Semver {
  const raw = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const [major, minor, patch] = raw.version.split('.').map(Number);
  return [major, minor, patch];
}

/** Every doc file plus the changelog and the readme: the prose an operator reads, not the code. */
function docFiles(): string[] {
  const docsDir = join(ROOT, 'docs');
  const docs = readdirSync(docsDir)
    .filter(name => name.endsWith('.md'))
    .map(name => join(docsDir, name));
  return [...docs, join(ROOT, 'CHANGELOG.md'), join(ROOT, 'README.md')];
}

describe('forwardVersionsIn', () => {
  const current: Semver = [0, 23, 5];

  it('finds a forward reference however it is written, and counts it once', () => {
    // Including the markdown that wraps a word: emphasis and a link label are prose, and a version
    // named there is exactly the kind a release bump leaves behind.
    expect(
      forwardVersionsIn('upgrading from 0.23.6 to `0.23.6` (v0.23.6) **0.23.6** _0.23.6_ [v0.23.6](x)', current),
    ).toEqual(['0.23.6']);
  });

  it('ignores history, the current version, and anything of another major', () => {
    expect(forwardVersionsIn('0.23.4 and 0.23.5 and 1.34.7 and 7.0.0', current)).toEqual([]);
  });

  it('ignores a version that belongs to something else', () => {
    // The three shapes this tree actually contains: a dependency constraint, a container image tag,
    // and a version literal inside a JSON example.
    expect(
      forwardVersionsIn('httpx>=0.25.0,<1.0 and prom/alertmanager:v0.26.0 and "version": "0.99.0"', current),
    ).toEqual([]);
  });

  it('reports every distinct forward version, which is what the gate refuses', () => {
    expect(forwardVersionsIn('from 0.23.6 in one page and 0.24.0 in another', current)).toEqual(['0.23.6', '0.24.0']);
  });
});

describe('a version named in the docs before its tag exists', () => {
  it('is the same one everywhere', () => {
    const current = packageVersion();

    const ahead = new Map<string, string[]>();
    for (const file of docFiles()) {
      const text = readFileSync(file, 'utf8');
      // The changelog's own released headings are the history it exists to record, not forward
      // references, so only the unreleased section above them is read.
      const body = file.endsWith('CHANGELOG.md') ? text.split(/^## \[\d/m)[0] : text;
      for (const version of forwardVersionsIn(body, current)) {
        ahead.set(version, [...(ahead.get(version) ?? []), file.replace(ROOT + '/', '')]);
      }
    }

    // Named in the assertion, not just counted, so a red build says WHICH versions and WHICH pages.
    const named = [...ahead.entries()].map(([version, files]) => `${version} in ${[...new Set(files)].join(', ')}`);
    expect(named.length > 1 ? named.sort() : []).toEqual([]);
  });
});
