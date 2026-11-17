import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

/**
 * A Baileys chat deleted on the phone or through the API keeps its `chat_states` row with `deletedAt` set
 * (AddChatStateDeletedAt1791700000000). The release before it lists every `chat_states` row as an existing
 * chat, so an image-only rollback (or `helm rollback`, which keeps the volume) lists every chat deleted
 * since the upgrade again. `migration:revert:prod`, run with the newer image before the swap, undoes the
 * newest migration each time, so the guide has it repeated until `migration:show:prod` lists that migration
 * as pending: its `down()` deletes those rows and drops the column. The guide states no number of runs,
 * because every migration added after it adds one. It lists the hazard with the other rollback hazards, in
 * whichever release row it ends up.
 */

const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
const migrationsDir = join(root, 'src', 'database', 'migrations');
const MARKER_MIGRATION_FILE = /^(\d+)-AddChatStateDeletedAt\.ts$/;

/** The name `migration:show` prints for the migration that adds `chat_states.deletedAt`. */
function markerMigrationName(): string {
  const file = readdirSync(migrationsDir).find(name => MARKER_MIGRATION_FILE.test(name));
  if (file === undefined) throw new Error('the migration that adds chat_states.deletedAt is gone');
  return `AddChatStateDeletedAt${MARKER_MIGRATION_FILE.exec(file)![1]}`;
}

function importMigrations(): unknown[] {
  return readdirSync(migrationsDir)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .sort()
    .map(file => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(join(migrationsDir, file)) as Record<string, unknown>;
      return Object.values(mod).find(
        (value): value is new () => unknown =>
          typeof value === 'function' && (value as { prototype?: { up?: unknown } }).prototype?.up !== undefined,
      );
    });
}

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

  // `migration:revert` undoes the newest migration only, so a fixed count of runs is true until the next
  // migration is added: the row names the migration and the state to stop at instead.
  it('has the revert repeated until the migration that adds the marker is pending, with no fixed count', () => {
    const guide = read('docs/14-migration-guide.md');
    const table = guide.slice(guide.indexOf('### Known Upgrade Hazards'), guide.indexOf('## 14.6'));
    const [row] = table
      .split('\n')
      .filter(line => line.startsWith('| `') && ROLLBACK.test(line) && DELETED_CHAT.test(line));
    expect(row).toContain(markerMigrationName());
    expect(row).toMatch(
      /migration:revert:prod`[^|]*, until `npm run migration:show:prod` lists that migration as pending/,
    );
    expect(row).not.toMatch(/\b(once|twice|one time|two times|\d+ times)\b/i);
  });

  it('removes the marked rows and the column when the revert is repeated until the migration is pending', async () => {
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      migrations: importMigrations() as never,
    });
    await ds.initialize();
    try {
      await ds.runMigrations({ transaction: 'all' });
      await ds.query(
        `INSERT INTO "chat_states" ("sessionId", "chatId", "deletedAt") VALUES ('s1', '628111@s.whatsapp.net', 1790000000000)`,
      );
      await ds.query(`INSERT INTO "chat_states" ("sessionId", "chatId") VALUES ('s1', '628222@s.whatsapp.net')`);

      const executed = async (): Promise<string[]> =>
        (await ds.query<{ name: string }[]>(`SELECT "name" FROM "migrations"`)).map(migration => migration.name);
      const name = markerMigrationName();
      expect(await executed()).toContain(name);
      // A bound well above the chain's length keeps a revert that never reaches it from looping forever.
      for (let runs = 0; (await executed()).includes(name); runs++) {
        expect(runs).toBeLessThan(200);
        await ds.undoLastMigration({ transaction: 'all' });
      }

      const runner = ds.createQueryRunner();
      try {
        expect(await runner.hasColumn('chat_states', 'deletedAt')).toBe(false);
        expect(await runner.query(`SELECT "chatId" FROM "chat_states"`)).toEqual([{ chatId: '628222@s.whatsapp.net' }]);
      } finally {
        await runner.release();
      }
    } finally {
      await ds.destroy();
    }
  }, 60_000);

  it('has an Upgrade note that says how to keep deleted Baileys chats deleted when rolling back', () => {
    const notes = upgradeNotes(read('CHANGELOG.md')).filter(line => ROLLBACK.test(line) && DELETED_CHAT.test(line));
    expect(notes).not.toEqual([]);
    expect(notes.some(line => line.includes('migration:revert'))).toBe(true);
  });
});
