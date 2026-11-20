import { randomUUID } from 'node:crypto';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstance } from './entities/plugin-instance.entity';
import { IngressReconcilerService, IngressReconcilerOptions } from './ingress-reconciler.service';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { postgresUtcExtra } from '../../database/postgres-utc';

const pg = process.env.DATABASE_TYPE === 'postgres';
const OPTS: IngressReconcilerOptions = { intervalMs: 60_000, graceMs: 60_000, batchSize: 50, maxAttempts: 5 };
const MINUTE = 60_000;
const SIZES = pg ? [700, 760, 1500] : [700, 760, 1500, 5000];

/**
 * The sweep reads the stale 'pending' rows a batch at a time, oldest first. A row it only looks at and leaves alone (its
 * queue job is live, its payload cannot be read) must not keep the rows behind it from being reached, whatever their
 * number: a stranded row behind N others is looked at within ceil((N + 1) / batchSize) passes. Real reconciler on a real
 * database (SQLite, and PostgreSQL when DATABASE_TYPE=postgres), the queue lookup stubbed, one pass a minute.
 */
describe('IngressReconcilerService walk through a backlog of pending rows', () => {
  // Thousands of rows and a schema built per case: generous, so a slow or instrumented runner cannot fail it.
  jest.setTimeout(180_000);

  let ds: DataSource;
  let events: Repository<IngressEvent>;
  let failures: Repository<IntegrationDeliveryFailure>;
  let schema: string;
  let enqueue: jest.Mock;
  // Deliveries the reconciler added a job for: the queue holds that job from then on.
  let queued: Set<string>;
  let lookups: string[];
  let jobState: (deliveryId: string) => string | undefined;
  let restoring: Set<string>;
  let services: IngressReconcilerService[];
  let t0: number;

  const entities = [IngressEvent, IntegrationDeliveryFailure, PluginInstance];

  beforeEach(async () => {
    if (pg) {
      schema = `ingress_walk_${randomUUID().replace(/-/g, '')}`;
      const options: DataSourceOptions = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
        schema,
        entities,
        extra: postgresUtcExtra(),
      };
      const setup = await new DataSource(options).initialize();
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.synchronize();
      await setup.destroy();
      ds = await new DataSource(options).initialize();
    } else {
      ds = await new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities,
        synchronize: true,
      }).initialize();
    }
    events = ds.getRepository(IngressEvent);
    failures = ds.getRepository(IntegrationDeliveryFailure);
    await ds
      .getRepository(PluginInstance)
      .save({ id: 'plug:inst', pluginId: 'plug', instanceId: 'inst', secret: 's', enabled: true });
    queued = new Set();
    enqueue = jest.fn((data: IngressJobData) => {
      queued.add(data.deliveryId);
      return Promise.resolve({ outcome: 'queued' });
    });
    lookups = [];
    jobState = id => (id.startsWith('live-') ? 'waiting' : undefined);
    restoring = new Set();
    services = [];
    t0 = Date.now();
    for (const level of ['log', 'warn', 'error'] as const)
      jest.spyOn(console, level).mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const service of services) await service.onModuleDestroy();
    if (pg) await ds.query(`DROP SCHEMA "${schema}" CASCADE`);
    await ds.destroy();
  });

  const newService = (): IngressReconcilerService => {
    const service = new IngressReconcilerService(
      events,
      failures,
      {
        enqueue,
        existingJobState: (_data: IngressJobData, deliveryId: string) => {
          lookups.push(deliveryId);
          return Promise.resolve(queued.has(deliveryId) ? 'waiting' : jobState(deliveryId));
        },
        isQueueActive: () => true,
      } as unknown as IngressEnqueueService,
      {
        getPlugin: () => undefined,
        isRestorePending: (id: string) => restoring.has(id),
        restorePendingIds: () => [...restoring],
      } as unknown as PluginLoaderService,
      { resolve: () => Promise.resolve({ enabled: true }) } as unknown as PluginInstanceService,
    );
    services.push(service);
    return service;
  };

  // Rows are old enough for every pass, the first the oldest, a second apart.
  const created = (i: number): Date => new Date(t0 - 3 * 3600_000 + i * 1000);
  // The time of pass k: one a minute, as the timer runs them.
  const at = (k: number): Date => new Date(t0 + k * MINUTE);
  const eventRow = (id: string, deliveryId: string, createdAt: Date, pluginId = 'plug') => ({
    id,
    instanceId: 'inst',
    pluginId,
    providerDeliveryId: deliveryId,
    route: 'r',
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
    sessionId: 'sess-1',
    dispatchState: 'pending' as const,
    dispatchAttempts: 0,
    createdAt,
  });
  const liveRows = (count: number) =>
    Array.from({ length: count }, (_, i) => eventRow(`ev-${i}`, `live-${i}`, created(i)));
  const insert = async (rows: Array<ReturnType<typeof eventRow>>): Promise<void> => {
    for (let i = 0; i < rows.length; i += 400) {
      await events
        .createQueryBuilder()
        .insert()
        .values(rows.slice(i, i + 400))
        .execute();
    }
  };
  const table = (): string =>
    events.metadata.tablePath
      .split('.')
      .map(part => `"${part}"`)
      .join('.');
  const replayed = (): string[] => enqueue.mock.calls.map(([data]) => (data as IngressJobData).deliveryId);

  // Runs `count` passes, from pass `from`, and returns the most job lookups any one of them made.
  const passes = async (
    service: IngressReconcilerService,
    count: number,
    opts: IngressReconcilerOptions = OPTS,
    from = 0,
  ): Promise<number> => {
    let most = 0;
    for (let k = from; k < from + count; k++) {
      const before = lookups.length;
      await service.sweep(opts, at(k));
      most = Math.max(most, lookups.length - before);
    }
    return most;
  };

  it.each(SIZES)('reaches a stranded row behind %i live rows within the bound', async live => {
    await insert([...liveRows(live), eventRow(`ev-${live}`, 'stranded', created(live))]);
    const bound = Math.ceil((live + 1) / OPTS.batchSize);

    const most = await passes(newService(), bound);

    expect(replayed()).toEqual(['stranded']);
    expect(most).toBeLessThanOrEqual(OPTS.batchSize);
    expect(await events.findOneByOrFail({ providerDeliveryId: 'stranded' })).toMatchObject({
      dispatchState: 'pending',
      dispatchAttempts: 1,
    });
    // A live job is left alone: no replay, no attempt spent, no dead letter.
    expect(await events.countBy({ dispatchState: 'pending', dispatchAttempts: 0 })).toBe(live);
    expect(await failures.count()).toBe(0);
  });

  it('settles a row whose job completed meanwhile when the walk reaches it, and delivers nothing for it', async () => {
    await insert([...liveRows(150), eventRow('ev-150', 'stranded', created(150))]);
    const service = newService();
    await passes(service, 1);
    const done = new Set(Array.from({ length: 21 }, (_, i) => `live-${60 + i}`));
    jobState = id => (done.has(id) ? 'completed' : id.startsWith('live-') ? 'waiting' : undefined);

    await passes(service, 3, OPTS, 1);

    expect(replayed()).toEqual(['stranded']);
    const settled = await events.find({ where: { dispatchState: 'dispatched' } });
    expect(settled.map(row => row.providerDeliveryId).sort()).toEqual([...done].sort());
    expect(settled.every(row => row.payload === null)).toBe(true);
  });

  it('reaches a healthy row behind more unreadable rows than the set-aside list holds', async () => {
    const unreadable = 1100;
    await insert([
      ...Array.from({ length: unreadable }, (_, i) => eventRow(`bad-${i}`, `bad-${i}`, created(i))),
      eventRow('ev-healthy', 'stranded', created(unreadable)),
    ]);
    await ds.query(`UPDATE ${table()} SET payload = '{oops' WHERE id LIKE 'bad-%'`);

    await passes(newService(), Math.ceil((unreadable + 1) / OPTS.batchSize));

    expect(replayed()).toEqual(['stranded']);
    expect(await events.countBy({ dispatchState: 'pending', dispatchAttempts: 0 })).toBe(unreadable);
  });

  it('reaches a stranded row behind live rows and unreadable rows mixed', async () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      eventRow(`ev-${i}`, i % 2 ? `bad-${i}` : `live-${i}`, created(i)),
    );
    await insert([...rows, eventRow('ev-600', 'stranded', created(600))]);
    await ds.query(`UPDATE ${table()} SET payload = '{oops' WHERE "providerDeliveryId" LIKE 'bad-%'`);

    await passes(newService(), Math.ceil(601 / OPTS.batchSize));

    expect(replayed()).toEqual(['stranded']);
    expect(lookups.every(id => id.startsWith('live-') || id === 'stranded')).toBe(true);
    expect(await events.countBy({ dispatchState: 'pending', dispatchAttempts: 0 })).toBe(600);
  });

  // Each node keeps its own position, so both walk to the end. The second finds the row the first replayed cooling down,
  // and a replay of it by a node that read it too early would carry the same job id, which the queue treats as one delivery.
  it('lets two nodes walk the same rows without replaying a row twice', async () => {
    await insert([...liveRows(120), eventRow('ev-120', 'stranded', created(120))]);
    const nodes = [newService(), newService()];

    for (let k = 0; k < Math.ceil(121 / OPTS.batchSize); k++) {
      for (const node of nodes) await node.sweep(OPTS, at(k));
    }

    expect(enqueue.mock.calls.map(([, jobId]) => jobId as string)).toEqual(['stranded']);
    expect(lookups.filter(id => id === 'live-119')).toHaveLength(2);
    expect(await events.findOneByOrFail({ providerDeliveryId: 'stranded' })).toMatchObject({ dispatchAttempts: 1 });
  });

  it('starts at the oldest row again after a restart', async () => {
    await insert(liveRows(200));
    await passes(newService(), 3);
    lookups.length = 0;

    await passes(newService(), 1);

    expect(lookups.slice(0, 3)).toEqual(['live-0', 'live-1', 'live-2']);
  });

  it('does not stall when the row the walk stands on is gone', async () => {
    await insert([...liveRows(120), eventRow('ev-120', 'stranded', created(120))]);
    const service = newService();
    await passes(service, 1);
    await events.delete({ id: 'ev-49' });
    lookups.length = 0;

    await passes(service, 1, OPTS, 1);
    expect(lookups).toHaveLength(OPTS.batchSize);
    await passes(service, 1, OPTS, 2);

    expect(replayed()).toEqual(['stranded']);
  });

  it('goes on from the row before the one it could not look up', async () => {
    await insert([...liveRows(120), eventRow('ev-120', 'stranded', created(120))]);
    let down = true;
    jobState = id => (id === 'live-10' && down ? 'unreachable' : id.startsWith('live-') ? 'waiting' : undefined);
    const service = newService();

    await passes(service, 1);
    expect(lookups).toHaveLength(11);
    down = false;
    lookups.length = 0;
    await passes(service, 3, OPTS, 1);

    expect(lookups[0]).toBe('live-10');
    expect(replayed()).toEqual(['stranded']);
  });

  it('looks at every row of a page boundary that falls among rows created at the same time', async () => {
    const same = created(0);
    const pad = (i: number): string => String(i).padStart(3, '0');
    // Stored in the reverse order of their ids, so the order of the ids is the only one the walk can rely on.
    await insert(
      Array.from({ length: 120 }, (_, i) =>
        eventRow(`row-${pad(119 - i)}`, 119 - i === 77 ? 'stranded' : `live-${119 - i}`, same),
      ),
    );

    await passes(newService(), Math.ceil(120 / OPTS.batchSize));

    expect(replayed()).toEqual(['stranded']);
    expect(new Set(lookups).size).toBe(120);
    expect(lookups).toHaveLength(120);
  });

  it('walks rows whose creation times differ by less than a millisecond', async () => {
    await insert(Array.from({ length: 5 }, (_, i) => eventRow(`ev-${i}`, `live-${i}`, created(0))));
    // Oldest first is the reverse of the order of the ids.
    for (let i = 0; i < 5; i++) {
      await ds.query(`UPDATE ${table()} SET "createdAt" = '2020-01-01 00:00:00.12300${5 - i}' WHERE id = 'ev-${i}'`);
    }

    await passes(newService(), 5, { ...OPTS, batchSize: 1 });

    expect(lookups).toEqual(['live-4', 'live-3', 'live-2', 'live-1', 'live-0']);
  });

  // Replays that fail leave their row pending, so every row is retried once per walk.
  // Rows that become old enough while a walk runs belong to the next one: the walk ends, however many arrive.
  it('begins again at the oldest row when the rows it started with are done, however many arrive meanwhile', async () => {
    const small = { ...OPTS, batchSize: 5 };
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'sandbox down' });
    await insert(Array.from({ length: 10 }, (_, i) => eventRow(`ev-${i}`, `retry-${i}`, created(i))));
    const service = newService();

    for (let k = 0; k < 3; k++) {
      await service.sweep(small, at(k));
      await insert(
        Array.from({ length: 5 }, (_, i) =>
          eventRow(`ev-${10 + k * 5 + i}`, `late-${k}-${i}`, new Date(at(k).getTime() - 30_000)),
        ),
      );
    }

    expect((await events.findOneByOrFail({ id: 'ev-0' })).dispatchAttempts).toBe(2);
    expect((await events.findOneByOrFail({ id: 'ev-5' })).dispatchAttempts).toBe(1);
  });

  it('starts over at the oldest row when a plugin the walk left out has finished restoring', async () => {
    await ds
      .getRepository(PluginInstance)
      .save({ id: 'slow:inst', pluginId: 'slow', instanceId: 'inst', secret: 's', enabled: true });
    await insert([eventRow('ev-held', 'held', created(-1), 'slow'), ...liveRows(120)]);
    restoring.add('slow');
    const service = newService();
    await passes(service, 1);
    expect(replayed()).toEqual([]);

    restoring.clear();
    await passes(service, 1, OPTS, 1);

    expect(replayed()).toEqual(['held']);
  });

  it('never widens the grace window when the clock steps back during a walk', async () => {
    await insert(liveRows(90));
    const service = newService();
    await service.sweep(OPTS, at(5));
    await insert([eventRow('ev-fresh', 'fresh', new Date(at(0).getTime() - 30_000))]);
    lookups.length = 0;

    await service.sweep(OPTS, at(0));

    expect(lookups).not.toContain('fresh');
    expect(replayed()).toEqual([]);
  });
});
