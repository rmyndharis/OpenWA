import { RemoteOpenWaQueuesService } from './remote-openwa-queues.service';

describe('RemoteOpenWaQueuesService', () => {
  const config = {
    get: (key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        'remoteOpenWa.baseUrl': 'https://openwa.insightsmt.com.br',
        'remoteOpenWa.adminApiKey': 'remote-admin',
        'remoteOpenWa.timeoutMs': 5000,
      };
      return map[key] ?? def;
    },
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns unconfigured when base URL is empty', async () => {
    const emptyConfig = {
      get: (key: string, def?: unknown) => (key === 'remoteOpenWa.baseUrl' ? '' : config.get(key, def)),
    };
    const svc = new RemoteOpenWaQueuesService(emptyConfig as never);
    await expect(svc.getStatus()).resolves.toEqual({
      configured: false,
      source: 'unconfigured',
      queues: [],
    });
  });

  it('maps bull-board queues JSON into depths', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [
        { name: 'webhook-queue', counts: { waiting: 1, active: 2, delayed: 0, completed: 10, failed: 3 } },
        { name: 'ingress-queue', counts: { waiting: 0, active: 0, delayed: 0, completed: 5, failed: 0 } },
      ],
    } as unknown as Response);

    const svc = new RemoteOpenWaQueuesService(config as never);
    const result = await svc.getStatus();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openwa.insightsmt.com.br/api/admin/queues/api/queues',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-API-Key': 'remote-admin' }),
        redirect: 'manual',
      }),
    );
    expect(result).toEqual({
      configured: true,
      source: 'bull-board',
      queues: [
        { name: 'webhook-queue', counts: { pending: 3, completed: 10, failed: 3 } },
        { name: 'ingress-queue', counts: { pending: 0, completed: 5, failed: 0 } },
      ],
    });
  });

  it('falls back to /api/infra/status when bull-board JSON fails', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: { get: () => 'text/html' },
        json: async () => ({}),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          queue: {
            enabled: true,
            webhooks: { pending: 4, completed: 9, failed: 1 },
          },
        }),
      } as unknown as Response);

    const svc = new RemoteOpenWaQueuesService(config as never);
    const result = await svc.getStatus();
    expect(result.source).toBe('infra-status');
    expect(result.queues).toEqual([
      { name: 'webhook-queue', counts: { pending: 4, completed: 9, failed: 1 } },
    ]);
  });
});
