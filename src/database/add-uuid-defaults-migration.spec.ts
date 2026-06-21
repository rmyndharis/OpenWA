// NOTE: kept OUT of src/database/migrations/ on purpose — the TypeORM migrations glob
// (`migrations/*{.ts,.js}`) would otherwise load this spec as a migration under ts-node
// (the CLI datasource / start:dev) and crash on `describe`.
import { QueryRunner } from 'typeorm';
import { AddUuidDefaultsForPostgres1779235200000 } from './migrations/1779235200000-AddUuidDefaultsForPostgres';

const ALL_TABLES = ['sessions', 'webhooks', 'messages', 'message_batches'];

function makeQueryRunner(type: string, existingTables: Set<string>) {
  return {
    connection: { options: { type } },
    hasTable: jest.fn((t: string) => Promise.resolve(existingTables.has(t))),
    query: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AddUuidDefaultsForPostgres migration', () => {
  const migration = new AddUuidDefaultsForPostgres1779235200000();

  it('is a no-op on SQLite — issues no query and never probes tables', async () => {
    const qr = makeQueryRunner('sqlite', new Set(ALL_TABLES));
    await migration.up(qr as unknown as QueryRunner);
    await migration.down(qr as unknown as QueryRunner);
    expect(qr.query).not.toHaveBeenCalled();
    expect(qr.hasTable).not.toHaveBeenCalled();
  });

  it('on Postgres up() sets a uuid DEFAULT on every existing table', async () => {
    const qr = makeQueryRunner('postgres', new Set(ALL_TABLES));
    await migration.up(qr as unknown as QueryRunner);

    expect(qr.query).toHaveBeenCalledTimes(ALL_TABLES.length);
    expect(qr.query).toHaveBeenCalledWith(
      'ALTER TABLE "sessions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar',
    );
  });

  it('skips tables that do not exist', async () => {
    const qr = makeQueryRunner('postgres', new Set(['sessions', 'messages']));
    await migration.up(qr as unknown as QueryRunner);
    expect(qr.query).toHaveBeenCalledTimes(2);
  });

  it('on Postgres down() drops the DEFAULT on every existing table', async () => {
    const qr = makeQueryRunner('postgres', new Set(ALL_TABLES));
    await migration.down(qr as unknown as QueryRunner);

    expect(qr.query).toHaveBeenCalledTimes(ALL_TABLES.length);
    expect(qr.query).toHaveBeenCalledWith('ALTER TABLE "message_batches" ALTER COLUMN "id" DROP DEFAULT');
  });
});
