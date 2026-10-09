import 'reflect-metadata';
import { FactoryProvider, Provider } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from './queue-names';
import { QueueModule, WEBHOOK_QUEUE_JOB_OPTIONS } from './queue.module';
import { ShutdownSafeQueue } from './shutdown-safe-queue';

// A stub base keeps the factory from opening a Redis connection; ShutdownSafeQueue still extends it.
jest.mock('bullmq', () => ({
  ...jest.requireActual<object>('bullmq'),
  Queue: class {
    constructor(readonly name: string) {}
  },
}));

// The producers must be built as ShutdownSafeQueue: without it a dropped Redis rejects or hangs their
// close and Nest skips the DataSource close behind it. registerQueue captures the class when the
// @Module decorator runs, so the check builds the registered producers instead of reading the static.
describe('QueueModule producers', () => {
  it.each([QUEUE_NAMES.WEBHOOK, QUEUE_NAMES.INGRESS])('%s is created as a ShutdownSafeQueue', async name => {
    const imports = Reflect.getMetadata('imports', QueueModule) as { providers?: Provider[] }[];
    const provider = imports
      .flatMap(m => m.providers ?? [])
      .find(p => (p as { provide?: unknown }).provide === getQueueToken(name)) as FactoryProvider | undefined;
    expect(provider).toBeDefined();

    expect(await provider!.useFactory({ name })).toBeInstanceOf(ShutdownSafeQueue);
  });
});

/**
 * Failed webhook jobs retain their full payload in Redis until eviction, so the retention window
 * must stay bounded on BOTH axes (count and age). The durable record of a lost delivery is the
 * webhook_delivery_failures row written on the final attempt — Redis is only a debugging window.
 * Payload bytes are bounded separately: media is shed before enqueue (see WebhookService).
 */
describe('WEBHOOK_QUEUE_JOB_OPTIONS', () => {
  it('auto-evicts completed jobs on a bounded count and age', () => {
    const opts = WEBHOOK_QUEUE_JOB_OPTIONS.removeOnComplete;
    expect(typeof opts).toBe('object'); // a bounded window, not `false` (keep forever) / `true` (drop all)
    expect(opts.count).toBeGreaterThan(0);
    expect(opts.age).toBeGreaterThan(0);
  });

  it('auto-evicts failed jobs on a bounded count and age', () => {
    const opts = WEBHOOK_QUEUE_JOB_OPTIONS.removeOnFail;
    expect(typeof opts).toBe('object');
    expect(opts.count).toBeGreaterThan(0);
    expect(opts.age).toBeGreaterThan(0);
  });
});
