import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookRedriveService } from './webhook-redrive.service';
import { WebhookService } from './webhook.service';

// The redrive replays a row only to the webhook it was recorded for, while that webhook still belongs to the row's
// session. A webhook that was disabled or unsubscribed can be switched back and its rows redriven; a deleted one cannot
// come back (ids are generated), so its rows must not be listed as replayable.
describe('delivery-failure replayable flag', () => {
  let ds: DataSource;
  let failures: Repository<WebhookDeliveryFailure>;
  let webhooks: Repository<Webhook>;
  let listing: WebhookService;
  let redrive: WebhookRedriveService;
  let redeliver: jest.Mock;
  let hook: Webhook;
  let row: WebhookDeliveryFailure;

  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'webhook.failurePayloadRetentionHours' ? 24 : key === 'webhook.shutdownDrainMs' ? 5000 : fallback,
  } as unknown as ConfigService;

  const addFailure = (overrides: Partial<WebhookDeliveryFailure> = {}): Promise<WebhookDeliveryFailure> =>
    failures.save(
      failures.create({
        webhookId: hook.id,
        sessionId: 'sess-1',
        event: 'message.received',
        url: hook.url,
        idempotencyKey: randomUUID(),
        deliveryId: randomUUID(),
        attempts: 3,
        lastStatusCode: 503,
        lastError: 'HTTP 503: receiver unavailable',
        payload: { id: 'msg-1', body: 'hi' },
        ...overrides,
      }),
    );

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    failures = ds.getRepository(WebhookDeliveryFailure);
    webhooks = ds.getRepository(Webhook);
    await ds.getRepository(Session).save({ id: 'sess-1', name: 'sess-1', status: SessionStatus.READY, config: {} });
    hook = await webhooks.save(
      webhooks.create({
        sessionId: 'sess-1',
        url: 'https://receiver.example/h',
        events: ['message.received'],
        active: true,
        retryCount: 3,
      }),
    );
    row = await addFailure();
    listing = new WebhookService(webhooks, failures, {} as never, config, {} as never);
    // A delivered replay clears the rows of its key, as the real delivery path does.
    redeliver = jest.fn(async (webhook: Webhook, _session: string, _event: string, key: string) => {
      await failures.delete({ webhookId: webhook.id, idempotencyKey: key });
      return 'delivered';
    });
    redrive = new WebhookRedriveService(webhooks, failures, { redeliver } as unknown as WebhookDeliveryService, config);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  const listed = async (id: string): Promise<boolean | undefined> =>
    (await listing.listDeliveryFailures({}, null)).find(r => r.id === id)?.replayable;

  it('flags a row of an active, subscribed webhook replayable, and the redrive replays it', async () => {
    expect(await listed(row.id)).toBe(true);
    expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 1, remaining: 0 });
  });

  it.each([
    ['disabled', () => webhooks.update(hook.id, { active: false })],
    ['unsubscribed from the event', () => webhooks.update(hook.id, { events: ['message.ack'] })],
  ])(
    'keeps a row replayable while its webhook is only %s, so switching it back lets the redrive take it',
    async (_, change) => {
      await change();

      expect(await listed(row.id)).toBe(true);
      expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 0, skipped: 0, remaining: 0 });

      await webhooks.update(hook.id, { active: true, events: ['message.received'] });
      expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 1 });
    },
  );

  it('does not flag a row replayable once its webhook is deleted', async () => {
    await webhooks.delete(hook.id);

    expect(await listed(row.id)).toBe(false);
    expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 0, remaining: 0 });
    expect(redeliver).not.toHaveBeenCalled();
  });

  it('does not flag a row replayable when its webhook belongs to another session', async () => {
    const foreign = await addFailure({ sessionId: 'sess-2' });

    expect(await listed(foreign.id)).toBe(false);
    expect(await listed(row.id)).toBe(true);
  });

  it('reads the webhooks of a page once, and not at all when no row holds a payload', async () => {
    await addFailure();
    const find = jest.spyOn(webhooks, 'find');

    await listing.listDeliveryFailures({}, null);
    expect(find).toHaveBeenCalledTimes(1);

    find.mockClear();
    await failures.update({ webhookId: hook.id }, { payload: null });
    expect((await listing.listDeliveryFailures({}, null)).every(r => !r.replayable)).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });
});
