import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createLogger } from '../../common/services/logger.service';
import { startGuardedInterval } from '../../common/utils/guarded-interval';
import { QUEUE_NAMES } from './queue-names';
import { producerReady } from './redis-connection';

/** How often the declared retention ages are enforced. */
export const QUEUE_RETENTION_INTERVAL_MS = 5 * 60_000;
/** Jobs removed per cleaner call, so no single call holds Redis for long. */
export const QUEUE_RETENTION_BATCH = 1000;

/**
 * Removes finished jobs once they are older than the `removeOnComplete.age` and `removeOnFail.age` their queue
 * declares. BullMQ applies those ages only when another job finishes. A Redis at its maxmemory refuses every add,
 * so then nothing finishes, the expired jobs stay, and every delivery bypasses the queue until someone cleans it
 * by hand. No retention is shortened: a job is removed here only once BullMQ itself would remove it.
 */
@Injectable()
export class QueueRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('QueueRetention');
  private readonly queues: Queue[];
  // Sets whose last clean failed. A clean with nothing to remove is refused at the ceiling too (its event write is
  // its first write), so a failure is logged once until a clean of that set succeeds.
  private readonly failing = new Set<string>();
  private stopInterval?: () => void;
  private stopped = false;

  constructor(
    @InjectQueue(QUEUE_NAMES.WEBHOOK) webhookQueue: Queue,
    @InjectQueue(QUEUE_NAMES.INGRESS) ingressQueue: Queue,
  ) {
    this.queues = [webhookQueue, ingressQueue];
  }

  onModuleInit(): void {
    // A refused clean is handled per set inside the pass; only an unexpected fault reaches this handler.
    this.stopInterval = startGuardedInterval(
      () => this.enforce(),
      QUEUE_RETENTION_INTERVAL_MS,
      err => this.logger.warn('Queue retention pass failed', { error: String(err), action: 'queue_retention_failed' }),
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.stopInterval?.();
  }

  private async enforce(): Promise<void> {
    for (const queue of this.queues) {
      // A Redis that is down, or has never connected, is skipped without a command or a log line.
      if (!(await isConnected(queue))) continue;
      const { removeOnComplete, removeOnFail } = queue.defaultJobOptions;
      for (const [type, keep] of [
        ['completed', removeOnComplete],
        ['failed', removeOnFail],
      ] as const) {
        const age = typeof keep === 'object' && 'age' in keep ? keep.age : undefined;
        if (!age) continue;
        const set = `${queue.name} ${type}`;
        try {
          let removed: number;
          do {
            if (this.stopped) return;
            removed = (await queue.clean(age * 1000, QUEUE_RETENTION_BATCH, type)).length;
          } while (removed === QUEUE_RETENTION_BATCH);
          this.failing.delete(set);
        } catch (err) {
          if (this.stopped || this.failing.has(set)) continue;
          this.failing.add(set);
          this.logger.warn(`Could not remove ${set} jobs older than ${age} s; retrying every interval`, {
            error: String(err),
            action: 'queue_retention_failed',
          });
        }
      }
    }
  }
}

async function isConnected(queue: Queue): Promise<boolean> {
  try {
    await producerReady(queue);
  } catch {
    return false;
  }
  return (await queue.getBackend().client).status === 'ready';
}
