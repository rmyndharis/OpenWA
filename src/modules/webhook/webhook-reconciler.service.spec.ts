import { WebhookReconcilerService, resolveWebhookReconcilerOptions } from './webhook-reconciler.service';
import { ReplayableDelivery } from './webhook-outbox.service';

const OPTS = { intervalMs: 60_000, graceMs: 60_000, batchSize: 50, maxAttempts: 3 };

const row = (over: Partial<ReplayableDelivery> = {}): ReplayableDelivery => ({
  id: 'row-1',
  webhookId: 'wh-1',
  sessionId: 'sess-1',
  event: 'message.received',
  idempotencyKey: 'stored-key_wh-1',
  payload: { from: '628123456789@c.us' },
  attempts: 0,
  ...over,
});

describe('resolveWebhookReconcilerOptions', () => {
  it('defaults, and treats a non-positive interval as disabled', () => {
    expect(resolveWebhookReconcilerOptions({})).toEqual({
      intervalMs: 60_000,
      graceMs: 60_000,
      batchSize: 50,
      maxAttempts: 5,
    });
    expect(resolveWebhookReconcilerOptions({ WEBHOOK_RECONCILE_INTERVAL_MS: '0' }).intervalMs).toBe(0);
  });

  it('rejects a batch size or attempt budget that is not a positive integer', () => {
    const opts = resolveWebhookReconcilerOptions({
      WEBHOOK_RECONCILE_BATCH_SIZE: '0',
      WEBHOOK_RECONCILE_MAX_ATTEMPTS: 'abc',
    });
    expect(opts.batchSize).toBe(50);
    expect(opts.maxAttempts).toBe(5);
  });
});

describe('WebhookReconcilerService', () => {
  let outbox: { findStale: jest.Mock; close: jest.Mock; countAttempt: jest.Mock };
  let delivery: { redeliver: jest.Mock };
  let webhooks: { findOne: jest.Mock };
  let service: WebhookReconcilerService;

  beforeEach(() => {
    outbox = {
      findStale: jest.fn().mockResolvedValue([]),
      close: jest.fn(),
      // Resolves TRUE by default: the count doubles as the row claim, and these tests exercise the
      // winning-node path unless they say otherwise.
      countAttempt: jest.fn().mockResolvedValue(true),
    };
    delivery = { redeliver: jest.fn().mockResolvedValue(undefined) };
    webhooks = { findOne: jest.fn().mockResolvedValue({ id: 'wh-1', active: true }) };
    service = new WebhookReconcilerService(webhooks as never, outbox as never, delivery as never);
  });

  it('replays a stranded delivery with the STORED idempotency key', async () => {
    outbox.findStale.mockResolvedValue([row()]);

    const stats = await service.sweep(OPTS);

    // Deriving a fresh key would make the replay read as a second event at the receiver rather than
    // a retry of the first, which is the whole reason the key is stored rather than recomputed.
    expect(delivery.redeliver).toHaveBeenCalledWith(
      { id: 'wh-1', active: true },
      'sess-1',
      'message.received',
      'stored-key_wh-1',
      { from: '628123456789@c.us' },
    );
    expect(outbox.close).toHaveBeenCalledWith('wh-1', 'stored-key_wh-1', 'dispatched');
    expect(stats).toMatchObject({ scanned: 1, replayed: 1 });
  });

  it('counts the attempt BEFORE replaying, so a delivery that always throws still exhausts its budget', async () => {
    outbox.findStale.mockResolvedValue([row({ attempts: 1 })]);
    delivery.redeliver.mockRejectedValue(new Error('receiver down'));

    const stats = await service.sweep(OPTS);

    expect(outbox.countAttempt).toHaveBeenCalledWith('row-1', 1);
    expect(outbox.countAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      delivery.redeliver.mock.invocationCallOrder[0],
    );
    // Left pending on purpose: the next sweep picks it up again until the budget runs out.
    expect(outbox.close).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ replayed: 0, failed: 1 });
  });

  it('stops replaying once the budget is spent instead of looping forever', async () => {
    outbox.findStale.mockResolvedValue([row({ attempts: 3 })]);

    const stats = await service.sweep(OPTS);

    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).toHaveBeenCalledWith('wh-1', 'stored-key_wh-1', 'failed');
    expect(stats).toMatchObject({ failed: 1, replayed: 0 });
  });

  it('does not replay to a subscription that is gone or switched off', async () => {
    outbox.findStale.mockResolvedValue([row()]);
    webhooks.findOne.mockResolvedValue({ id: 'wh-1', active: false });

    const stats = await service.sweep(OPTS);

    // Replaying here would deliver an event the operator has already unsubscribed from.
    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).toHaveBeenCalledWith('wh-1', 'stored-key_wh-1', 'failed');
    expect(stats).toMatchObject({ skipped: 1 });
  });

  it('never stacks a second pass on top of a slow one', async () => {
    let release: () => void = () => {};
    outbox.findStale.mockImplementation(
      () => new Promise<ReplayableDelivery[]>(resolve => (release = () => resolve([]))),
    );

    const first = service.sweep(OPTS);
    const second = await service.sweep(OPTS);
    release();
    await first;

    expect(second).toEqual({ scanned: 0, replayed: 0, failed: 0, skipped: 0 });
    expect(outbox.findStale).toHaveBeenCalledTimes(1);
  });

  it('does not start a timer when the interval disables it', () => {
    const prev = process.env.WEBHOOK_RECONCILE_INTERVAL_MS;
    process.env.WEBHOOK_RECONCILE_INTERVAL_MS = '0';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      service.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.WEBHOOK_RECONCILE_INTERVAL_MS;
      else process.env.WEBHOOK_RECONCILE_INTERVAL_MS = prev;
    }
  });
});
