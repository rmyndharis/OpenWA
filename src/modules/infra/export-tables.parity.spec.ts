import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DataSource, getMetadataArgsStorage } from 'typeorm';
import { EXPORT_TABLES, EXPORT_TABLE_EXCLUSIONS } from './export-tables';
import { TABLE_IMPORTERS } from './table-importers';
import { InfraDataService } from './infra-data.service';
import { readExport } from '../../../test/helpers/read-export';

/**
 * The backup parity guard. The export registry is the one place the table set may be decided, and
 * this spec binds it to everything that must agree with it:
 *
 *   - every data-connection ENTITY table is either exported or explicitly excluded with a reason, so
 *     a new entity cannot silently miss every backup this gateway produces;
 *   - every registry table is a real data-connection entity table, so a renamed or dropped entity
 *     cannot leave a stale registry entry behind;
 *   - the export registry and the import descriptors (TABLE_IMPORTERS) cover the same tables in the
 *     same FK-safe order, so export and import cannot drift apart;
 *   - the registry keys are exactly the published response keys (openapi.json TableCountsDto /
 *     MigrationTablesDto), so a new table forces a conscious DTO + spec update rather than a silent
 *     dynamic key.
 *
 * The entity set is DISCOVERED from the filesystem rather than restated: the spec walks src for
 * *.entity.ts files, classifies each by the connection roots app.module.ts registers, and reads the
 * table names out of real TypeORM metadata. An entity file that lands anywhere else is unclassified
 * and fails the suite — a new entity always forces a backup decision here.
 */

const SRC_ROOT = join(__dirname, '..', '..');

// The data-connection entity roots, mirroring the `entities` globs of the 'data' DataSource in
// app.module.ts (and src/database/data-source.ts for the migration CLI).
const DATA_ENTITY_ROOTS = [
  'modules/session',
  'modules/webhook',
  'modules/message',
  'modules/template',
  'engine',
  'modules/integration',
  'modules/status-store',
  'modules/automation',
];
// The main-connection (auth/audit) roots; their tables are not this endpoint's payload.
const MAIN_ENTITY_ROOTS = ['modules/auth', 'modules/audit'];

type Connection = 'data' | 'main' | 'unclassified';

interface EntityFile {
  file: string;
  connection: Connection;
  tables: string[];
  /** Of those, the tables carrying an FK to sessions. */
  sessionFkTables: string[];
}

function findEntityFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      findEntityFiles(join(dir, entry.name), found);
    } else if (entry.name.endsWith('.entity.ts')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function classify(relativeToSrc: string): Connection {
  const under = (roots: string[]): boolean => roots.some(root => relativeToSrc.startsWith(`${root}/`));
  if (under(DATA_ENTITY_ROOTS)) return 'data';
  if (under(MAIN_ENTITY_ROOTS)) return 'main';
  // Not a deliberate catch-all: an unclassified file fails the suite below, and its tables are held
  // to the data-connection coverage rule in the meantime, so nothing can fall between the lists.
  return 'unclassified';
}

async function loadEntityFiles(): Promise<EntityFile[]> {
  const discovered: Array<{ file: string; classes: unknown[] }> = [];
  for (const file of findEntityFiles(SRC_ROOT)) {
    const relativePath = relative(SRC_ROOT, file).split(sep).join('/');
    const module = (await import(file)) as Record<string, unknown>;
    // Only classes the entity decorators registered; a file may export anything alongside them.
    const entityClasses = Object.values(module).filter(
      value => typeof value === 'function' && getMetadataArgsStorage().tables.some(t => t.target === value),
    );
    if (entityClasses.length === 0) continue;
    discovered.push({ file: relativePath, classes: entityClasses });
  }
  // ONE DataSource over every discovered class, mirroring the app's single connection: entity
  // relations cross files, so building metadata per file would not resolve the inverse sides.
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: discovered.flatMap(entry => entry.classes) as Array<new () => unknown>,
    synchronize: false,
  });
  await ds.initialize();
  const tableOf = new Map<unknown, string>(ds.entityMetadatas.map(metadata => [metadata.target, metadata.tableName]));
  const sessionFkTables = new Set(
    ds.entityMetadatas
      .filter(metadata => metadata.foreignKeys.some(fk => fk.referencedTablePath === 'sessions'))
      .map(metadata => metadata.tableName),
  );
  await ds.destroy();
  return discovered.map(entry => {
    const tables = entry.classes
      .map(cls => tableOf.get(cls))
      .filter((table): table is string => typeof table === 'string');
    return {
      file: entry.file,
      connection: classify(entry.file),
      tables,
      sessionFkTables: tables.filter(table => sessionFkTables.has(table)),
    };
  });
}

/** Top-level property names of a published schema, read from the committed OpenAPI contract. */
function publishedProperties(schema: string): string[] {
  const snapshot = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'openapi.json'), 'utf8')) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  return Object.keys(snapshot.components.schemas[schema]?.properties ?? {});
}

