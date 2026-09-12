import { OpenWaQueuesService } from './openwa-queues.service';
import { QUEUE_NAMES } from '../queue/queue-names';

describe('OpenWaQueuesService', () => {
  function config(enabled: boolean) {
    return { get: (key: string, def?: unknown) => (key === 'queue.enabled' ? enabled : def) };
  }

  it('returns unconfigured when queue disabled', async () => {
    const svc = new OpenWaQueuesService(config(false) as never, undefined, undefined);
    await expect(svc.getStatus()).resolves.toEqual({
      configured: false,
      source: 'unconfigured',
      queues: [],
    });
  });

  it('maps local BullMQ job counts for webhook and ingress', async () => {
    const webhook = {
      getJobCounts: jest.fn().mockResolvedValue({
        wait: 1,
        active: 2,
        delayed: 0,
        completed: 10,
        failed: 3,
      }),
    };
    const ingress = {
      getJobCounts: jest.fn().mockResolvedValue({
        wait: 0,
        active: 1,
        delayed: 1,
        completed: 5,
        failed: 0,
      }),
    };
    const svc = new OpenWaQueuesService(config(true) as never, webhook as never, ingress as never);
    const result = await svc.getStatus();
    expect(webhook.getJobCounts).toHaveBeenCalledWith('wait', 'active', 'delayed', 'completed', 'failed');
    expect(result).toEqual({
      configured: true,
      source: 'local',
      queues: [
        { name: QUEUE_NAMES.WEBHOOK, counts: { pending: 3, completed: 10, failed: 3 } },
        { name: QUEUE_NAMES.INGRESS, counts: { pending: 2, completed: 5, failed: 0 } },
      ],
    });
  });

  it('degrades missing queue injection to zero counts when enabled', async () => {
    const svc = new OpenWaQueuesService(config(true) as never, undefined, undefined);
    await expect(svc.getStatus()).resolves.toEqual({
      configured: true,
      source: 'local',
      queues: [
        { name: QUEUE_NAMES.WEBHOOK, counts: { pending: 0, completed: 0, failed: 0 } },
        { name: QUEUE_NAMES.INGRESS, counts: { pending: 0, completed: 0, failed: 0 } },
      ],
    });
  });
});
