// NOTE: kept OUT of src/database/migrations/ on purpose — the TypeORM migrations glob
// (`migrations/*{.ts,.js}`) would otherwise load this spec as a migration under ts-node
// (the CLI datasource / start:dev) and crash on `describe`.
import { AddSessionOwnership1785800000000 } from './migrations/1785800000000-AddSessionOwnership';
import { AddSessionNodeUrl1786000000000 } from './migrations/1786000000000-AddSessionNodeUrl';
import { AddAutomationRules1785900000000 } from './migrations/1785900000000-AddAutomationRules';

interface FakeRunner {
  connection: { options: { type: string } };
  dataSource: { options: { type: string } };
  hasColumn: jest.Mock;
  hasTable: jest.Mock;
  query: jest.Mock;
}

function makeQueryRunner(type: string, opts: { columns?: string[]; hasTable?: boolean } = {}): FakeRunner {
  const columns = opts.columns ?? [];
  return {
    connection: { options: { type } },
    dataSource: { options: { type } },
    hasColumn: jest.fn((_table: string, name: string) => Promise.resolve(columns.includes(name))),
    hasTable: jest.fn(() => Promise.resolve(opts.hasTable ?? false)),
    // The ownership migration probes columns with raw queries (information_schema / PRAGMA);
    // answer those probes from `columns` and everything else with nothing.
    query: jest.fn((sql: string) => {
      if (/information_schema\.columns/.test(sql)) {
        const name = /column_name = '([^']+)'/.exec(sql)?.[1];
        return Promise.resolve(name && columns.includes(name) ? [{ 1: 1 }] : []);
      }
      if (/PRAGMA table_info/.test(sql)) {
        return Promise.resolve(columns.map(name => ({ name })));
      }
      return Promise.resolve(undefined);
    }),
  };
}

const sqlOf = (qr: FakeRunner): string[] => qr.query.mock.calls.map(call => String((call as unknown[])[0]));
const ddlOf = (qr: FakeRunner): string[] => sqlOf(qr).filter(s => /ALTER|CREATE|DROP/.test(s));

describe('AddSessionOwnership migration', () => {
  const migration = new AddSessionOwnership1785800000000();

  it('adds the three ownership columns, nullable so existing rows read as unclaimed', async () => {
    const qr = makeQueryRunner('sqlite');
    await migration.up(qr as never);
    const ddl = ddlOf(qr).join('\n');
    expect(ddl).toMatch(/ADD COLUMN "nodeId" varchar\(190\) NULL/);
    expect(ddl).toMatch(/ADD COLUMN "claimedAt" datetime NULL/);
    expect(ddl).toMatch(/ADD COLUMN "leaseExpiresAt" datetime NULL/);
  });

  it('uses TIMESTAMP on Postgres and probes via information_schema', async () => {
    const qr = makeQueryRunner('postgres');
    await migration.up(qr as never);
    expect(ddlOf(qr).join('\n')).toMatch(/ADD COLUMN "claimedAt" TIMESTAMP NULL/);
    expect(sqlOf(qr).some(s => /information_schema\.columns/.test(s))).toBe(true);
  });

  it('is idempotent: a run interrupted between ALTERs adds only what is still missing', async () => {
    const qr = makeQueryRunner('sqlite', { columns: ['nodeId', 'claimedAt'] });
    await migration.up(qr as never);
    const ddl = ddlOf(qr).join('\n');
    expect(ddl).not.toMatch(/"nodeId"/);
    expect(ddl).toMatch(/ADD COLUMN "leaseExpiresAt"/);
  });

  it('down() drops only the columns that exist', async () => {
    const qr = makeQueryRunner('sqlite', { columns: ['nodeId', 'leaseExpiresAt'] });
    await migration.down(qr as never);
    const ddl = ddlOf(qr).join('\n');
    expect(ddl).toMatch(/DROP COLUMN "nodeId"/);
    expect(ddl).toMatch(/DROP COLUMN "leaseExpiresAt"/);
    expect(ddl).not.toMatch(/DROP COLUMN "claimedAt"/);
  });
});

describe('AddSessionNodeUrl migration', () => {
  const migration = new AddSessionNodeUrl1786000000000();

  it('adds sessions.nodeUrl once, and skips when it already exists', async () => {
    const fresh = makeQueryRunner('sqlite');
    await migration.up(fresh as never);
    expect(ddlOf(fresh).join('\n')).toMatch(/ADD COLUMN "nodeUrl" varchar\(2048\)/);

    const already = makeQueryRunner('sqlite', { columns: ['nodeUrl'] });
    await migration.up(already as never);
    expect(ddlOf(already)).toHaveLength(0);
  });

  it('down() drops the column only when present', async () => {
    const present = makeQueryRunner('sqlite', { columns: ['nodeUrl'] });
    await migration.down(present as never);
    expect(ddlOf(present).join('\n')).toMatch(/DROP COLUMN "nodeUrl"/);

    const absent = makeQueryRunner('sqlite');
    await migration.down(absent as never);
    expect(ddlOf(absent)).toHaveLength(0);
  });
});

describe('AddAutomationRules migration', () => {
  const migration = new AddAutomationRules1785900000000();

  it('creates the table with the CASCADE FK to sessions, per dialect', async () => {
    const sqlite = makeQueryRunner('sqlite');
    await migration.up(sqlite as never);
    const sqliteDdl = ddlOf(sqlite).join('\n');
    expect(sqliteDdl).toMatch(/CREATE TABLE "automation_rules"/);
    expect(sqliteDdl).toMatch(/REFERENCES "sessions" \("id"\) ON DELETE CASCADE/);
    expect(sqliteDdl).toMatch(/CREATE INDEX "IDX_automation_rules_sessionId"/);

    const pg = makeQueryRunner('postgres');
    await migration.up(pg as never);
    expect(ddlOf(pg).join('\n')).toMatch(/gen_random_uuid\(\)::varchar/);
  });

  it('is a no-op when the table already exists (synchronize-bootstrapped DB)', async () => {
    const qr = makeQueryRunner('sqlite', { hasTable: true });
    await migration.up(qr as never);
    expect(ddlOf(qr)).toHaveLength(0);
  });

  it('down() drops index and table with IF EXISTS, so a revert is idempotent', async () => {
    const qr = makeQueryRunner('sqlite');
    await migration.down(qr as never);
    const ddl = ddlOf(qr).join('\n');
    expect(ddl).toMatch(/DROP INDEX IF EXISTS "IDX_automation_rules_sessionId"/);
    expect(ddl).toMatch(/DROP TABLE IF EXISTS "automation_rules"/);
  });
});
