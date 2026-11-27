import * as timers from 'timers/promises';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { awaitNoOpenTransaction, holdSharedConnection, sharedConnectionHeld } from './shared-connection';

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

@Entity('notes')
class Note {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  text!: string;
}

describe('holdSharedConnection', () => {
  let db: DataSource;
  /** Every statement the shared runner executes, in order. */
  let executed: string[];

  const turns = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve));
  };
  /** Settles `work` and records the moment it did. */
  const watch = <T>(work: Promise<T>): { done: () => boolean; result: Promise<T> } => {
    let settled = false;
    const result = work.finally(() => (settled = true));
    result.catch(() => undefined);
    return { done: () => settled, result };
  };

  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Note],
      synchronize: true,
    }).initialize();
    executed = [];
    const runner = db.createQueryRunner();
    const query = runner.query.bind(runner) as (sql: string, ...rest: unknown[]) => Promise<unknown>;
    jest.spyOn(runner, 'query').mockImplementation((sql: string, ...rest: unknown[]) => {
      executed.push(sql);
      return query(sql, ...rest);
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });

  it('holds every way into the one runner until released, then lets each through', async () => {
    const runner = db.createQueryRunner();
    // better-sqlite3 hands out one runner per DataSource: the hold covers every path only while that stays so.
    expect(db.createQueryRunner()).toBe(runner);
    expect(db.manager.queryRunner ?? db.createQueryRunner()).toBe(runner);
    const hold = await holdSharedConnection(db);
    expect(hold).toBeDefined();

    const held = [
      watch(db.getRepository(Note).save({ text: 'saved' })),
      watch(db.query('SELECT 1')),
      watch(db.manager.find(Note)),
      watch(db.transaction(manager => manager.getRepository(Note).save({ text: 'in a transaction' }))),
      watch(runner.connect()),
      watch(awaitNoOpenTransaction(db)),
    ];
    await turns(20);
    expect(held.filter(caller => caller.done())).toEqual([]);
    expect(executed).toEqual([]);

    hold!.release();
    await Promise.all(held.map(caller => caller.result));
    expect((await db.getRepository(Note).find()).map(note => note.text).sort()).toEqual(['in a transaction', 'saved']);
  });

  it('lets the callers held through in the order they came, a later one behind all of them', async () => {
    const hold = (await holdSharedConnection(db))!;
    const order: string[] = [];
    const held = ['first', 'second', 'third'].map(name =>
      db.query(`SELECT '${name}' AS name`).then(() => order.push(name)),
    );

    hold.release();
    // Asked on a later turn, while the callers held are still being let through.
    const later = new Promise(resolve => setImmediate(resolve)).then(() =>
      db.query("SELECT 'later' AS name").then(() => order.push('later')),
    );
    await Promise.all([...held, later]);

    expect(order).toEqual(['first', 'second', 'third', 'later']);
  });

  it('never runs a save held beside a transaction inside it', async () => {
    const hold = (await holdSharedConnection(db))!;
    // The message insert past its wait for no open transaction: its own transaction, held at its start. A save
    // let through with it would find that transaction active and write inside it instead of opening its own.
    const insert = db.transaction(async manager => {
      await manager.getRepository(Note).save({ text: 'message' });
      await manager.getRepository(Note).save({ text: 'outbox' });
    });
    const save = db.getRepository(Note).save({ text: 'other' });

    hold.release();
    await Promise.all([insert, save]);

    // Each transaction ends before the next begins, and every insert sits inside one: the save took its own.
    const transactions: string[][] = [];
    for (const sql of executed) {
      if (sql === 'BEGIN TRANSACTION') transactions.push([]);
      else if (sql === 'COMMIT') transactions.push(['end']);
      else transactions[transactions.length - 1]?.push(sql);
    }
    const bodies = transactions.filter(body => body[0] !== 'end');
    expect(transactions.map(body => (body[0] === 'end' ? 'COMMIT' : 'BEGIN'))).toEqual([
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'COMMIT',
    ]);
    expect(bodies.map(body => body.filter(sql => sql.startsWith('INSERT')).length).sort()).toEqual([1, 2]);
  });

  it('waits for a transaction a caller let through left open before it lets the next through', async () => {
    const hold = (await holdSharedConnection(db))!;
    const order: string[] = [];
    let endIt!: () => void;
    const spanning = db.transaction(async manager => {
      await manager.getRepository(Note).save({ text: 'spans turns' });
      order.push('first wrote');
      await new Promise<void>(resolve => (endIt = resolve));
      await manager.getRepository(Note).save({ text: 'after the wait' });
      order.push('first committed');
    });
    const next = db
      .getRepository(Note)
      .save({ text: 'next' })
      .then(() => order.push('next'));

    hold.release();
    await new Promise<void>(resolve => {
      const check = (): void => (order.length > 0 ? resolve() : void setImmediate(check));
      check();
    });
    await turns(10);
    expect(order).toEqual(['first wrote']);
    endIt();
    await Promise.all([spanning, next]);

    expect(order).toEqual(['first wrote', 'first committed', 'next']);
  });

  it('fails a statement the restore issues on the shared runner instead of holding it', async () => {
    const hold = (await holdSharedConnection(db))!;

    await expect(hold.asRestore(() => db.query('SELECT 1'))).rejects.toThrow('the restore must use its own connection');
    await expect(hold.asRestore(() => awaitNoOpenTransaction(db))).rejects.toThrow(
      'the restore must use its own connection',
    );
    expect(executed).toEqual([]);
    hold.release();
  });

  it('runs the restore follow-up ahead of the callers held', async () => {
    const hold = (await holdSharedConnection(db))!;
    const order: string[] = [];
    const held = db.query("SELECT 'held'").then(() => order.push('held'));

    // Its wait for no open transaction goes ahead of the callers held too.
    await expect(hold.asOwner(() => awaitNoOpenTransaction(db))).resolves.toBe(true);
    hold.release();
    await hold.asOwner(async () => {
      await db.getRepository(Note).save({ text: 'follow-up' });
      await db.query('SELECT 1');
      order.push('owner');
    });
    await held;

    expect(order).toEqual(['owner', 'held']);
  });

  it('puts back the methods it covered, a spy included, once every caller is through', async () => {
    const runner = db.createQueryRunner();
    const spy = Object.getOwnPropertyDescriptor(runner, 'query');
    const hold = (await holdSharedConnection(db))!;
    expect(Object.getOwnPropertyDescriptor(runner, 'query')).not.toEqual(spy);
    const held = db.query('SELECT 1');

    hold.release();
    await held;
    await turns(3);

    expect(Object.getOwnPropertyDescriptor(runner, 'query')).toEqual(spy);
    expect(Object.hasOwn(runner, 'startTransaction')).toBe(false);
    expect(Object.hasOwn(runner, 'connect')).toBe(false);
    // Nothing is held any more: a statement runs on the turn it is issued.
    const at = executed.length;
    void db.query('SELECT 2');
    await Promise.resolve();
    await Promise.resolve();
    expect(executed.slice(at)).toEqual(['SELECT 2']);
  });

  it('is not taken while a transaction stays open, and is once it ends', async () => {
    const connection = (db.driver as unknown as { databaseConnection: { exec(sql: string): void } }).databaseConnection;
    connection.exec('BEGIN');
    await expect(holdSharedConnection(db, 20)).resolves.toBeUndefined();
    expect(Object.hasOwn(db.createQueryRunner(), 'startTransaction')).toBe(false);

    setTimeout(() => connection.exec('ROLLBACK'), 20);
    const hold = await holdSharedConnection(db);
    expect(hold).toBeDefined();
    hold!.release();
  });

  it('is not taken while another hold still lets its callers through', async () => {
    const first = (await holdSharedConnection(db))!;
    await expect(holdSharedConnection(db, 0)).resolves.toBeUndefined();
    first.release();
    const second = await holdSharedConnection(db);
    expect(second).toBeDefined();
    second!.release();
  });

  it('reports a hold until it is released, for the requests that wait on it', async () => {
    expect(sharedConnectionHeld()).toBeUndefined();
    const hold = (await holdSharedConnection(db))!;
    const released = sharedConnectionHeld();
    expect(released).toBeDefined();
    let settled = false;
    void released!.then(() => (settled = true));
    await turns(5);
    expect(settled).toBe(false);

    hold.release();
    await released;
    expect(sharedConnectionHeld()).toBeUndefined();
  });

  it('times a wait for no open transaction from its turn, not from when it was held', async () => {
    const hold = (await holdSharedConnection(db))!;
    const wait = watch(awaitNoOpenTransaction(db, 0));
    await turns(10);
    expect(wait.done()).toBe(false);

    hold.release();
    await expect(wait.result).resolves.toBe(true);
  });
});
