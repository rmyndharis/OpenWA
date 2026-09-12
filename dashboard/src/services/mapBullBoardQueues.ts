/** Shape returned by Bull Board JSON API at `/api/admin/queues/api/queues`. */
export type BullBoardQueuesResponse = {
  queues?: Array<{
    name: string;
    counts?: {
      waiting?: number;
      active?: number;
      delayed?: number;
      completed?: number;
      failed?: number;
      paused?: number;
      prioritized?: number;
      'waiting-children'?: number;
    };
    isPaused?: boolean;
  }>;
};

export type OpenWaQueuesStatus = {
  configured: boolean;
  source: 'bull-board' | 'unconfigured';
  queues: Array<{ name: string; counts: { pending: number; completed: number; failed: number } }>;
};

/** Maps Bull Board `/api/queues` payload into the Filas OpenWA UI model. */
export function mapBullBoardQueues(raw: BullBoardQueuesResponse): OpenWaQueuesStatus {
  const queues = (raw.queues ?? []).map(q => {
    const c = q.counts ?? {};
    return {
      name: q.name,
      counts: {
        pending:
          (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0) + (c['waiting-children'] ?? 0),
        completed: c.completed ?? 0,
        failed: c.failed ?? 0,
      },
    };
  });

  return {
    configured: true,
    source: 'bull-board',
    queues,
  };
}
