import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { MAX_WEBHOOK_REDRIVE_LIMIT, WebhookRedriveService } from './webhook-redrive.service';
import { MAX_TIMER_MS } from '../../common/services/shutdown-budget';
import { recordWebhookDeliveryFailure } from './utils/record-delivery-failure';

describe('WebhookRedriveService', () => {
  let ds: DataSource;
  let failures: Repository<WebhookDeliveryFailure>;
  let webhooks: Repository<Webhook>;
  let primary: Webhook;
  let otherSession: Webhook;
  let retentionHours: number;
  let drainMs: number;
  let delivery: { redeliver: jest.MockedFunction<WebhookDeliveryService['redeliver']> };
  let service: WebhookRedriveService;

  const addFailure = (overrides: Partial<WebhookDeliveryFailure> = {}): Promise<WebhookDeliveryFailure> =>
    failures.save(
      failures.create({
        webhookId: primary.id,
        sessionId: primary.sessionId,
        event: 'message.received',
        url: primary.url,
        idempotencyKey: randomUUID(),
        deliveryId: randomUUID(),
        attempts: 3,
        lastStatusCode: 503,
        lastError: 'HTTP 503: receiver unavailable',
        payload: { id: 'msg-1', body: 'hi' },
        createdAt: new Date(Date.now() - 60_000),
        ...overrides,
      }),
    );

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    failures = ds.getRepository(WebhookDeliveryFailure);
    webhooks = ds.getRepository(Webhook);
    for (const id of ['sess-1', 'sess-2']) {
      await ds.getRepository(Session).save({ id, name: id, status: SessionStatus.READY, config: {} });
    }
    [primary, otherSession] = await webhooks.save(
      ['sess-1', 'sess-2'].map(sessionId =>
        webhooks.create({
          sessionId,
          url: `https://${sessionId}.example/h`,
          events: ['message.received'],
          active: true,
          retryCount: 3,
        }),
      ),
    );
    retentionHours = 24;
    drainMs = 5000;
    delivery = {
      redeliver: jest.fn<
        ReturnType<WebhookDeliveryService['redeliver']>,
        Parameters<WebhookDeliveryService['redeliver']>
      >(async (webhook, sessionId, event, key, data) => {
        if (data.fail === true) {
          const recorded = await recordWebhookDeliveryFailure(
            failures,
            { error: jest.fn() },
            {
              webhookId: webhook.id,
              sessionId,
              event,
              idempotencyKey: key,
              url: webhook.url,
              attempts: 1,
              lastStatusCode: 503,
              lastError: 'HTTP 503: receiver unavailable',
              payload: data,
            },
          );
          return recorded === null ? 'unrecorded' : 'failed';
        }
        await failures.delete({ webhookId: webhook.id, idempotencyKey: key });
        return 'delivered';
      }),
    };
    service = new WebhookRedriveService(
      webhooks,
      failures,
      delivery as unknown as WebhookDeliveryService,
      {
        get: (key: string) => (key === 'webhook.shutdownDrainMs' ? drainMs : retentionHours),
      } as unknown as ConfigService,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it('replays the stored payload and key with one attempt, and removes the delivered row', async () => {
    const row = await addFailure();

    expect(await service.redrive({})).toEqual({
      redriven: 1,
      delivered: 1,
      enqueued: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(delivery.redeliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: primary.id }),
      row.sessionId,
      row.event,
      row.idempotencyKey,
      row.payload,
      { singleAttempt: true },
    );
    expect(await failures.count()).toBe(0);
    expect(await service.redrive({})).toMatchObject({ delivered: 0, remaining: 0 });
  });

  it('selects eligible subscriptions before the batch limit, past more than 100 old unavailable rows', async () => {
    const disabled = await webhooks.save(webhooks.create({ ...primary, id: randomUUID(), active: false }));
    const unsubscribed = await webhooks.save(
      webhooks.create({ ...primary, id: randomUUID(), events: ['message.ack'] }),
    );
    const unavailable = [
      { webhookId: randomUUID() },
      { webhookId: disabled.id },
      { webhookId: unsubscribed.id },
      { webhookId: otherSession.id, sessionId: primary.sessionId },
    ];
    for (let i = 0; i < 104; i++) {
      await addFailure({ ...unavailable[i % unavailable.length], createdAt: new Date(Date.now() - 120_000) });
    }
    const healthy = await addFailure();

    expect(await service.redrive({})).toMatchObject({ delivered: 1, skipped: 0, remaining: 0 });
    expect(delivery.redeliver).toHaveBeenCalledTimes(1);
    expect(delivery.redeliver.mock.calls[0][3]).toBe(healthy.idempotencyKey);
    expect(await failures.count()).toBe(104);
  });

  it('moves a failed batch behind never-replayed rows', async () => {
    for (let i = 0; i < 100; i++) {
      await addFailure({ payload: { fail: true }, createdAt: new Date(Date.now() - 120_000) });
    }
    await addFailure({ payload: { healthy: 1 } });
    await addFailure({ payload: { healthy: 2 } });
    expect(await service.redrive({})).toMatchObject({ failed: 100, delivered: 0, remaining: 102 });
    expect(await service.redrive({ limit: 2 })).toMatchObject({ failed: 0, delivered: 2, remaining: 100 });
    expect(await failures.countBy({ attempts: 4 })).toBe(100);
  });

  it('requires a terminal keyed payload within the current retention window', async () => {
    await addFailure({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await addFailure({ attempts: 0 });
    await addFailure({ payload: null });
    await addFailure({ idempotencyKey: null as never });
    const fresh = await addFailure();

    expect(await service.redrive({})).toMatchObject({ delivered: 1, remaining: 0 });
    expect(delivery.redeliver.mock.calls[0][3]).toBe(fresh.idempotencyKey);
    expect(await failures.count()).toBe(4);
  });

  it('returns no replayable rows when retention is off, even before payload cleanup', async () => {
    await addFailure();
    retentionHours = 0;

    expect(await service.redrive({})).toMatchObject({ redriven: 0, remaining: 0 });
    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(await failures.count()).toBe(1);
  });

  it('narrows both delivery and remaining to the same ids, webhook and allowed sessions', async () => {
    const chosen = await addFailure();
    await addFailure();
    const outside = await addFailure({ webhookId: otherSession.id, sessionId: otherSession.sessionId });

    expect(
      await service.redrive({ ids: [chosen.id, outside.id], webhookId: primary.id }, [primary.sessionId]),
    ).toMatchObject({ delivered: 1, remaining: 0 });
    expect(delivery.redeliver).toHaveBeenCalledTimes(1);
    expect(delivery.redeliver.mock.calls[0][3]).toBe(chosen.idempotencyKey);
    expect(await failures.count()).toBe(2);
    expect(await service.redrive({ sessionId: otherSession.sessionId }, [primary.sessionId])).toMatchObject({
      redriven: 0,
      remaining: 0,
    });
    expect(await service.redrive({ webhookId: otherSession.id }, [primary.sessionId])).toMatchObject({
      redriven: 0,
      remaining: 0,
    });
    expect(await service.redrive({ ids: [] })).toMatchObject({ redriven: 0, remaining: 0 });
    expect(delivery.redeliver).toHaveBeenCalledTimes(1);
    expect(await service.redrive({ sessionId: otherSession.sessionId }, null)).toMatchObject({
      delivered: 1,
      remaining: 0,
    });
  });

  it('allows wildcard subscriptions to replay another event', async () => {
    await webhooks.update(primary.id, { events: ['*'] });
    await addFailure({ event: 'session.disconnected' });

    expect(await service.redrive({})).toMatchObject({ delivered: 1, remaining: 0 });
    expect(delivery.redeliver.mock.calls[0][2]).toBe('session.disconnected');
  });

  it('matches exact event members and ignores non-array subscriptions', async () => {
    await webhooks.update(primary.id, { events: ['message.received.extra'] });
    await addFailure();
    const malformed = await webhooks.save(
      webhooks.create({ ...primary, id: randomUUID(), events: { event: 'message.received' } as never }),
    );
    await addFailure({ webhookId: malformed.id });

    expect(await service.redrive({})).toMatchObject({ redriven: 0, remaining: 0 });
    expect(delivery.redeliver).not.toHaveBeenCalled();
    const exact = await addFailure({ event: 'message.received.extra' });
    expect(await service.redrive({})).toMatchObject({ delivered: 1, remaining: 0 });
    expect(delivery.redeliver.mock.calls[0][3]).toBe(exact.idempotencyKey);
  });

  it('supports unrestricted redrive with more than 1000 active webhooks', async () => {
    const ids = Array.from({ length: 1001 }, () => randomUUID());
    await webhooks
      .createQueryBuilder()
      .insert()
      .values(ids.map(id => ({ id, sessionId: primary.sessionId, url: primary.url, events: ['message.received'] })))
      .updateEntity(false)
      .execute();
    const row = await addFailure({ webhookId: ids.at(-1) });

    expect(await service.redrive({})).toMatchObject({ delivered: 1, remaining: 0 });
    expect(delivery.redeliver.mock.calls[0][3]).toBe(row.idempotencyKey);
  });

  it('orders equal-attempt rows by creation time and id', async () => {
    const older = new Date(Date.now() - 120_000);
    const first = await addFailure({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: older,
      payload: { fail: true },
    });
    const second = await addFailure({
      id: '00000000-0000-4000-8000-000000000002',
      createdAt: older,
      payload: { fail: true },
    });
    await addFailure();

    expect(await service.redrive({ limit: 2 })).toMatchObject({ failed: 2, remaining: 3 });
    expect(delivery.redeliver.mock.calls.map(call => call[3])).toEqual([first.idempotencyKey, second.idempotencyKey]);
  });

  it('clamps an internal request to the maximum batch', async () => {
    for (let i = 0; i <= MAX_WEBHOOK_REDRIVE_LIMIT; i++) await addFailure({ payload: { fail: true } });

    expect(await service.redrive({ limit: 10_000 })).toMatchObject({
      failed: MAX_WEBHOOK_REDRIVE_LIMIT,
      remaining: MAX_WEBHOOK_REDRIVE_LIMIT + 1,
    });
    expect(delivery.redeliver).toHaveBeenCalledTimes(MAX_WEBHOOK_REDRIVE_LIMIT);
  });

  it('counts legacy enqueued and cancelled outcomes, and increments a rejected replay', async () => {
    await addFailure();
    await addFailure();
    await addFailure();
    delivery.redeliver
      .mockResolvedValueOnce('enqueued')
      .mockResolvedValueOnce('cancelled')
      .mockRejectedValueOnce(new Error('receiver failed'));

    expect(await service.redrive({})).toMatchObject({ redriven: 1, enqueued: 1, failed: 1, skipped: 1, remaining: 3 });
    expect(await failures.countBy({ attempts: 4 })).toBe(1);
  });

  it('continues the batch when recording a failed replay fails', async () => {
    await addFailure({ payload: { fail: true }, createdAt: new Date(Date.now() - 120_000) });
    await addFailure();
    jest.spyOn(failures, 'update').mockRejectedValueOnce(new Error('database unavailable'));
    jest.spyOn(failures, 'increment').mockRejectedValueOnce(new Error('database unavailable'));

    expect(await service.redrive({})).toMatchObject({ failed: 1, delivered: 1, remaining: 1 });
  });

  it('serializes overlapping calls and keeps the chain usable after a failed batch', async () => {
    await addFailure();
    jest.spyOn(failures, 'createQueryBuilder').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    await expect(service.redrive({})).rejects.toThrow('database unavailable');
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const deliver = delivery.redeliver.getMockImplementation()!;
    delivery.redeliver.mockImplementationOnce(async (...args) => {
      await gate;
      return deliver(...args);
    });

    const first = service.redrive({});
    const second = service.redrive({});
    await new Promise(resolve => setImmediate(resolve));
    expect(delivery.redeliver).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ delivered: 1, remaining: 0 });
    expect(await second).toMatchObject({ delivered: 0, remaining: 0 });
    expect(delivery.redeliver).toHaveBeenCalledTimes(1);
  });

  it('bounds parallel direct replays to four', async () => {
    for (let i = 0; i < 10; i++) await addFailure();
    const deliver = delivery.redeliver.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    delivery.redeliver.mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      const outcome = await deliver(...args);
      active--;
      return outcome;
    });

    expect(await service.redrive({})).toMatchObject({ delivered: 10, remaining: 0 });
    expect(peak).toBe(4);
  });

  it('stops a batch at shutdown and waits for the replays in hand', async () => {
    for (let i = 0; i < 6; i++) await addFailure();
    const deliver = delivery.redeliver.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let inHand!: () => void;
    const fourInHand = new Promise<void>(resolve => (inHand = resolve));
    delivery.redeliver.mockImplementation(async (...args) => {
      if (delivery.redeliver.mock.calls.length === 4) inHand();
      await gate;
      return deliver(...args);
    });

    const batch = service.redrive({});
    await fourInHand;
    // The batch has read its rows; a call queued behind it must read none.
    const select = jest.spyOn(SelectQueryBuilder.prototype, 'getMany');
    const queued = service.redrive({});
    let destroyed = false;
    const destroy = service.onModuleDestroy().then(() => (destroyed = true));
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    expect(destroyed).toBe(false);

    release();
    await destroy;
    expect(await batch).toMatchObject({ delivered: 4, remaining: 2 });
    expect(await queued).toMatchObject({ delivered: 0, remaining: 2 });
    expect(select).not.toHaveBeenCalled();
    expect(delivery.redeliver).toHaveBeenCalledTimes(4);
  });

  describe('shutdown wait bound', () => {
    const holdReplay = async (): Promise<() => void> => {
      await addFailure();
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      const deliver = delivery.redeliver.getMockImplementation()!;
      delivery.redeliver.mockImplementation(async (...args) => {
        await gate;
        return deliver(...args);
      });
      void service.redrive({});
      await new Promise(resolve => setImmediate(resolve));
      expect(delivery.redeliver).toHaveBeenCalledTimes(1);
      return release;
    };

    it('stops waiting for a replay that never settles after WEBHOOK_SHUTDOWN_DRAIN_MS and logs it', async () => {
      drainMs = 30;
      const release = await holdReplay();
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      const startedAt = Date.now();

      await service.onModuleDestroy();

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('redrive still running'),
        expect.objectContaining({ action: 'webhook_redrive_shutdown_timeout', waitMs: 30 }),
      );
      release();
    });

    it('caps the wait at the largest timer delay when the drain exceeds it', async () => {
      drainMs = 2 ** 31 + 1000;
      const release = await holdReplay();
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      const destroy = service.onModuleDestroy();
      release();
      await destroy;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_MS, false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns without waiting when the drain is 0', async () => {
      drainMs = 0;
      const release = await holdReplay();
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      await service.onModuleDestroy();

      expect(warn).toHaveBeenCalledTimes(1);
      release();
    });

    it('resolves as soon as the replay settles and logs nothing', async () => {
      drainMs = 60_000;
      const release = await holdReplay();
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const destroy = service.onModuleDestroy();
      release();
      await destroy;

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
