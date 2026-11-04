import { DataSource } from 'typeorm';
import { RedriveService } from './redrive.service';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IngressEnqueueService } from './ingress-enqueue.service';
import type { IngressJobData } from '../queue/processors/ingress.processor';

describe('ingress redrive payload reads', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [IntegrationDeliveryFailure, IngressEvent],
      synchronize: true,
    }).initialize();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it('reads each payload only when its replay starts', async () => {
    const repo = ds.getRepository(IntegrationDeliveryFailure);
    const payload = (body: string) => ({ route: 'events', ingress: { headers: {}, query: {}, body, rawBody: body } });
    for (const [id, body] of [
      ['first', 'one'],
      ['second', 'two'],
    ]) {
      await repo.save({
        id,
        pluginId: 'plug',
        instanceId: 'inst',
        direction: 'inbound',
        sessionId: 'session',
        deliveryId: id,
        attempts: 1,
        lastError: 'unavailable',
        createdAt: new Date(id === 'first' ? 1000 : 2000),
        payload: payload(body),
      });
    }
    const bodies: string[] = [];
    const enqueue = jest.fn(async (data: IngressJobData) => {
      bodies.push(data.payload.rawBody);
      if (bodies.length === 1) await repo.update({ id: 'second' }, { payload: payload('updated') });
      return { outcome: 'queued' };
    });
    const find = jest.spyOn(repo, 'find');
    const svc = new RedriveService(repo, ds.getRepository(IngressEvent), {
      enqueue,
    } as unknown as IngressEnqueueService);

    expect(await svc.redriveInstance('plug', 'inst', 'session')).toEqual({ redriven: 2, remaining: 0, batchSize: 100 });

    expect(bodies).toEqual(['one', 'updated']);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
  });

  it.each(['deleted', 'closed', 'rebound'] as const)('skips a row %s while an earlier replay runs', async change => {
    const repo = ds.getRepository(IntegrationDeliveryFailure);
    for (const [index, id] of ['first', 'second'].entries()) {
      await repo.save({
        id,
        pluginId: 'plug',
        instanceId: 'inst',
        direction: 'inbound',
        sessionId: 'session',
        deliveryId: id,
        attempts: 1,
        lastError: 'unavailable',
        createdAt: new Date(index * 1000),
        payload: { route: 'events', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      });
    }
    const enqueue = jest.fn(async () => {
      if (change === 'deleted') await repo.delete({ id: 'second' });
      else await repo.update({ id: 'second' }, change === 'closed' ? { redriven: true } : { sessionId: 'other' });
      return { outcome: 'queued' };
    });
    const svc = new RedriveService(repo, ds.getRepository(IngressEvent), {
      enqueue,
    } as unknown as IngressEnqueueService);

    expect(await svc.redriveInstance('plug', 'inst', 'session')).toEqual({ redriven: 1, remaining: 0, batchSize: 100 });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
