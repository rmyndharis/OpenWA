import { Column, DataSource, Entity, In, IsNull, LessThan, Not, PrimaryColumn, Repository } from 'typeorm';
import { setImmediate } from 'timers/promises';
import {
  PRUNE_BATCH_SIZE,
  PRUNE_PAUSE_MS_SQLITE,
  PRUNE_READ_AHEAD_POSTGRES,
  pruneInBatches,
  type PruneInBatchesOptions,
} from './batched-prune';
import {
  SESSION_DELETE_BATCH_SIZE_POSTGRES,
  SESSION_DELETE_PAUSE_MS_SQLITE,
  SESSION_DELETE_READ_AHEAD_POSTGRES,
} from '../../modules/session/session-engine-controls';

@Entity('prune_rows')
class PruneRow {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  /** Smaller is older. */
  @Column({ type: 'integer' })
  age!: number;

  @Column({ type: 'varchar', nullable: true })
  payload!: string | null;
}

/**
 * SQLite runs a statement on the event loop and every await of one of its queries resolves as a microtask, so a loop of
 * statements holds the process from its first to its last unless it gives the loop up between them. These specs run
 * the real driver, record each DELETE it prepares, and look at what ran between two of them.
 */
describe('pruneInBatches on SQLite', () => {
  let ds: DataSource;
  let rows: Repository<PruneRow>;
  /** Rows from this age on are not old enough to prune. */
  const FRESH = 10_000_000;
  /** What one statement removed, and where a timer tick fell between statements. */
  let log: Array<number | 'tick'>;

  const hookDeletes = (source: DataSource): void => {
    const connection = (source.driver as unknown as { databaseConnection: { prepare: (sql: string) => unknown } })
      .databaseConnection;
    const prepare = connection.prepare.bind(connection);
    connection.prepare = (sql: string) => {
      const statement = prepare(sql) as { run: (...args: unknown[]) => { changes: number } };
      if (/^\s*DELETE\b/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args: unknown[]) => {
          const result = run(...args);
          log.push(result.changes);
          return result;
        };
      }
      return statement;
    };
  };

  /** `old` rows aged 1..old and `fresh` rows aged FRESH + n, each with a payload. */
  const seed = async (old: number, fresh = 0): Promise<void> => {
    await ds.query(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${old + fresh})
       INSERT INTO prune_rows (id, age, payload)
       SELECT 'row-' || i, CASE WHEN i <= ${old} THEN i ELSE ${FRESH} + i END, 'p' FROM c`,
    );
  };

  const prune = (extra: Partial<PruneInBatchesOptions<PruneRow>> = {}): Promise<number> =>
    pruneInBatches({ repository: rows, where: { age: LessThan(FRESH) }, ...extra });

  beforeEach(async () => {
    log = [];
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [PruneRow], synchronize: true });
    await ds.initialize();
    hookDeletes(ds);
    rows = ds.getRepository(PruneRow);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('removes every matching row in statements of at most one batch, and keeps the rest', async () => {
    await seed(2 * PRUNE_BATCH_SIZE + 100, 150);

    await expect(prune()).resolves.toBe(2 * PRUNE_BATCH_SIZE + 100);

    expect(log).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 100]);
    expect(await rows.count()).toBe(150);
    expect(await rows.count({ where: { age: LessThan(FRESH) } })).toBe(0);
  });

  it('gives up the event loop between statements, so a timer fires between any two', async () => {
    await seed(4 * PRUNE_BATCH_SIZE);
    const timer = setInterval(() => log.push('tick'), 1);

    try {
      await prune();
    } finally {
      clearInterval(timer);
    }

    const statements = log.flatMap((entry, index) => (entry === 'tick' ? [] : [index]));
    expect(statements).toHaveLength(4);
    for (let i = 1; i < statements.length; i++) {
      expect(log.slice(statements[i - 1], statements[i])).toContain('tick');
    }
  });

  it('ends without a pause when its one read was short, and reads once when nothing matches', async () => {
    await seed(0, 10);
    const find = jest.spyOn(rows, 'find');

    await expect(prune()).resolves.toBe(0);

    expect(find).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);
  });

  it('stops before the next statement once the owner is shutting down', async () => {
    await seed(3 * PRUNE_BATCH_SIZE);
    const remove = jest.spyOn(rows, 'delete');

    await expect(prune({ stopped: () => remove.mock.calls.length >= 1 })).resolves.toBe(PRUNE_BATCH_SIZE);

    expect(await rows.count()).toBe(2 * PRUNE_BATCH_SIZE);
  });

  it('reads nothing once the owner has already stopped', async () => {
    await seed(10);
    const find = jest.spyOn(rows, 'find');

    await expect(prune({ stopped: () => true })).resolves.toBe(0);

    expect(find).not.toHaveBeenCalled();
    expect(await rows.count()).toBe(10);
  });

  it('handles at most maxRows in a run and leaves the rest for the next', async () => {
    await seed(1250);

    await expect(prune({ maxRows: 1000 })).resolves.toBe(1000);
    expect(await rows.count()).toBe(250);

    await expect(prune({ maxRows: 1000 })).resolves.toBe(250);
    expect(await rows.count()).toBe(0);
  });

  it('takes the rows in the order it is given', async () => {
    await seed(1000);

    await prune({ order: { age: 'ASC' }, maxRows: PRUNE_BATCH_SIZE });

    expect((await rows.find({ order: { age: 'ASC' }, take: 1 }))[0].age).toBe(PRUNE_BATCH_SIZE + 1);
  });

  it('clears columns instead of deleting, and ends because the cleared rows leave the condition', async () => {
    await seed(1200, 30);

    const cleared = await pruneInBatches({
      repository: rows,
      where: { payload: Not(IsNull()), age: LessThan(FRESH) },
      clear: { payload: null },
    });

    expect(cleared).toBe(1200);
    expect(log).toEqual([]);
    expect(await rows.count()).toBe(1230);
    expect(await rows.count({ where: { payload: Not(IsNull()) } })).toBe(30);
  });

  it('treats a list of conditions as alternatives', async () => {
    await seed(0, 600);
    await rows.update({ id: In(['row-1', 'row-2']) }, { age: 5 });
    await rows.update({ id: 'row-3' }, { payload: null });

    const removed = await pruneInBatches({
      repository: rows,
      where: [{ age: LessThan(10) }, { payload: IsNull() }, { id: 'row-4' }],
    });

    expect(removed).toBe(4);
    expect(await rows.count()).toBe(596);
  });

  it('counts the rows a statement changed, not the ones it was asked about', async () => {
    await seed(PRUNE_BATCH_SIZE + 5);
    const realDelete = rows.delete.bind(rows) as (ids: string[]) => Promise<unknown>;
    // Another writer removed 2 of every batch before the statement ran: it changes 2 rows fewer.
    jest
      .spyOn(rows, 'delete')
      .mockImplementation(((ids: string[]) =>
        realDelete(ids.slice(2)).then(() => ({ affected: ids.length - 2, raw: [] }))) as never);

    const removed = await prune();

    // 498 of the first 500, then the 2 it skipped and the 5 beyond them, of which 5 go: 2 rows remain.
    expect(removed).toBe(PRUNE_BATCH_SIZE + 5 - 2);
    expect(await rows.count()).toBe(2);
  });

  it('passes a failing statement to the caller', async () => {
    await seed(10);
    jest.spyOn(rows, 'delete').mockRejectedValue(new Error('disk full'));

    await expect(prune()).rejects.toThrow('disk full');
  });
});

/**
 * PostgreSQL does not hold the process, so what matters there is the number of statements. A repository stub whose
 * connection says postgres stands in for the real server in the default test run; the real one runs in
 * webhook-recovery.pg.spec.ts.
 */
describe('pruneInBatches on PostgreSQL', () => {
  const makeTable = (size: number) => {
    let ids = Array.from({ length: size }, (_, i) => `id-${i}`);
    const reads: number[] = [];
    const statements: number[] = [];
    const repository = {
      manager: { connection: { options: { type: 'postgres' } } },
      find: jest.fn(({ take }: { take: number }) => {
        reads.push(take);
        return Promise.resolve(ids.slice(0, take).map(id => ({ id })));
      }),
      delete: jest.fn((batch: string[]) => {
        statements.push(batch.length);
        const gone = new Set(batch);
        ids = ids.filter(id => !gone.has(id));
        return Promise.resolve({ affected: batch.length, raw: [] });
      }),
      update: jest.fn((batch: string[]) => {
        statements.push(batch.length);
        return Promise.resolve({ affected: batch.length, raw: [] });
      }),
    };
    return {
      repository: repository as unknown as Repository<{ id: string }>,
      update: repository.update,
      remove: repository.delete,
      reads,
      statements,
      left: () => ids.length,
    };
  };
  const where = {};

  it('reads ahead: one read feeds the statements of the next twenty batches', async () => {
    const table = makeTable(25_000);

    const removed = await pruneInBatches({ repository: table.repository, where });

    expect(removed).toBe(25_000);
    expect(table.reads).toEqual([10_000, 10_000, 10_000]);
    expect(table.statements).toHaveLength(50);
    expect(Math.max(...table.statements)).toBe(PRUNE_BATCH_SIZE);
    expect(table.left()).toBe(0);
  });

  it('reads once more only when the last read was full', async () => {
    const full = makeTable(10_000);
    await pruneInBatches({ repository: full.repository, where });
    expect(full.reads).toEqual([10_000, 10_000]);

    const short = makeTable(9_999);
    await pruneInBatches({ repository: short.repository, where });
    expect(short.reads).toEqual([10_000]);
    expect(short.statements.reduce((sum, n) => sum + n, 0)).toBe(9_999);
  });

  it('asks for no more rows than its cap leaves', async () => {
    const table = makeTable(25_000);

    const removed = await pruneInBatches({ repository: table.repository, where, maxRows: 700 });

    expect(removed).toBe(700);
    expect(table.reads).toEqual([700]);
    expect(table.statements).toEqual([500, 200]);
  });

  it('lets another task run between statements', async () => {
    const table = makeTable(2_000);
    const order: string[] = [];
    table.remove.mockImplementation((batch: string[]) => {
      order.push('statement');
      void setImmediate().then(() => order.push('task'));
      return Promise.resolve({ affected: batch.length, raw: [] });
    });

    await pruneInBatches({ repository: table.repository, where });

    expect(order.slice(0, 4)).toEqual(['statement', 'task', 'statement', 'task']);
  });

  it('checks the stop flag between the batches of one read', async () => {
    const table = makeTable(5_000);
    let stopped = false;
    table.remove.mockImplementation((batch: string[]) => {
      stopped = table.statements.push(batch.length) >= 2;
      return Promise.resolve({ affected: batch.length, raw: [] });
    });

    const removed = await pruneInBatches({ repository: table.repository, where, stopped: () => stopped });

    expect(removed).toBe(2 * PRUNE_BATCH_SIZE);
    expect(table.statements).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE]);
  });

  it('counts nothing for a statement that reports no count', async () => {
    const table = makeTable(3);
    table.remove.mockResolvedValue({ raw: [] } as never);

    await expect(pruneInBatches({ repository: table.repository, where })).resolves.toBe(0);
  });

  it('updates by id instead of deleting when it is given columns to clear', async () => {
    const table = makeTable(1_200);

    const cleared = await pruneInBatches({ repository: table.repository, where, clear: { id: 'x' }, maxRows: 1_200 });

    expect(cleared).toBe(1_200);
    expect(table.update).toHaveBeenCalledTimes(3);
    expect(table.remove).not.toHaveBeenCalled();
  });
});

describe('prune batch constants', () => {
  // The session module cannot be imported by the services that prune (it would load in a cycle), so the figures are
  // restated and pinned to the ones its delete was measured with.
  it('match the session delete', () => {
    expect(PRUNE_BATCH_SIZE).toBe(SESSION_DELETE_BATCH_SIZE_POSTGRES);
    expect(PRUNE_READ_AHEAD_POSTGRES).toBe(SESSION_DELETE_READ_AHEAD_POSTGRES);
    expect(PRUNE_PAUSE_MS_SQLITE).toBe(SESSION_DELETE_PAUSE_MS_SQLITE);
  });
});
