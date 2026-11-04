import * as timers from 'timers/promises';
import { DataSource } from 'typeorm';
import { awaitNoOpenTransaction } from './shared-connection';

// Fake timers leave timers/promises alone, so the helper's waits are watched here; they still run for real.
jest.mock('timers/promises', () => {
  const actual = jest.requireActual<typeof import('timers/promises')>('timers/promises');
  return {
    __esModule: true,
    ...actual,
    setImmediate: jest.fn(actual.setImmediate),
    setTimeout: jest.fn(actual.setTimeout),
  };
});

describe('awaitNoOpenTransaction', () => {
  let db: DataSource;

  beforeEach(async () => {
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:' }).initialize();
  });
  afterEach(async () => {
    jest.useRealTimers();
    await db.destroy();
  });

  it('resolves at once where each runner has a connection of its own, or none reports its state', async () => {
    jest.useFakeTimers();
    jest.mocked(timers.setImmediate).mockClear();
    jest.mocked(timers.setTimeout).mockClear();
    await expect(awaitNoOpenTransaction({ options: { type: 'postgres' } } as DataSource)).resolves.toBe(true);
    await expect(awaitNoOpenTransaction({ options: { type: 'better-sqlite3' } } as DataSource)).resolves.toBe(true);
    expect(timers.setImmediate).not.toHaveBeenCalled();
    expect(timers.setTimeout).not.toHaveBeenCalled();
    // The shared connection does take its turn, so the two checks above watch the waits the helper makes.
    await expect(awaitNoOpenTransaction(db)).resolves.toBe(true);
    expect(timers.setImmediate).toHaveBeenCalledTimes(1);
  });

  it('waits for a transaction open on the shared connection to end', async () => {
    const runner = db.createQueryRunner();
    await runner.startTransaction();
    let ended = false;
    setTimeout(() => {
      ended = true;
      void runner.rollbackTransaction();
    }, 30);

    await expect(awaitNoOpenTransaction(db)).resolves.toBe(true);
    expect(ended).toBe(true);
  });

  it('gives up with false when the transaction outlasts the bound', async () => {
    const runner = db.createQueryRunner();
    await runner.startTransaction();
    try {
      await expect(awaitNoOpenTransaction(db, 20)).resolves.toBe(false);
    } finally {
      await runner.rollbackTransaction();
    }
  });

  // TypeORM sets isTransactionActive before its BEGIN and does not clear it when the BEGIN fails.
  it('does not wait on a runner left marked active by a BEGIN that failed', async () => {
    const runner = db.createQueryRunner();
    const connection = (db.driver as unknown as { databaseConnection: { exec(sql: string): void } }).databaseConnection;
    connection.exec('BEGIN');
    await expect(runner.startTransaction()).rejects.toThrow();
    connection.exec('ROLLBACK');
    expect(runner.isTransactionActive).toBe(true);

    await expect(awaitNoOpenTransaction(db, 1000)).resolves.toBe(true);
  });
});
