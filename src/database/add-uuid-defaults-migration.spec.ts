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

  it('on Postgres up() creates pgcrypto, then sets a uuid DEFAULT on every existing table', async () => {
    const qr = makeQueryRunner('postgres', new Set(ALL_TABLES));
    await migration.up(qr as unknown as QueryRunner);

    // 1 CREATE EXTENSION + one ALTER per table.
    expect(qr.query).toHaveBeenCalledTimes(ALL_TABLES.length + 1);
    const calls = qr.query.mock.calls.map(call => String((call as unknown[])[0]));
    // pgcrypto must be ensured before any gen_random_uuid() default that depends on it (PG <= 12).
    const extIdx = calls.findIndex(q => /CREATE EXTENSION IF NOT EXISTS pgcrypto/i.test(q));
    const firstAlterIdx = calls.findIndex(q => /gen_random_uuid\(\)/i.test(q));
    expect(extIdx).toBe(0);
    expect(extIdx).toBeLessThan(firstAlterIdx);
    expect(qr.query).toHaveBeenCalledWith(
      'ALTER TABLE "sessions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar',
    );
  });

  it('skips tables that do not exist (still creates pgcrypto)', async () => {
    const qr = makeQueryRunner('postgres', new Set(['sessions', 'messages']));
    await migration.up(qr as unknown as QueryRunner);
    // 1 CREATE EXTENSION + 2 ALTERs (only the two existing tables).
    expect(qr.query).toHaveBeenCalledTimes(3);
  });

  it('on Postgres down() drops the DEFAULT on every existing table', async () => {
    const qr = makeQueryRunner('postgres', new Set(ALL_TABLES));
    await migration.down(qr as unknown as QueryRunner);

    expect(qr.query).toHaveBeenCalledTimes(ALL_TABLES.length);
    expect(qr.query).toHaveBeenCalledWith('ALTER TABLE "message_batches" ALTER COLUMN "id" DROP DEFAULT');
  });
});
