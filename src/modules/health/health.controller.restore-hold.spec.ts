import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { createSqlitePrepareDatabase, type SqliteJournalMode } from '../../database/sqlite-pragmas';
import { HealthController } from './health.controller';
import { holdSharedConnection } from '../../common/utils/shared-connection';

// A SQLite restore holds every statement on the shared data connection until it ends, but not the readiness probe's
// `SELECT 1`: it reads no table, so it answers while the restore holds its write lock on another connection. A 503
// there would take a single-node gateway out of rotation, or have it restarted, in the middle of the restore.
describe('GET /api/health/ready while a restore holds the data connection', () => {
  let data: DataSource;
  let controller: HealthController;
  let draining = false;

  beforeEach(async () => {
    draining = false;
    data = await new DataSource({ type: 'better-sqlite3', database: ':memory:' }).initialize();
    const main = { query: jest.fn().mockResolvedValue([{ 1: 1 }]) };
    controller = new HealthController(
      main as never,
      data,
      { isShuttingDown: () => draining } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await data.destroy();
  });

  it('answers 200, and the statements the restore holds stay held', async () => {
    const hold = (await holdSharedConnection(data))!;
    let held = false;
    const statement = data.query('SELECT 2').then(() => (held = true));

    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      details: { mainDatabase: { status: 'up' }, dataDatabase: { status: 'up' } },
    });
    expect(held).toBe(false);
    hold.release();
    await statement;
  });

  it('still answers 503 for a data connection whose probe fails while held', async () => {
    const hold = (await holdSharedConnection(data))!;
    const handle = (data.driver as unknown as { databaseConnection: { prepare(sql: string): unknown } })
      .databaseConnection;
    jest.spyOn(handle, 'prepare').mockImplementation(() => {
      throw new Error('disk I/O error');
    });

    await expect(controller.readiness()).rejects.toMatchObject({
      status: 503,
      response: { status: 'error', details: { mainDatabase: { status: 'up' }, dataDatabase: { status: 'down' } } },
    });
    hold.release();
  });

  it('still answers 503 while draining for shutdown', async () => {
    const hold = (await holdSharedConnection(data))!;
    draining = true;

    await expect(controller.readiness()).rejects.toMatchObject({
      status: 503,
      response: { status: 'error', details: { shutdown: { status: 'draining' } } },
    });
    hold.release();
  });
});

// The restore writes on a connection of its own and holds its write lock until it commits. The probe's statement
// reads no table, so it needs no lock, in either journal mode; one that did would fail the probe once the shared
// connection's busy timeout ran out, holding the event loop meanwhile.
describe.each<SqliteJournalMode>(['WAL', 'DELETE'])(
  'the readiness probe beside a restore holding its lock (%s)',
  journal => {
    it('answers 200 at once', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'owa-ready-lock-'));
      const file = join(dir, 'data.sqlite');
      const open = (): Promise<DataSource> =>
        new DataSource({
          type: 'better-sqlite3',
          database: file,
          timeout: 1_500,
          prepareDatabase: createSqlitePrepareDatabase(file, journal),
        }).initialize();
      const data = await open();
      const restore = await open();
      try {
        await data.query('CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT)');
        const writer = (restore.driver as unknown as { databaseConnection: { exec(sql: string): void } })
          .databaseConnection;
        writer.exec('BEGIN EXCLUSIVE');
        writer.exec("INSERT INTO rows (body) VALUES ('restored')");
        const controller = new HealthController(
          { query: jest.fn().mockResolvedValue([{ 1: 1 }]) } as never,
          data,
          { isShuttingDown: () => false } as never,
          {} as never,
          {} as never,
          {} as never,
        );
        const hold = (await holdSharedConnection(data))!;
        const startedAt = Date.now();

        await expect(controller.readiness()).resolves.toMatchObject({ status: 'ok' });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        writer.exec('ROLLBACK');
        hold.release();
      } finally {
        await restore.destroy();
        await data.destroy();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
