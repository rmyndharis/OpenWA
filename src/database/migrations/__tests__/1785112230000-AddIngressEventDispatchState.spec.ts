import { DataSource, QueryRunner } from 'typeorm';
import { AddIntegrationFabric1781900000000 } from '../1781900000000-AddIntegrationFabric';
import { AddIngressEventDispatchState1785112230000 } from '../1785112230000-AddIngressEventDispatchState';

describe('AddIngressEventDispatchState migration (sqlite)', () => {
  let ds: DataSource;
  let runner: QueryRunner;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], migrations: [] });
    await ds.initialize();
    runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
  });

  afterEach(async () => {
    await runner.release();
    if (ds.isInitialized) await ds.destroy();
  });

  const columns = async (): Promise<string[]> => {
    const rows = (await runner.query(`PRAGMA table_info("ingress_events")`)) as Array<{ name: string }>;
    return rows.map(r => r.name);
  };

  const insertEvent = (id: string, dispatchState?: string) =>
    runner.query(
      `INSERT INTO "ingress_events" ("id","instanceId","pluginId","providerDeliveryId","route","payload","createdAt"${dispatchState === undefined ? '' : ',"dispatchState"'}) ` +
        `VALUES ('${id}','inst','plug','${id}','chatwoot','{}',datetime('now')${dispatchState === undefined ? '' : `,'${dispatchState}'`})`,
    );

  it('adds the three columns + sweep index and backfills EXISTING rows as dispatched', async () => {
    await insertEvent('legacy-1');
    await insertEvent('legacy-2');

    await new AddIngressEventDispatchState1785112230000().up(runner);

    for (const col of ['dispatchState', 'dispatchAttempts', 'lastDispatchAt']) {
      expect(await columns()).toContain(col);
    }
    const rows = (await runner.query(
      `SELECT "id","dispatchState","dispatchAttempts","lastDispatchAt" FROM "ingress_events" ORDER BY "id"`,
    )) as Array<{ id: string; dispatchState: string; dispatchAttempts: number; lastDispatchAt: unknown }>;
    // Pre-migration rows are history — already delivered; stamping them 'pending' would mass-replay
    // the whole dedup log on deploy.
    expect(rows.map(r => r.dispatchState)).toEqual(['dispatched', 'dispatched']);
    expect(rows.map(r => r.dispatchAttempts)).toEqual([0, 0]);
    expect(rows.map(r => r.lastDispatchAt)).toEqual([null, null]);

    const indexes = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_ingress_events_dispatchState'`,
    )) as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('is idempotent and never re-stamps a live pending row on re-run', async () => {
    const mig = new AddIngressEventDispatchState1785112230000();
    await mig.up(runner);
    await insertEvent('live-1', 'pending');

    await mig.up(runner); // column-exists guard → no-op; the backfill UPDATE must NOT fire again

    const row = (await runner.query(`SELECT "dispatchState" FROM "ingress_events" WHERE "id" = 'live-1'`)) as Array<{
      dispatchState: string;
    }>;
    expect(row[0].dispatchState).toBe('pending');
  });

  it('leaves a raw insert without the column NULL (unwatched) — the synchronize-path safety shape', async () => {
    await new AddIngressEventDispatchState1785112230000().up(runner);
    await insertEvent('raw-1');

    const row = (await runner.query(`SELECT "dispatchState" FROM "ingress_events" WHERE "id" = 'raw-1'`)) as Array<{
      dispatchState: string | null;
    }>;
    // recordOrSkip writes 'pending' explicitly; anything else stays NULL = "not watched", so a
    // synchronize-bootstrapped DB (no backfill) can never mass-replay history either.
    expect(row[0].dispatchState).toBeNull();
  });

  it('down() drops the columns and the index', async () => {
    const mig = new AddIngressEventDispatchState1785112230000();
    await mig.up(runner);
    await mig.down(runner);

    for (const col of ['dispatchState', 'dispatchAttempts', 'lastDispatchAt']) {
      expect(await columns()).not.toContain(col);
    }
    const indexes = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_ingress_events_dispatchState'`,
    )) as Array<{ name: string }>;
    expect(indexes).toHaveLength(0);

    // Tolerates a synchronize-bootstrapped DB where the columns/index never existed.
    await expect(mig.down(runner)).resolves.toBeUndefined();
  });
});
