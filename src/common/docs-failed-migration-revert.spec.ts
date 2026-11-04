import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A failed migration is never written to the migrations table: the run executes in one transaction on
 * SQLite and PostgreSQL (TypeORM's default 'all', which neither data source overrides), so the failure
 * rolls the whole run back. `migration:revert` then undoes the newest migration that SUCCEEDED, and its
 * `down()` can delete data (AddChatStateDeletedAt's deletes the deleted-chat markers). The answers to a
 * failed migration, and the debug commands, must not hand it out as a command; a planned downgrade in
 * 14.6 and the Known Upgrade Hazards rows still use it on purpose.
 */

const root = join(__dirname, '..', '..');

describe('the failed-migration advice', () => {
  it.each([
    ['docs/08-development-guidelines.md', '#### Migration Fails', '\n### '],
    ['docs/12-troubleshooting-faq.md', '### Issue: Database Migration Failed', '\n## '],
    ['docs/14-migration-guide.md', '### Debug Commands', '\n---'],
  ])('in %s (%s) does not run migration:revert', (file, heading, endMarker) => {
    const text = readFileSync(join(root, file), 'utf8');
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(endMarker, start + heading.length);
    expect(end).toBeGreaterThan(start);
    const section = text.slice(start, end);
    // Vacuity guard: the slice is the section that shows the migration status.
    expect(section).toContain('npm run migration:show');
    expect(section).not.toMatch(/npm run migration:revert/);
  });
});
