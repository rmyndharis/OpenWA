import { DataSource, QueryRunner } from 'typeorm';
import { AddIntegrationFabric1781900000000 } from '../1781900000000-AddIntegrationFabric';
import { WidenIngressDedupKey1782100000000 } from '../1782100000000-WidenIngressDedupKey';
import { AddIngressEventDispatchState1785112230000 } from '../1785112230000-AddIngressEventDispatchState';
import { SlimIngressEventPayload1785600000000 } from '../1785600000000-SlimIngressEventPayload';

describe('SlimIngressEventPayload migration (sqlite)', () => {
  let ds: DataSource;
  let runner: QueryRunner;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], migrations: [] });
    await ds.initialize();
    runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await new WidenIngressDedupKey1782100000000().up(runner);
    await new AddIngressEventDispatchState1785112230000().up(runner);
  });

  afterEach(async () => {
    await runner.release();
    if (ds.isInitialized) await ds.destroy();
  });

  const columns = async (): Promise<Array<{ name: string; notnull: number }>> =>
    (await runner.query(`PRAGMA table_info("ingress_events")`)) as Array<{ name: string; notnull: number }>;

  const insertEvent = (id: string, dispatchState: string | null, payload = '{"rawBody":"x"}') =>
    runner.query(
      `INSERT INTO "ingress_events" ("id","instanceId","pluginId","providerDeliveryId","route","payload","dispatchState","createdAt") ` +
        `VALUES ('${id}','inst','plug','${id}','chatwoot','${payload}',${dispatchState === null ? 'NULL' : `'${dispatchState}'`},datetime('now'))`,
    );

  const payloadOf = async (id: string): Promise<string | null> => {
    const rows = (await runner.query(`SELECT "payload" FROM "ingress_events" WHERE "id" = '${id}'`)) as Array<{
      payload: string | null;
    }>;
    return rows[0].payload;
  };

  it('makes payload nullable, adds payloadHash, retires non-pending payloads, and keeps pending ones', async () => {
    await insertEvent('pending-1', 'pending');
    await insertEvent('dispatched-1', 'dispatched');
    await insertEvent('legacy-1', null); // unwatched history — never replayed
    await insertEvent('failed-1', 'failed');

    await new SlimIngressEventPayload1785600000000().up(runner);

    const cols = await columns();
    expect(cols.map(c => c.name)).toContain('payloadHash');
    expect(cols.find(c => c.name === 'payload')?.notnull).toBe(0);

    // Only 'pending' rows still need their payload (the reconciler replays from it); every other
    // row's stored payload was dead weight.
    expect(await payloadOf('pending-1')).toBe('{"rawBody":"x"}');
    expect(await payloadOf('dispatched-1')).toBeNull();
    expect(await payloadOf('legacy-1')).toBeNull();
    expect(await payloadOf('failed-1')).toBeNull();

    const count = (await runner.query(`SELECT COUNT(*) AS n FROM "ingress_events"`)) as Array<{ n: number }>;
    expect(count[0].n).toBe(4);

    // The rebuild recreates all three indexes (the sqlite_autoindex_* entries come from the
    // varchar PRIMARY KEY itself, on both the old and the rebuilt table — excluded here).
    const indexes = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ingress_events' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`,
    )) as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toEqual([
      'IDX_ingress_events_createdAt',
      'IDX_ingress_events_dispatchState',
      'UQ_ingress_events_instance_delivery',
    ]);
  });

  it('is idempotent on re-run (payloadHash probe) and never re-purges a live pending row', async () => {
    const mig = new SlimIngressEventPayload1785600000000();
    await mig.up(runner);
    await runner.query(
      `INSERT INTO "ingress_events" ("id","instanceId","pluginId","providerDeliveryId","route","payload","payloadHash","dispatchState","createdAt") ` +
        `VALUES ('live-1','inst','plug','live-1','chatwoot','{"rawBody":"y"}','hash-y','pending',datetime('now'))`,
    );

    await mig.up(runner); // no-op

    expect(await payloadOf('live-1')).toBe('{"rawBody":"y"}');
    const rows = (await runner.query(`SELECT "payloadHash" FROM "ingress_events" WHERE "id" = 'live-1'`)) as Array<{
      payloadHash: string | null;
    }>;
    expect(rows[0].payloadHash).toBe('hash-y');
  });

  it('down() restores payload NOT NULL (tombstoning retired rows) and drops payloadHash', async () => {
    const mig = new SlimIngressEventPayload1785600000000();
    await insertEvent('pending-1', 'pending');
    await mig.up(runner);
    await mig.down(runner);

    const cols = await columns();
    expect(cols.map(c => c.name)).not.toContain('payloadHash');
    expect(cols.find(c => c.name === 'payload')?.notnull).toBe(1);
    expect(await payloadOf('pending-1')).toBe('{"rawBody":"x"}');

    const indexes = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ingress_events' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`,
    )) as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toEqual([
      'IDX_ingress_events_createdAt',
      'IDX_ingress_events_dispatchState',
      'UQ_ingress_events_instance_delivery',
    ]);

    // Tolerates a DB where the migration never ran.
    await expect(mig.down(runner)).resolves.toBeUndefined();
  });
});