describe('export-tables registry: every data-DB entity table has a backup decision', () => {
  let entityFiles: EntityFile[];

  beforeAll(async () => {
    entityFiles = await loadEntityFiles();
  });

  it('finds the data connection non-empty (the discovery itself is not vacuous)', () => {
    expect(entityFiles.filter(f => f.connection === 'data').length).toBeGreaterThanOrEqual(14);
  });

  it('classifies every entity file under src — a new entity root must be classified here', () => {
    const unclassified = entityFiles.filter(f => f.connection === 'unclassified').map(f => f.file);
    expect(unclassified).toEqual([]);
  });

  it('exports or explicitly excludes every data-connection entity table', () => {
    const registered = new Set(EXPORT_TABLES.map(entry => entry.table));
    const excluded = new Set(Object.keys(EXPORT_TABLE_EXCLUSIONS));
    const missing: string[] = [];
    for (const file of entityFiles) {
      // 'unclassified' is asserted empty above; holding its tables to the data rule keeps a
      // mis-classified file from slipping through as neither exported nor excluded.
      if (file.connection === 'main') continue;
      for (const table of file.tables) {
        if (!registered.has(table) && !excluded.has(table)) missing.push(`${table} (${file.file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every exclusion a one-line reason naming a real data-connection table', () => {
    const dataTables = new Set(entityFiles.filter(f => f.connection !== 'main').flatMap(f => f.tables));
    for (const [table, reason] of Object.entries(EXPORT_TABLE_EXCLUSIONS)) {
      expect(dataTables.has(table)).toBe(true);
      expect(typeof reason === 'string' && reason.trim().length > 0).toBe(true);
    }
  });

  it('registers no table the entity metadata does not know (stale entry after a rename/drop)', () => {
    const dataTables = new Set(entityFiles.filter(f => f.connection === 'data').flatMap(f => f.tables));
    const stale = EXPORT_TABLES.filter(entry => !dataTables.has(entry.table)).map(entry => entry.table);
    expect(stale).toEqual([]);
  });

  it('flags exactly the tables with an FK to sessions, so the export drops their orphaned rows', () => {
    const flagged = EXPORT_TABLES.filter(entry => entry.sessionFk).map(entry => entry.table);
    const withFk = entityFiles.filter(f => f.connection === 'data').flatMap(f => f.sessionFkTables);
    expect(flagged.sort()).toEqual(withFk.sort());
    expect(flagged.length).toBeGreaterThan(0);
  });

  it('exports and imports the same tables in the same FK-safe order', () => {
    expect(EXPORT_TABLES.map(entry => entry.key)).toEqual(TABLE_IMPORTERS.map(importer => importer.key));
  });

  it('publishes exactly the registry keys in the export response DTOs', () => {
    const keys = EXPORT_TABLES.map(entry => entry.key);
    expect(publishedProperties('TableCountsDto')).toEqual(keys);
    expect(publishedProperties('MigrationTablesDto')).toEqual(keys);
  });

  it('keeps only sessions and webhooks required — every other table stays optional-but-reported', () => {
    // Required tables fail the export when absent; optional ones land in skippedTables. Flipping an
    // existing table between the two changes the observable contract and must be a conscious edit.
    expect(EXPORT_TABLES.filter(entry => !entry.optional).map(entry => entry.key)).toEqual(['sessions', 'webhooks']);
  });
});

describe('InfraDataService.exportData validates the registry against live entity metadata', () => {
  const cfg = { get: () => 'sqlite' };
  const registryTables = () => EXPORT_TABLES.map(entry => entry.table);
  const build = (ds: unknown) => new InfraDataService(cfg as never, ds as never);

  it('refuses rather than exporting empty when a registered table is unknown to the metadata', async () => {
    // A renamed entity leaves the old table name in the registry: reading it would export the stale
    // table (or report it skipped) and a restore would repopulate a table nothing reads.
    const query = jest.fn().mockResolvedValue([]);
    const ds = {
      query,
      entityMetadatas: registryTables()
        .filter(table => table !== 'messages')
        .map(tableName => ({ tableName })),
    };
    await expect(readExport(build(ds).exportData())).rejects.toThrow(/entity metadata does not know it/);
    expect(query).not.toHaveBeenCalled(); // refused BEFORE a single table was read
  });

  it('refuses when a data entity table has no backup decision at all', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const ds = {
      query,
      entityMetadatas: [...registryTables(), 'shiny_new_table'].map(tableName => ({ tableName })),
    };
    await expect(readExport(build(ds).exportData())).rejects.toThrow(/no backup decision/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the import clears every re-inserted table that DELETE FROM sessions cannot cascade', () => {
  const src = readFileSync(join(__dirname, 'infra-data.service.ts'), 'utf8');
  const sessionsDelete = src.indexOf("deleteRows('sessions')");
  // These tables carry no FK to sessions (a sessionId, where present, is provenance, not a foreign
  // key), so the import's delete of the sessions never reaches them. They are re-inserted from the
  // archive, so without an explicit clear a restore onto an instance that already holds their rows
  // collides on PK and the all-or-nothing gate rolls the whole import back (the exact restore-onto-self
  // flow). The set is derived from the registry, so a new table is covered without editing this spec.
  const uncascaded = EXPORT_TABLES.filter(entry => !entry.sessionFk && entry.table !== 'sessions').map(e => e.table);

  it('finds the sessions delete and at least one uncascaded table', () => {
    expect(sessionsDelete).toBeGreaterThan(-1);
    expect(uncascaded).toContain('lid_mappings');
  });

  it.each(uncascaded)('clears %s before the sessions delete', table => {
    const clear = src.indexOf(`clearTable('${table}')`);
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(sessionsDelete);
  });
});
