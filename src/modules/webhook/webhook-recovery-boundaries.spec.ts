import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Response } from 'undici';
import { HookManager } from '../../core/hooks';
import * as ssrf from '../../common/security/ssrf-guard';
import { Session } from '../session/entities/session.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookReconcilerService } from './webhook-reconciler.service';
import { WebhookRedriveService } from './webhook-redrive.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

describe('webhook recovery across live ownership and configuration changes', () => {
  let ds: DataSource;
  let webhooks: Repository<Webhook>;
  let failures: Repository<WebhookDeliveryFailure>;
  let primary: Webhook;
  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure, WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
    for (const id of ['s1', 's2']) await ds.getRepository(Session).save({ id, name: id });
    webhooks = ds.getRepository(Webhook);
    failures = ds.getRepository(WebhookDeliveryFailure);
    primary = await webhooks.save({
      sessionId: 's1',
      url: 'https://old.example',
      events: ['message.received'],
      active: true,
      retryCount: 1,
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it('walks past live jobs, handles equal timestamps, and wraps after a deleted cursor row', async () => {
    const repository = ds.getRepository(WebhookOutboxEvent);
    const outbox = new WebhookOutboxService(repository);
    for (let i = 0; i < 5; i++) {
      await outbox.open({
        webhookId: primary.id,
        sessionId: primary.sessionId,
        event: 'message.received',
        idempotencyKey: `key${i}`,
        deliveryId: `job${i}`,
        payload: { id: i },
      });
      await repository.update({ idempotencyKey: `key${i}` }, { id: `row${i}`, createdAt: new Date('2026-10-01') });
      if (i !== 4) await outbox.markQueued(primary.id, `key${i}`, `job${i}`);
    }
    const delivery = {
      isLocallyPending: jest.fn((key: string) => key === 'key0'),
      isQueueJobPending: jest.fn((id: string) => Promise.resolve(id === 'job1' || id === 'job2')),
      redeliver: jest.fn().mockResolvedValue('delivered'),
      recordReplayExhaustion: jest.fn().mockResolvedValue(true),
    };
    const reconciler = new WebhookReconcilerService(webhooks, outbox, delivery as never);
    const options = { intervalMs: 1000, graceMs: 0, batchSize: 2, maxAttempts: 5 };
    for (let i = 0; i < 3; i++) expect((await reconciler.sweep(options)).scanned).toBeLessThanOrEqual(2);
    expect(delivery.redeliver.mock.calls.map((call: unknown[]) => call[3])).toEqual(['key3', 'key4']);
    await repository.delete('row4');
    // A newly stranded row earlier than the cursor becomes reachable on the next cycle.
    delivery.isLocallyPending.mockReturnValue(false);
    await reconciler.sweep(options);
    expect(delivery.redeliver.mock.calls.map((call: unknown[]) => call[3])).toContain('key0');
    expect((await repository.findOneByOrFail({ id: 'row3' })).state).toBe('dispatched');
  });

  it.each(['disable', 'delete', 'unsubscribe', 'move-session', 'rotate'] as const)(
    'uses the current receiver for each redrive after a %s',
    async change => {
      for (let i = 0; i < 5; i++)
        await failures.save({
          webhookId: primary.id,
          sessionId: primary.sessionId,
          event: 'message.received',
          url: primary.url,
          idempotencyKey: `key${i}`,
          deliveryId: randomUUID(),
          attempts: 1,
          lastError: 'HTTP 503',
          payload: { id: i },
          createdAt: new Date(Date.now() - 10000 + i),
        });
      const config = new ConfigService({ webhook: { failurePayloadRetentionHours: 24, timeout: 1000 } });
      const delivery = new WebhookDeliveryService(
        webhooks,
        failures,
        config,
        new HookManager(),
        new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent)),
      );
      const redrive = new WebhookRedriveService(webhooks, failures, delivery, config);
      let release!: () => void;
      const held = new Promise<void>(resolve => (release = resolve));
      let called = 0;
      const post = jest.spyOn(ssrf, 'withSafeFetch').mockImplementation(async (_url, _init, use) => {
        called++;
        if (called <= 4) await held;
        return use(new Response(null, { status: 200 }));
      });
      const running = redrive.redrive({});
      for (let i = 0; i < 100 && called < 4; i++) await new Promise(resolve => setImmediate(resolve));
      expect(called).toBe(4);
      if (change === 'delete') await webhooks.delete(primary.id);
      else
        await webhooks.update(
          primary.id,
          change === 'disable'
            ? { active: false }
            : change === 'unsubscribe'
              ? { events: ['message.ack'] }
              : change === 'move-session'
                ? { sessionId: 's2' }
                : { url: 'https://new.example', secret: 'new-secret', headers: { Authorization: 'new-token' } },
        );
      release();
      expect(await running).toMatchObject(
        change === 'rotate' ? { delivered: 5, skipped: 0 } : { delivered: 4, skipped: 1 },
      );
      if (change === 'rotate') {
        const [url, init] = post.mock.calls[4];
        expect(typeof init.body).toBe('string');
        expect(url).toBe('https://new.example');
        expect(init.headers).toMatchObject({
          Authorization: 'new-token',
          'X-OpenWA-Signature': `sha256=${createHmac('sha256', 'new-secret')
            .update(init.body as string)
            .digest('hex')}`,
        });
      } else {
        expect(post).toHaveBeenCalledTimes(4);
        expect(await failures.count()).toBe(1);
      }
    },
  );

  it('retires the outbox copy when a redrive delivers, so the next sweep sends nothing', async () => {
    const config = new ConfigService({ webhook: { failurePayloadRetentionHours: 24, timeout: 1000, retryDelay: 1 } });
    const repository = ds.getRepository(WebhookOutboxEvent);
    const outbox = new WebhookOutboxService(repository);
    const delivery = new WebhookDeliveryService(webhooks, failures, config, new HookManager(), outbox);
    const reconciler = new WebhookReconcilerService(webhooks, outbox, delivery);
    const redrive = new WebhookRedriveService(webhooks, failures, delivery, config);
    const options = { intervalMs: 1000, graceMs: 0, batchSize: 50, maxAttempts: 5 };
    // A dispatch interrupted before it settled leaves its row pending for the sweep.
    await outbox.open({
      webhookId: primary.id,
      sessionId: primary.sessionId,
      event: 'message.received',
      idempotencyKey: 'stranded-key',
      deliveryId: 'job0',
      payload: { id: 'MSG1' },
    });
    await repository.update({ idempotencyKey: 'stranded-key' }, { createdAt: new Date(Date.now() - 60_000) });
    let status = 503;
    const post = jest
      .spyOn(ssrf, 'withSafeFetch')
      .mockImplementation((_url, _init, use) => Promise.resolve(use(new Response(null, { status }))));

    // The sweep's replay fails: the row stays pending and a redrivable failure row is filed.
    expect(await reconciler.sweep(options)).toMatchObject({ scanned: 1, failed: 1 });
    expect(await failures.count({ where: { idempotencyKey: 'stranded-key' } })).toBe(1);

    status = 200;
    expect(await redrive.redrive({})).toMatchObject({ delivered: 1, failed: 0 });
    expect(await failures.count()).toBe(0);
    const row = await repository.findOneByOrFail({ idempotencyKey: 'stranded-key' });
    expect(row.state).toBe('dispatched');
    expect(row.payload).toBeNull();

    expect(await reconciler.sweep(options)).toMatchObject({ scanned: 0 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('rechecks the receiver after a held webhook hook before the first POST', async () => {
    const config = new ConfigService({ webhook: { failurePayloadRetentionHours: 24 } });
    const hooks = new HookManager();
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    jest.spyOn(hooks, 'execute').mockImplementation(async (_event, data) => {
      await held;
      return { continue: true, data };
    });
    const delivery = new WebhookDeliveryService(
      webhooks,
      failures,
      config,
      hooks,
      new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent)),
    );
    const post = jest
      .spyOn(ssrf, 'withSafeFetch')
      .mockImplementation((_url, _init, use) => Promise.resolve(use(new Response(null, { status: 200 }))));
    const running = delivery.redeliver(
      primary,
      primary.sessionId,
      'message.received',
      'held-key',
      {},
      { singleAttempt: true },
    );
    await webhooks.update(primary.id, { active: false });
    release();
    expect(await running).toBe('cancelled');
    expect(post).not.toHaveBeenCalled();
    expect(await failures.count()).toBe(0);
  });
});
