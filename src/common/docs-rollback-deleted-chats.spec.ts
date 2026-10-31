import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Baileys chat deleted on the phone or through the API keeps its `chat_states` row with `deletedAt` set
 * (AddChatStateDeletedAt1791700000000). The release before it lists every `chat_states` row as an existing
 * chat, so an image-only rollback (or `helm rollback`, which keeps the volume) lists every chat deleted
 * since the upgrade again. `migration:revert:prod`, run once with the newer image before the swap, runs
 * the migration's `down()`, which deletes those rows and drops the column. The migration guide lists the
 * hazard with the other rollback hazards, in whichever release row it ends up.
 */

const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

const ROLLBACK = /roll(ing)? ?back/i;
const DELETED_CHAT = /delet\w* .*chat|chat.*delet/i;

/** Every bullet of every `### Upgrade notes` heading in the file, of any release section. */
function upgradeNotes(changelog: string): string[] {
  return changelog.split(/^(?=## \[)/m).flatMap(block => {
    const start = block.indexOf('### Upgrade notes');
    if (start < 0) return [];
    const rest = block.slice(start);
    const end = rest.indexOf('\n### ', 1);
    return rest
      .slice(0, end < 0 ? undefined : end)
      .split('\n')
      .filter(line => line.startsWith('- '));
  });
}

describe('a rollback after the chat deletion marker', () => {
  it('lists the hazard in the migration guide next to the other rollback hazards', () => {
    const guide = read('docs/14-migration-guide.md');
    const table = guide.slice(guide.indexOf('### Known Upgrade Hazards'), guide.indexOf('## 14.6'));
    const rows = table
      .split('\n')
      .filter(line => line.startsWith('| `') && ROLLBACK.test(line) && DELETED_CHAT.test(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('migration:revert:prod');
  });

  it('has an Upgrade note that says how to keep deleted Baileys chats deleted when rolling back', () => {
    const notes = upgradeNotes(read('CHANGELOG.md')).filter(line => ROLLBACK.test(line) && DELETED_CHAT.test(line));
    expect(notes).not.toEqual([]);
    expect(notes.some(line => line.includes('migration:revert'))).toBe(true);
  });
});
