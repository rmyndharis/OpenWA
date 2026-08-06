import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

/**
 * `docs/05-database-design.md` documents the schema in SQL. Nothing kept it honest, and it drifted:
 * every table but `message_batches` was written in snake_case while the real columns are camelCase,
 * so SQL copied out of the document referenced columns that do not exist. That is not a cosmetic
 * documentation bug — it produced a real one in the send-pacing cold-reachout query, which passed
 * every mocked test and would have thrown on the first cold send.
 *
 * This gate closes the loop: it builds the real schema from the entities, then checks every column
 * name the document's `CREATE TABLE` blocks claim against it. A renamed or removed column now fails
 * here instead of in production, and a new column documented with a guessed name fails immediately.
 *
 * Scope is deliberately names-only. Types in the document are illustrative and dialect-portable by
 * design (`jsonColumnType()`, `DateTransformer`), so asserting them would fail for the wrong reason.
 */
describe('docs/05 documents the real column names', () => {
  const DOC = join(__dirname, '..', '..', 'docs', '05-database-design.md');
  const entities = (dir: string): string => join(__dirname, '..', dir, '**', '*.entity.ts');

  const DATA_ENTITIES = [
    'modules/session',
    'modules/webhook',
    'modules/message',
    'modules/template',
    'modules/automation',
    'engine',
    'modules/integration',
    'modules/status-store',
  ].map(entities);
  const MAIN_ENTITIES = ['modules/auth', 'modules/audit'].map(entities);

  /** table -> real column names, built by letting TypeORM create the schema it actually uses. */
  const realSchema = async (globs: string[]): Promise<Map<string, Set<string>>> => {
    const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: globs, synchronize: true });
    await ds.initialize();
    try {
      return new Map(
        ds.entityMetadatas.map(meta => [meta.tableName, new Set(meta.columns.map(column => column.databaseName))]),
      );
    } finally {
      await ds.destroy();
    }
  };

  /**
   * Column names out of each ```sql CREATE TABLE <name> ( … )``` block in the document.
   *
   * A column line is `<name> <TYPE> …`, where the name may be quoted. Lines that open with a SQL
   * keyword (CONSTRAINT, PRIMARY, UNIQUE, …) are definitions rather than columns and are skipped.
   */
  const documentedColumns = (): Map<string, string[]> => {
    const markdown = readFileSync(DOC, 'utf8');
    const tables = new Map<string, string[]>();
    const blocks = markdown.matchAll(/CREATE TABLE\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/g);
    for (const [, table, body] of blocks) {
      const columns: string[] = [];
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim().replace(/--.*$/, '').trim();
        if (!line) continue;
        const match = line.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?\s+\S/);
        if (!match) continue;
        if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|INDEX|KEY)$/i.test(match[1])) continue;
        columns.push(match[1]);
      }
      tables.set(table, columns);
    }
    return tables;
  };

  it('every column named in a CREATE TABLE block exists on the entity', async () => {
    const [data, main] = await Promise.all([realSchema(DATA_ENTITIES), realSchema(MAIN_ENTITIES)]);
    const schema = new Map([...data, ...main]);
    const documented = documentedColumns();

    // If the parser stops matching the document's formatting it would silently assert nothing, so
    // pin that it still finds the tables — an empty result must fail, not pass.
    expect(documented.size).toBeGreaterThanOrEqual(6);

    const wrong: string[] = [];
    for (const [table, columns] of documented) {
      const real = schema.get(table);
      if (!real) {
        wrong.push(`${table}: documented but no entity declares this table`);
        continue;
      }
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        if (!real.has(column)) {
          wrong.push(`${table}.${column} does not exist (real columns: ${[...real].join(', ')})`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  // The trap that caused the original bug: one table's columns really are snake_case, so a reader
  // cannot generalise from any other table. If that ever stops being true the warning must go.
  it('message_batches is still the lone snake_case table the naming note calls out', async () => {
    const data = await realSchema(DATA_ENTITIES);
    const snakeCased = [...data]
      .filter(([, columns]) => [...columns].some(column => column.includes('_')))
      .map(([table]) => table);

    expect(snakeCased).toEqual(['message_batches']);
    expect(readFileSync(DOC, 'utf8')).toContain('The exception is **`message_batches`**');
  });
});
