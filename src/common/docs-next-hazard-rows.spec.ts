import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The migration guide labels an upgrade hazard of the release being prepared `next` in its Release
 * column, because the number is not known when the row is written. docs-next-version.spec.ts reads
 * semantic versions only, so a `next` row that outlives its release names no version and passes every
 * other gate, and the rows of the release after it then sit under the same label. A `next` row belongs
 * to the entries `[Unreleased]` still holds; the release steps in docs/15 15.7 rename it before the
 * release commit, which empties `[Unreleased]` and so fails here if the rename was skipped.
 */

const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

function unreleasedEntries(changelog: string): string[] {
  const start = changelog.indexOf('## [Unreleased]');
  const end = changelog.indexOf('\n## [', start + 1);
  return changelog
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter(line => line.startsWith('- '));
}

function hazardRows(guide: string): string[] {
  const table = guide.slice(guide.indexOf('### Known Upgrade Hazards'), guide.indexOf('## 14.6'));
  return table.split('\n').filter(line => /^\|\s*`[^`]+`\s*\|/.test(line));
}

describe('the upgrade hazards of the release being prepared', () => {
  it('are labelled `next` only while [Unreleased] holds entries', () => {
    const rows = hazardRows(read('docs', '14-migration-guide.md'));
    // Vacuity guard: the table still parses.
    expect(rows.length).toBeGreaterThan(10);
    const next = rows.filter(line => /^\|\s*`next`\s*\|/.test(line));
    if (unreleasedEntries(read('CHANGELOG.md')).length === 0) {
      expect(next.map(line => line.slice(0, 80))).toEqual([]);
    }
  });
});
