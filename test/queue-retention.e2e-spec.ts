import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { QueueRetentionService } from '../src/modules/queue/queue-retention.service';
import { QUEUE_NAMES } from '../src/modules/queue/queue-names';
import { waitUntil } from './helpers/wait-until';

const REDIS_HOST = process.env.QUEUE_TEST_REDIS_HOST || process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.QUEUE_TEST_REDIS_PORT || process.env.REDIS_PORT || '6379', 10);

const probeRedis = (host: string, port: number, timeoutMs: number): boolean => {
  const script =
    `const s = require('net').connect(${port}, ${JSON.stringify(host)});` +
    `const t = setTimeout(() => process.exit(2), ${timeoutMs});` +
    `s.on('connect', () => { clearTimeout(t); s.end(); process.exit(0); });` +
    `s.on('error', () => { clearTimeout(t); process.exit(1); });`;
  return spawnSync(process.execPath, ['-e', script], { timeout: timeoutMs + 1000 }).status === 0;
};

const REDIS_AVAILABLE = probeRedis(REDIS_HOST, REDIS_PORT, 1000);
if (!REDIS_AVAILABLE && process.env.GITHUB_ACTIONS === 'true') {
  throw new Error(
    `queue retention e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions; refusing to skip`,
  );
}
const describeRedis = REDIS_AVAILABLE ? describe : describe.skip;

/**
 * BullMQ removes finished jobs past their declared age only when another job finishes. A Redis at its maxmemory
 * refuses every add, so nothing finishes and those jobs stay. Here no job finishes after the first batch either
 * (the workers are closed), and the timer alone has to remove them. Its own key prefix keeps this suite apart from
 * the other queue suites on the same Redis.
 *
 * Needs a real Redis: `docker run -d -p 6379:6379 redis:7-alpine`, or QUEUE_TEST_REDIS_HOST and QUEUE_TEST_REDIS_PORT.
 */
describeRedis('Finished queue jobs past their declared age (e2e, real Redis)', () => {
  const connection = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null };
  const prefix = `openwa-e2e-retention-${randomUUID()}`;
  let webhook: Queue;
  let ingress: Queue;
  let service: QueueRetentionService;

  // In beforeAll, so a suite skipped for want of Redis opens no connection.
  beforeAll(() => {
    // A one-second age for the webhook queue, the age queue.module.ts declares for the ingress queue.
    webhook = new Queue(QUEUE_NAMES.WEBHOOK, {
      connection,
      prefix,
      defaultJobOptions: { removeOnComplete: { age: 1, count: 10_000 }, removeOnFail: { age: 1, count: 5000 } },
    });
    ingress = new Queue(QUEUE_NAMES.INGRESS, {
      connection,
      prefix,
      defaultJobOptions: { removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 5000 } },
    });
    service = new QueueRetentionService(webhook, ingress);
  });

  afterAll(async () => {
    service.onModuleDestroy();
    for (const queue of [webhook, ingress]) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('removes them on the timer although no other job finishes, and keeps the ones still inside their age', async () => {
    for (const queue of [webhook, ingress]) {
      await queue.addBulk([
        { name: 'ok', data: {} },
        { name: 'ok', data: {} },
        { name: 'fail', data: {}, opts: { attempts: 1 } },
      ]);
      const worker = new Worker(
        queue.name,
        job => (job.name === 'fail' ? Promise.reject(new Error('receiver down')) : Promise.resolve()),
        { connection, prefix },
      );
      await waitUntil(async () => {
        const counts = await queue.getJobCounts('completed', 'failed');
        return counts.completed === 2 && counts.failed === 1;
      });
      await worker.close();
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    // BullMQ prunes only when a later job finishes, so the last job of each set is still there.
    const before = await webhook.getJobCounts('completed', 'failed');
    expect(before.completed).toBeGreaterThan(0);
    expect(before.failed).toBe(1);

    service.onModuleInit();
    await waitUntil(async () => {
      const counts = await webhook.getJobCounts('completed', 'failed');
      return counts.completed === 0 && counts.failed === 0;
    }, 10_000);

    expect(await webhook.getJobCounts('completed', 'failed')).toEqual({ completed: 0, failed: 0 });
    expect(await ingress.getJobCounts('completed', 'failed')).toEqual({ completed: 2, failed: 1 });
  }, 30_000);
});
