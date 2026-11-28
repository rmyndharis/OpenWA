import { randomUUID } from 'node:crypto';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { RedriveService } from './redrive.service';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { EnqueueOutcome, IngressEnqueueService } from './ingress-enqueue.service';
import { LoggerService } from '../../common/services/logger.service';
import { postgresUtcExtra } from '../../database/postgres-utc';

const pg = process.env.DATABASE_TYPE === 'postgres';
const CLAIM_EXPIRY_MS = 5 * 60_000;

/**
 * A redrive takes a dead letter before it dispatches it, so another redrive does not send it as well. A take that is
 * never settled (the node stopped before the dispatch, the database would not put a failed one back, or would not
 * retire one that went out) is taken again by a later redrive once five minutes have passed, under the same delivery
 * id, which the receiving handler keys its side effects on. Real database (SQLite, and PostgreSQL when
 * DATABASE_TYPE=postgres); only the clock is faked.
 */
describe('RedriveService and a take that was never settled', () => {
  let ds: DataSource;
  let failures: Repository<IntegrationDeliveryFailure>;
  let events: Repository<IngressEvent>;
  let schema: string;
  const entities = [IntegrationDeliveryFailure, IngressEvent];

  beforeEach(async () => {
    if (pg) {
      schema = `redrive_claim_${randomUUID().replace(/-/g, '')}`;
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
    failures = ds.getRepository(IntegrationDeliveryFailure);
    events = ds.getRepository(IngressEvent);
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (pg) await ds.query(`DROP SCHEMA "${schema}" CASCADE`);
    await ds.destroy();
  });

  /** A dead letter of delivery `deliveryId`, by its id. */
  const seed = async (deliveryId: string) =>
    (
      await failures.save({
        direction: 'inbound',
        pluginId: 'plug',
        instanceId: 'inst',
        sessionId: 'session',
        deliveryId,
        attempts: 1,
        lastError: 'unavailable',
        payload: { route: 'events', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      })
    ).id;

  const service = (enqueue: jest.Mock) =>
    new RedriveService(failures, events, { enqueue } as unknown as IngressEnqueueService);

  const redrive = (svc: RedriveService) => svc.redriveInstance('plug', 'inst', 'session');

  /** Refuses, once, the dead-letter writes `match` picks; every other write goes through. */
  const refuseOnce = (match: (criteria: object, partial: object) => boolean, error: Error) => {
    const update = failures.update.bind(failures) as (criteria: object, partial: object) => Promise<unknown>;
    let refused = false;
    jest.spyOn(failures, 'update').mockImplementation(((criteria: object, partial: object) => {
      if (!refused && match(criteria, partial)) {
        refused = true;
        return Promise.reject(error);
      }
      return update(criteria, partial);
    }) as never);
  };

  const afterExpiry = () => jest.setSystemTime(Date.now() + CLAIM_EXPIRY_MS + 1);

  /** A redrive that has taken the row and waits in its dispatch until it is finished. */
  const stalledRedrive = async () => {
    let reached!: () => void;
    const taken = new Promise<void>(resolve => (reached = resolve));
    let finish!: (outcome: EnqueueOutcome) => void;
    const run = redrive(
      service(
        jest.fn(() => {
          reached();
          return new Promise<EnqueueOutcome>(resolve => (finish = resolve));
        }),
      ),
    );
    await taken;
    return { run, finish: (outcome: EnqueueOutcome) => finish(outcome) };
  };

  it('leaves a take alone until it is five minutes old, then takes it back', async () => {
    await seed('d4');
    const takenAt = Date.now();
    const stalled = await stalledRedrive();
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    const enqueue = jest.fn().mockResolvedValue({ outcome: 'dispatched' });
    const other = service(enqueue);

    for (const elapsed of [60_001, CLAIM_EXPIRY_MS - 1]) {
      jest.setSystemTime(takenAt + elapsed);
      await expect(redrive(other)).resolves.toEqual({ redriven: 0, remaining: 1, batchSize: 100 });
    }
    jest.setSystemTime(takenAt + CLAIM_EXPIRY_MS);
    await expect(redrive(other)).resolves.toEqual({ redriven: 1, remaining: 0, batchSize: 100 });
    expect(enqueue).toHaveBeenCalledTimes(1);

    stalled.finish({ outcome: 'queued' });
    await stalled.run;
  });

  it('takes back a delivery whose redrive stopped between taking it and dispatching it', async () => {
    const id = await seed('d1');
    // A live-path inline failure left the delivery's event pending, with the request the reconciler would replay.
    const ingress = { headers: {}, query: {}, body: '{}', rawBody: '{}' };
    await events.save({
      id: randomUUID(),
      pluginId: 'plug',
      instanceId: 'inst',
      providerDeliveryId: 'd1',
      route: 'events',
      sessionId: 'session',
      payload: ingress,
      dispatchState: 'pending',
    });
    const takenAt = Date.now();
    let reached!: () => void;
    const taken = new Promise<void>(resolve => (reached = resolve));
    let release!: (outcome: EnqueueOutcome) => void;
    const stalled = service(
      jest.fn(() => {
        reached();
        return new Promise<EnqueueOutcome>(resolve => (release = resolve));
      }),
    );
    const stalledRun = redrive(stalled);
    await taken;
    const warned = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    // The node holding it stops here; another one redrives the instance.
    const enqueue = jest.fn().mockResolvedValue({ outcome: 'dispatched' });
    const other = service(enqueue);

    await expect(redrive(other)).resolves.toEqual({ redriven: 0, remaining: 1, batchSize: 100 });
    expect(enqueue).not.toHaveBeenCalled();

    afterExpiry();
    await expect(redrive(other)).resolves.toEqual({ redriven: 1, remaining: 0, batchSize: 100 });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'd1' }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('never settled'),
      expect.objectContaining({
        id,
        deliveryId: 'd1',
        claimedAt: new Date(takenAt).toISOString(),
        action: 'ingress_redrive_claim_expired',
      }),
    );
    // The stopped redrive kept the event from the reconciler; once the delivery went out, its copy of the request goes.
    expect(await events.findOneByOrFail({ providerDeliveryId: 'd1' })).toMatchObject({
      dispatchState: 'dispatched',
      payload: null,
    });

    release({ outcome: 'queued' });
    await stalledRun;
  });

  // Read anyway, a row another redrive took after this one read its window would be held and dispatched here once that
  // take was put back, under a warning that a take was never settled.
  it('leaves a row another redrive took after its window was read, even once that take is put back', async () => {
    await seed('d5');
    await events.save({
      id: randomUUID(),
      pluginId: 'plug',
      instanceId: 'inst',
      providerDeliveryId: 'd5',
      route: 'events',
      sessionId: 'session',
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      dispatchState: 'pending',
    });
    const warned = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    let reachRowRead!: () => void;
    const atRowRead = new Promise<void>(resolve => (reachRowRead = resolve));
    let readRow!: () => void;
    const rowReadAllowed = new Promise<void>(resolve => (readRow = resolve));
    let rowWasRead!: () => void;
    const rowRead = new Promise<void>(resolve => (rowWasRead = resolve));
    let allowEventWrites!: () => void;
    const eventWritesAllowed = new Promise<void>(resolve => (allowEventWrites = resolve));
    // The late redrive's row read and event writes wait for the test; its window read does not.
    const lateFailures = Object.create(failures) as Repository<IntegrationDeliveryFailure>;
    lateFailures.findOneBy = async where => {
      reachRowRead();
      await rowReadAllowed;
      const row = await failures.findOneBy(where);
      rowWasRead();
      return row;
    };
    const lateEvents = Object.create(events) as Repository<IngressEvent>;
    lateEvents.update = async (criteria: object, partial: object) => {
      await eventWritesAllowed;
      return events.update(criteria, partial);
    };
    const enqueue = jest.fn().mockResolvedValue({ outcome: 'dispatched' });
    const late = new RedriveService(lateFailures, lateEvents, { enqueue } as unknown as IngressEnqueueService);

    const lateRun = redrive(late);
    await atRowRead;
    const other = await stalledRedrive();
    readRow();
    await rowRead;
    other.finish({ outcome: 'failed', error: 'plugin unavailable' });
    await expect(other.run).resolves.toEqual({ redriven: 0, remaining: 1, batchSize: 100 });
    allowEventWrites();

    await expect(lateRun).resolves.toEqual({ redriven: 0, remaining: 1, batchSize: 100 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ingress_redrive_claim_expired' }),
    );
  });

  it('takes back a delivery whose failed dispatch the database would not put back', async () => {
    await seed('d2');
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ outcome: 'failed', error: 'plugin unavailable' })
      .mockResolvedValue({ outcome: 'dispatched' });
    const svc = service(enqueue);
    const refused = new Error('Connection terminated unexpectedly');
    refuseOnce((_criteria, partial) => 'lastError' in partial, refused);
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);

    await expect(redrive(svc)).rejects.toBe(refused);
    await expect(redrive(svc)).resolves.toEqual({ redriven: 0, remaining: 1, batchSize: 100 });

    afterExpiry();
    await expect(redrive(svc)).resolves.toEqual({ redriven: 1, remaining: 0, batchSize: 100 });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('dispatches again, under the same delivery id, one that went out but could not be retired', async () => {
    const id = await seed('d3');
    const enqueue = jest.fn().mockResolvedValue({ outcome: 'dispatched' });
    const svc = service(enqueue);
    refuseOnce(
      (criteria, partial) => (partial as { redriven?: boolean }).redriven === true && !('redriven' in criteria),
      new Error('Connection terminated unexpectedly'),
    );
    const warned = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);

    await expect(redrive(svc)).resolves.toEqual({ redriven: 1, remaining: 1, batchSize: 100 });
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('could not be retired'),
      expect.objectContaining({
        id,
        deliveryId: 'd3',
        error: 'Connection terminated unexpectedly',
        action: 'ingress_redrive_retire_failed',
      }),
    );
    // Not again while its take is fresh: another redrive leaves it to the one that took it.
    await expect(redrive(svc)).resolves.toEqual({ redriven: 0, remaining: 1, batchSize: 100 });

    afterExpiry();
    await expect(redrive(svc)).resolves.toEqual({ redriven: 1, remaining: 0, batchSize: 100 });
    const ids = (enqueue.mock.calls as [{ deliveryId: string }][]).map(([data]) => data.deliveryId);
    expect(ids).toEqual(['d3', 'd3']);
  });
});
