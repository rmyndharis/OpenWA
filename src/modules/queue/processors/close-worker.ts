import type { WorkerHost } from '@nestjs/bullmq';
import type { Worker } from 'bullmq';
import { createLogger } from '../../../common/services/logger.service';

/**
 * Upper bound on a processor's early close. Worker.close() can stay pending while Redis is unreachable,
 * and the global destroy hooks (API-key usage flush, plugin onDisable) wait behind it. The shipped kill
 * deadline is 45s (docker-compose stop_grace_period, Helm terminationGracePeriodSeconds), and before
 * QueueModule is destroyed shutdown has already spent SHUTDOWN_DELAY_MS (3s), the ingress reconciler
 * wait (INGRESS_DISPATCH_TIMEOUT_MS, 5s), the engine teardown (10s per-engine deadline, engines in
 * parallel) and WEBHOOK_SHUTDOWN_DRAIN_MS (5s). 15s here leaves 7s for the 5s-bounded usage flush,
 * plugin onDisable and the rest of the teardown.
 */
export const MAX_WORKER_CLOSE_WAIT_MS = 15_000;

const logger = createLogger('QueueWorkerShutdown');

/**
 * Close a processor's Worker from its onModuleDestroy hook, waiting at most `waitMs` (capped at
 * MAX_WORKER_CLOSE_WAIT_MS) for its running jobs. Past the wait the hook returns and the teardown goes on
 * as it would without the early close; BullModule's onApplicationShutdown awaits the same pending close.
 * A rejected close is left to that later await too, so it cannot skip the global destroy hooks.
 *
 * The WorkerHost getter throws when BullModule never created the Worker, which is the case whenever the
 * app is closed before init() ran (a bootstrap that fails before listen, or a compiled-only testing
 * module); a rejected destroy hook would abort the rest of the teardown, so that case is a no-op.
 */
export async function closeWorkerIfStarted(host: WorkerHost, waitMs: number): Promise<void> {
  let worker: Worker;
  try {
    worker = host.worker;
  } catch {
    return;
  }
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
  }
}
