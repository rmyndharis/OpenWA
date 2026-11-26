import type { Queue } from 'bullmq';
import { QueueRetentionService, QUEUE_RETENTION_BATCH, QUEUE_RETENTION_INTERVAL_MS } from './queue-retention.service';
import { WEBHOOK_QUEUE_JOB_OPTIONS } from './queue.module';
import { producerConnectWaitMs } from './redis-connection';

interface FakeQueue {
  name: string;
  defaultJobOptions: object;
  waitUntilReady: jest.Mock;
  getBackend: () => { client: Promise<{ status: string }> };
  clean: jest.Mock<Promise<string[]>, [number, number, string]>;
}

const fakeQueue = (name: string, defaultJobOptions: object, status = 'ready'): FakeQueue => ({
  name,
  defaultJobOptions,
  waitUntilReady: jest.fn().mockResolvedValue(undefined),
  getBackend: () => ({ client: Promise.resolve({ status }) }),
  clean: jest.fn<Promise<string[]>, [number, number, string]>().mockResolvedValue([]),
});

const INGRESS_OPTIONS = { removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 5000 } };

function start(webhook: FakeQueue, ingress: FakeQueue): { service: QueueRetentionService; warn: jest.SpyInstance } {
  const service = new QueueRetentionService(webhook as unknown as Queue, ingress as unknown as Queue);
  const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn');
  service.onModuleInit();
  return { service, warn };
}

