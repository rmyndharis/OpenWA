import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * docs/04 section 4.13 restates the root npm entry of `.github/dependabot.yml` by hand, ignores
 * included, and its prose says which ignore freezes a major line and which freezes the line in use.
 * The copy has to list the ignores the file has, with the same version ranges.
 */

const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

type Ignore = { 'dependency-name': string; versions?: string[] };
type Update = { 'package-ecosystem': string; directory: string; ignore?: Ignore[] };

function rootNpmIgnores(text: string): Ignore[] | undefined {
  const updates = (yaml.load(text) as { updates: Update[] }).updates;
  return updates.find(u => u['package-ecosystem'] === 'npm' && u.directory === '/')?.ignore;
}

describe('docs/04 Dependabot excerpt', () => {
  it('lists the same root npm ignores, with the same version ranges, as .github/dependabot.yml', () => {
    const doc = read('docs', '04-security-design.md');
    const start = doc.indexOf('# .github/dependabot.yml');
    expect(start).toBeGreaterThanOrEqual(0);
    const excerpt = doc.slice(start, doc.indexOf('\n```', start));
    const actual = rootNpmIgnores(read('.github', 'dependabot.yml'));
    // Vacuity guard: both parse to a non-empty list.
    expect(actual?.length).toBeGreaterThan(3);
    expect(rootNpmIgnores(excerpt)).toEqual(actual);
  });
});
