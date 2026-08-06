import { WEBHOOK_QUEUE_JOB_OPTIONS } from './queue.module';

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