describe('QueueRetentionService', () => {
  let service: QueueRetentionService | undefined;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    service?.onModuleDestroy();
    service = undefined;
    jest.useRealTimers();
  });

  // BullMQ applies these ages only when another job finishes. A Redis at its maxmemory refuses every add, so no
  // job finishes and the expired jobs stay: without a timer the queue is bypassed until someone cleans it by hand.
  it('removes finished jobs past the age each queue declares, at start and on every interval', async () => {
    const webhook = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS);
    const ingress = fakeQueue('ingress-queue', INGRESS_OPTIONS);
    ({ service } = start(webhook, ingress));
    await jest.advanceTimersByTimeAsync(0);

    const tick = (opts: { removeOnComplete: { age: number }; removeOnFail: { age: number } }) => [
      [opts.removeOnComplete.age * 1000, QUEUE_RETENTION_BATCH, 'completed'],
      [opts.removeOnFail.age * 1000, QUEUE_RETENTION_BATCH, 'failed'],
    ];
    expect(webhook.clean.mock.calls).toEqual(tick(WEBHOOK_QUEUE_JOB_OPTIONS));
    expect(ingress.clean.mock.calls).toEqual(tick(INGRESS_OPTIONS));

    await jest.advanceTimersByTimeAsync(QUEUE_RETENTION_INTERVAL_MS);
    expect(webhook.clean).toHaveBeenCalledTimes(4);
    expect(ingress.clean).toHaveBeenCalledTimes(4);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(QUEUE_RETENTION_INTERVAL_MS * 3);
    expect(webhook.clean).toHaveBeenCalledTimes(4);
    expect(ingress.clean).toHaveBeenCalledTimes(4);
  });

  it('cleans in batches until a batch comes back short', async () => {
    const webhook = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS);
    const full = Array.from({ length: QUEUE_RETENTION_BATCH }, (_, i) => String(i));
    webhook.clean.mockResolvedValueOnce(full).mockResolvedValueOnce(full).mockResolvedValueOnce(['a', 'b']);
    ({ service } = start(webhook, fakeQueue('ingress-queue', INGRESS_OPTIONS)));
    await jest.advanceTimersByTimeAsync(0);

    expect(webhook.clean.mock.calls.map(call => call[2])).toEqual(['completed', 'completed', 'completed', 'failed']);
  });

  // At the ceiling a clean with nothing old enough to remove is refused as well (its event write is its first
  // write), possibly for an hour: one line per episode, not one per tick.
  it('keeps cleaning after a failed clean, logging it once until a clean of that set succeeds', async () => {
    const webhook = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS);
    const oom = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    webhook.clean.mockImplementation((_grace: number, _limit: number, type: string) =>
      type === 'completed' ? Promise.reject(oom) : Promise.resolve([]),
    );
    let warn: jest.SpyInstance;
    ({ service, warn } = start(webhook, fakeQueue('ingress-queue', INGRESS_OPTIONS)));
    await jest.advanceTimersByTimeAsync(QUEUE_RETENTION_INTERVAL_MS * 2);

    expect(webhook.clean.mock.calls.map(call => call[2])).toEqual([
      'completed',
      'failed',
      'completed',
      'failed',
      'completed',
      'failed',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('webhook-queue') as string, expect.anything());

    webhook.clean.mockResolvedValue([]);
    await jest.advanceTimersByTimeAsync(QUEUE_RETENTION_INTERVAL_MS);
    webhook.clean.mockRejectedValue(oom);
    await jest.advanceTimersByTimeAsync(QUEUE_RETENTION_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(3); // completed and failed each fail again, after a success
  });

  it('sends nothing and logs nothing while a Redis is down or has never connected', async () => {
    const down = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS, 'reconnecting');
    const never = fakeQueue('ingress-queue', INGRESS_OPTIONS);
    never.waitUntilReady.mockReturnValue(new Promise(() => undefined));
    let warn: jest.SpyInstance;
    ({ service, warn } = start(down, never));
    await jest.advanceTimersByTimeAsync(producerConnectWaitMs() + QUEUE_RETENTION_INTERVAL_MS * 2);

    expect(down.clean).not.toHaveBeenCalled();
    expect(never.clean).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // The queues close right after this module is destroyed, so a pass still running must neither go on cleaning
  // nor log the refusals the closing connection answers with.
  it('stops a pass in progress at destroy, quietly', async () => {
    const full = Array.from({ length: QUEUE_RETENTION_BATCH }, (_, i) => String(i));
    const webhook = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS);
    const ingress = fakeQueue('ingress-queue', INGRESS_OPTIONS);
    let warn: jest.SpyInstance;
    webhook.clean.mockImplementation(() => {
      service!.onModuleDestroy();
      return Promise.reject(new Error('Connection is closed.'));
    });
    ({ service, warn } = start(webhook, ingress));
    await jest.advanceTimersByTimeAsync(0);
    expect(webhook.clean).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    const later = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS);
    later.clean.mockImplementation(() => {
      service!.onModuleDestroy();
      return Promise.resolve(full);
    });
    ({ service } = start(later, fakeQueue('ingress-queue', INGRESS_OPTIONS)));
    await jest.advanceTimersByTimeAsync(0);
    expect(later.clean).toHaveBeenCalledTimes(1);

    // Destroyed before it ever started (a failed boot): nothing to stop.
    expect(() => new QueueRetentionService(webhook as never, ingress as never).onModuleDestroy()).not.toThrow();
  });

  it('logs a pass that fails outside a clean, and runs the next one', async () => {
    const webhook = fakeQueue('webhook-queue', WEBHOOK_QUEUE_JOB_OPTIONS);
    webhook.getBackend = () => ({ client: Promise.reject(new Error('connection setup failed')) });
    let warn: jest.SpyInstance;
    ({ service, warn } = start(webhook, fakeQueue('ingress-queue', INGRESS_OPTIONS)));
    await jest.advanceTimersByTimeAsync(QUEUE_RETENTION_INTERVAL_MS);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      'Queue retention pass failed',
      expect.objectContaining({ error: expect.stringContaining('connection setup failed') as string }),
    );
  });

  it('leaves a set alone when its retention declares no age', async () => {
    const webhook = fakeQueue('webhook-queue', { removeOnComplete: { count: 100 }, removeOnFail: true });
    ({ service } = start(webhook, fakeQueue('ingress-queue', {})));
    await jest.advanceTimersByTimeAsync(0);

    expect(webhook.clean).not.toHaveBeenCalled();
  });
});
