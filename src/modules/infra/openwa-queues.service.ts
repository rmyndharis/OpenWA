import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue-names';
import { createLogger } from '../../common/services/logger.service';

export type OpenWaQueueDepth = { pending: number; completed: number; failed: number };
export type OpenWaQueuesStatus = {
  configured: boolean;
  source: 'local' | 'unconfigured';
  queues: Array<{ name: string; counts: OpenWaQueueDepth }>;
};

@Injectable()
export class OpenWaQueuesService {
  private readonly logger = createLogger('OpenWaQueuesService');

  constructor(
    private readonly config: ConfigService,
    @Optional() @InjectQueue(QUEUE_NAMES.WEBHOOK) private readonly webhookQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.INGRESS) private readonly ingressQueue?: Queue,
  ) {}

  async getStatus(): Promise<OpenWaQueuesStatus> {
    const enabled = this.config.get<boolean>('queue.enabled', false);
    if (!enabled) {
      return { configured: false, source: 'unconfigured', queues: [] };
    }
    return {
      configured: true,
      source: 'local',
      queues: [
        { name: QUEUE_NAMES.WEBHOOK, counts: await this.readCounts(this.webhookQueue) },
        { name: QUEUE_NAMES.INGRESS, counts: await this.readCounts(this.ingressQueue) },
      ],
    };
  }

  private async readCounts(queue?: Queue): Promise<OpenWaQueueDepth> {
    if (!queue) return { pending: 0, completed: 0, failed: 0 };
    try {
      const c = await queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
      return {
        pending: (c.wait ?? 0) + (c.active ?? 0) + (c.delayed ?? 0),
        completed: c.completed ?? 0,
        failed: c.failed ?? 0,
      };
    } catch (error) {
      this.logger.warn('Failed to read queue job counts', { error: String(error) });
      return { pending: 0, completed: 0, failed: 0 };
    }
  }
}
