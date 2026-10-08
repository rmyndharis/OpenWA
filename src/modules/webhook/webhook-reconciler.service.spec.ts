import { ConfigService } from '@nestjs/config';
import { WebhookReconcilerService, resolveWebhookReconcilerOptions } from './webhook-reconciler.service';
import { ReplayableDelivery } from './webhook-outbox.service';
import { MAX_TIMER_MS } from '../../config/configuration';

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
  let delivery: {
    redeliver: jest.Mock;
    isLocallyPending: jest.Mock;
    recordReplayExhaustion: jest.Mock;
    isQueueJobPending: jest.Mock;
  };
  let webhooks: { findOne: jest.Mock };
  let service: WebhookReconcilerService;

  beforeEach(() => {
    outbox = {
      findStale: jest.fn().mockResolvedValue([]),
      close: jest.fn(),
      countAttempt: jest.fn().mockResolvedValue(true),
    };
    delivery = {
      redeliver: jest.fn().mockResolvedValue('delivered'),
      recordReplayExhaustion: jest.fn().mockResolvedValue(true),
      isQueueJobPending: jest.fn().mockResolvedValue(false),
      isLocallyPending: jest.fn().mockReturnValue(false),
    };
    webhooks = {
      findOne: jest.fn().mockResolvedValue({ id: 'wh-1', sessionId: 'sess-1', active: true, events: ['*'] }),
    };
    service = new WebhookReconcilerService(webhooks as never, outbox as never, delivery as never, new ConfigService());
  });

  it('replays a stranded delivery with the STORED idempotency key', async () => {
    outbox.findStale.mockResolvedValue([row()]);

    const stats = await service.sweep(OPTS);

    // Deriving a fresh key would make the replay read as a second event at the receiver rather than
    // a retry of the first, which is the whole reason the key is stored rather than recomputed.
    expect(delivery.redeliver).toHaveBeenCalledWith(
      { id: 'wh-1', sessionId: 'sess-1', active: true, events: ['*'] },
      'sess-1',
      'message.received',
      'stored-key_wh-1',
      { from: '628123456789@c.us' },
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
    // redeliver retires a delivered event's row itself; a second close here only repeats the write.
    expect(outbox.close).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, replayed: 1 });
  });

  // The REAL shape of a delivery failure. redeliver resolves 'failed' rather than rejecting, because
  // every failing path inside it already dead-letters and logs; an earlier version of this test
  // mocked a rejection instead, which the collaborator cannot produce, so the budget it claimed to
  // guard was never exercised and a dead-lettered event was retired as 'dispatched' on sweep one.
  it('leaves a row pending when the replay did not deliver, so the budget is actually spent', async () => {
    outbox.findStale.mockResolvedValue([row({ attempts: 1 })]);
    delivery.redeliver.mockResolvedValue('failed');

    const stats = await service.sweep(OPTS);

    expect(outbox.countAttempt).toHaveBeenCalledWith('row-1', 1);
    expect(outbox.countAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      delivery.redeliver.mock.invocationCallOrder[0],
    );
    // Left pending on purpose: the next sweep picks it up again until the budget runs out.
    expect(outbox.close).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ replayed: 0, failed: 1 });
  });

  it('leaves retirement of an enqueued replay to the worker', async () => {
    outbox.findStale.mockResolvedValue([row({ attempts: 1 })]);
    delivery.redeliver.mockResolvedValue('enqueued');

    const stats = await service.sweep(OPTS);

    expect(outbox.close).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ replayed: 1, failed: 0 });
  });

  it('retires the row when a plugin cancelled the dispatch, instead of replaying it to death', async () => {
    // A cancelled dispatch is a deliberate drop, not a loss. Reported as 'failed' it was replayed
    // once per sweep until the budget ran out and then marked terminally lost, pointing operators
    // at a delivery-failure row that was never written.
    outbox.findStale.mockResolvedValue([row({ attempts: 1 })]);
    delivery.redeliver.mockResolvedValue('cancelled');

    const stats = await service.sweep(OPTS);

    expect(outbox.close).toHaveBeenCalledWith('wh-1', 'stored-key_wh-1', 'dispatched');
    expect(stats).toMatchObject({ replayed: 1, failed: 0 });
  });

  it('keeps a row pending when the replay throws an unexpected fault', async () => {
    outbox.findStale.mockResolvedValue([row({ attempts: 1 })]);
    delivery.redeliver.mockRejectedValue(new Error('boom'));

    const stats = await service.sweep(OPTS);

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

  it('keeps its durable payload when recording a spent budget fails, without another POST', async () => {
    outbox.findStale.mockResolvedValue([row({ attempts: 3 })]);
    delivery.recordReplayExhaustion.mockResolvedValue(false);
    await service.sweep(OPTS);
    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).not.toHaveBeenCalled();
    expect(delivery.recordReplayExhaustion).toHaveBeenCalledTimes(1);
  });

  it('keeps a queued row while BullMQ still owns an active job', async () => {
    outbox.findStale.mockResolvedValue([row({ state: 'queued', deliveryId: 'job' })]);
    delivery.isQueueJobPending.mockResolvedValue(true);
    await service.sweep(OPTS);
    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).not.toHaveBeenCalled();
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

  it('does not replay an event the webhook has since unsubscribed from', async () => {
    outbox.findStale.mockResolvedValue([row({ event: 'message.received' })]);
    webhooks.findOne.mockResolvedValue({ id: 'wh-1', active: true, events: ['session.status'] });

    const stats = await service.sweep(OPTS);

    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).toHaveBeenCalledWith('wh-1', 'stored-key_wh-1', 'failed');
    expect(stats).toMatchObject({ skipped: 1, replayed: 0 });
  });

  it('leaves a row alone while this node is still dispatching it', async () => {
    // A direct delivery with retries, or one parked behind slow receivers, can stay pending past the
    // grace window. Replaying it would POST alongside the original and spend its budget mid-flight.
    outbox.findStale.mockResolvedValue([row({ attempts: 3 })]);
    delivery.isLocallyPending.mockImplementation((key: string) => key === 'stored-key_wh-1');

    const stats = await service.sweep(OPTS);

    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.countAttempt).not.toHaveBeenCalled();
    expect(outbox.close).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, skipped: 1, replayed: 0, failed: 0 });
  });

  it('does not replay a row that settled after the batch was read', async () => {
    // The original dispatch finished while an earlier row in the pass was replaying: no longer
    // locally pending, but no longer pending in the database either.
    outbox.findStale.mockResolvedValue([row({ attempts: 1 })]);
    outbox.countAttempt.mockResolvedValue(false);

    const stats = await service.sweep(OPTS);

    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ scanned: 1, skipped: 1, replayed: 0, failed: 0 });
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

  // A queue lookup against a stalled Redis may not return, and the destroy hooks after this one
  // (engines, session leases, plugins) must not wait on it for ever.
  it('stops waiting on destroy after WEBHOOK_SHUTDOWN_DRAIN_MS and replays nothing once the lookup returns', async () => {
    outbox.findStale.mockResolvedValue([row({ deliveryId: 'job-1' })]);
    let reached!: () => void;
    const lookedUp = new Promise<void>(resolve => (reached = resolve));
    let answer!: (pending: boolean) => void;
    delivery.isQueueJobPending.mockImplementation(() => {
      reached();
      return new Promise<boolean>(resolve => (answer = resolve));
    });
    service = new WebhookReconcilerService(
      webhooks as never,
      outbox as never,
      delivery as never,
      new ConfigService({ webhook: { shutdownDrainMs: 2000 } }),
    );

    const sweep = service.sweep(OPTS);
    await lookedUp;
    let destroyed = false;
    let destroyedBeforeDeadline: boolean;
    let destroyedAtDeadline: boolean;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      void service.onModuleDestroy().then(() => (destroyed = true));
      await jest.advanceTimersByTimeAsync(1999);
      await new Promise(setImmediate);
      destroyedBeforeDeadline = destroyed;
      await jest.advanceTimersByTimeAsync(1);
      await new Promise(setImmediate);
      destroyedAtDeadline = destroyed;
    } finally {
      jest.useRealTimers();
    }
    answer(false);
    const stats = await sweep;

    expect(destroyedBeforeDeadline).toBe(false);
    expect(destroyedAtDeadline).toBe(true);
    expect(stats).toMatchObject({ replayed: 0, failed: 0 });
    expect(outbox.countAttempt).not.toHaveBeenCalled();
    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(outbox.close).not.toHaveBeenCalled();
  });

  it('keeps waiting on destroy when WEBHOOK_SHUTDOWN_DRAIN_MS is above the Node timer ceiling', async () => {
    outbox.findStale.mockResolvedValue([row({ deliveryId: 'job-1' })]);
    let reached!: () => void;
    const lookedUp = new Promise<void>(resolve => (reached = resolve));
    let answer!: (pending: boolean) => void;
    delivery.isQueueJobPending.mockImplementation(() => {
      reached();
      return new Promise<boolean>(resolve => (answer = resolve));
    });
    service = new WebhookReconcilerService(
      webhooks as never,
      outbox as never,
      delivery as never,
      new ConfigService({ webhook: { shutdownDrainMs: MAX_TIMER_MS + 1 } }),
    );

    const sweep = service.sweep(OPTS);
    await lookedUp;
    let destroyed = false;
    let destroyedEarly: boolean;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      void service.onModuleDestroy().then(() => (destroyed = true));
      await jest.advanceTimersByTimeAsync(60_000);
      await new Promise(setImmediate);
      destroyedEarly = destroyed;
    } finally {
      jest.useRealTimers();
    }
    answer(false);
    await sweep;
    await new Promise(setImmediate);

    expect(destroyedEarly).toBe(false);
    expect(destroyed).toBe(true);
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
