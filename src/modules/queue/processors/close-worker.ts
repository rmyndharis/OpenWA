import type { WorkerHost } from '@nestjs/bullmq';
import type { Worker } from 'bullmq';
import { createLogger } from '../../../common/services/logger.service';

/**
 * Upper bound on a processor's early close. Worker.close() can stay pending while Redis is unreachable,
 * and the global destroy hooks (API-key usage flush, plugin onDisable) wait behind it. 10s equals the
 * default webhook delivery timeout, so a job whose POST uses the whole timeout has no time left for its
 * bookkeeping. A job still active at the cap is re-run after the next start, so receivers must
 * deduplicate on the stable idempotency key. The sum of every stage before and after this one, against
 * the kill deadline, is in shutdown-budget.ts.
 */
export const MAX_WORKER_CLOSE_WAIT_MS = 10_000;

const logger = createLogger('QueueWorkerShutdown');

/**
 * A processor's Worker, or undefined when BullModule never created it. The WorkerHost getter throws in
 * that case, which is whenever the app is closed before init() ran (a bootstrap that fails before
 * listen, or a compiled-only testing module), and a rejected destroy hook would abort the rest of the
 * teardown.
 */
export function startedWorker(host: WorkerHost): Worker | undefined {
  try {
    return host.worker;
  } catch {
    return undefined;
  }
}

/**
 * Close a processor's Worker from its onModuleDestroy hook, waiting at most `waitMs` (capped at
 * MAX_WORKER_CLOSE_WAIT_MS) for its running jobs. Past the wait the hook returns and the teardown goes on.
 * A close that is still pending then is abandoned: Worker.close() hands every caller its first promise,
 * and BullModule awaits it again in onApplicationShutdown with no timeout, ahead of the DataSource
 * close, so it is replaced by one that resolves at once. A rejected close is left to that later await,
 * so it cannot skip the global destroy hooks. A no-op for a Worker that was never created.
 */
export async function closeWorkerIfStarted(host: WorkerHost, waitMs: number): Promise<void> {
  const worker = startedWorker(host);
  if (!worker) return;
  const limitMs = Math.min(waitMs, MAX_WORKER_CLOSE_WAIT_MS);
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    worker.close().then(
      () => true,
      () => true,
    ),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), limitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!closed) {
    logger.warn('Queue worker did not close in time; continuing shutdown', { queue: worker.name, waitMs: limitMs });
    worker.close = () => Promise.resolve();
  }
}
