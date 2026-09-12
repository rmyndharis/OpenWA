import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RemoteOpenWaQueueDepth = { pending: number; completed: number; failed: number };
export type RemoteOpenWaQueuesStatus = {
  configured: boolean;
  source: 'bull-board' | 'infra-status' | 'unconfigured';
  queues: Array<{ name: string; counts: RemoteOpenWaQueueDepth }>;
};

@Injectable()
export class RemoteOpenWaQueuesService {
  constructor(private readonly config: ConfigService) {}

  async getStatus(): Promise<RemoteOpenWaQueuesStatus> {
    const baseUrl = (this.config.get<string>('remoteOpenWa.baseUrl') || '').replace(/\/$/, '');
    const adminApiKey = this.config.get<string>('remoteOpenWa.adminApiKey') || '';
    const timeoutMs = this.config.get<number>('remoteOpenWa.timeoutMs', 10000);
    if (!baseUrl || !adminApiKey) {
      return { configured: false, source: 'unconfigured', queues: [] };
    }

    const headers = { 'X-API-Key': adminApiKey, Accept: 'application/json' };
    const boardUrl = `${baseUrl}/api/admin/queues/api/queues`;
    try {
      const boardRes = await fetch(boardUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      if (boardRes.ok) {
        const body = (await boardRes.json()) as unknown;
        const queues = this.mapBullBoardQueues(body);
        if (queues) {
          return { configured: true, source: 'bull-board', queues };
        }
      }
    } catch {
      // fall through to infra-status
    }

    const statusUrl = `${baseUrl}/api/infra/status`;
    const statusRes = await fetch(statusUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (!statusRes.ok) {
      throw new ServiceUnavailableException(`Remote OpenWA queues unavailable (HTTP ${statusRes.status})`);
    }
    const statusBody = (await statusRes.json()) as {
      queue?: { webhooks?: RemoteOpenWaQueueDepth };
    };
    const webhooks = statusBody.queue?.webhooks ?? { pending: 0, completed: 0, failed: 0 };
    return {
      configured: true,
      source: 'infra-status',
      queues: [{ name: 'webhook-queue', counts: webhooks }],
    };
  }

  private mapBullBoardQueues(body: unknown): Array<{ name: string; counts: RemoteOpenWaQueueDepth }> | null {
    const list = Array.isArray(body) ? body : (body as { queues?: unknown })?.queues;
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map((item: { name?: string; counts?: Record<string, number> }) => {
      const c = item.counts ?? {};
      const pending = (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) + (c.paused ?? 0);
      return {
        name: String(item.name ?? 'unknown'),
        counts: {
          pending,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
        },
      };
    });
  }
}
