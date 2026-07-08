import { IngressEnqueueService, resolveIngressJobOptions, buildIngressDeadLetterRow } from './ingress-enqueue.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { ConfigService } from '@nestjs/config';

describe('IngressEnqueueService', () => {
  const data = {
    pluginId: 'chatwoot',
    instanceId: 'acct1',
    route: 'chatwoot',
    deliveryId: 'd1',
    sessionId: 'sess-1',
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
  };

  let loader: jest.Mocked<Partial<PluginLoaderService>>;
  let config: jest.Mocked<Partial<ConfigService>>;
  let queue: { add: jest.Mock };

  beforeEach(() => {
    loader = { dispatchWebhookForInstance: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
  });

  it('adds a job to the ingress queue with the given jobId when queueing is enabled and a queue is present', async () => {
    (config.get as jest.Mock).mockReturnValue(true);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

    expect(await svc.enqueue(data, 'd1')).toEqual({ outcome: 'queued' });

    expect(queue.add).toHaveBeenCalledWith('ingress', data, {
      jobId: 'd1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(loader.dispatchWebhookForInstance).not.toHaveBeenCalled();
  });

  it('dispatches inline when queueing is disabled, even if a queue instance is present', async () => {
    (config.get as jest.Mock).mockReturnValue(false);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

    expect(await svc.enqueue(data, 'd1')).toEqual({ outcome: 'dispatched' });

    expect(queue.add).not.toHaveBeenCalled();
    expect(loader.dispatchWebhookForInstance).toHaveBeenCalledWith(data);
  });

  it('dispatches inline when no queue instance is injected (QUEUE_ENABLED unset)', async () => {
    (config.get as jest.Mock).mockReturnValue(true);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, undefined);

    expect(await svc.enqueue(data, 'd1')).toEqual({ outcome: 'dispatched' });

    expect(loader.dispatchWebhookForInstance).toHaveBeenCalledWith(data);
  });

  it('swallows an inline dispatch error and returns outcome "failed" rather than throwing (row stays redrivable)', async () => {
    (loader.dispatchWebhookForInstance as jest.Mock).mockRejectedValue(new Error('boom'));
    (config.get as jest.Mock).mockReturnValue(false);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, undefined);

    expect(await svc.enqueue(data, 'd1')).toEqual({ outcome: 'failed', error: 'boom' });
  });

  it('falls back to inline dispatch (never throws) when queue.add() fails, e.g. Redis unreachable', async () => {
    // Without this, the throw would 500 the ingress request; the provider retries, dedup returns
    // "duplicate", and the already-persisted event is lost forever (no job, no DLQ row).
    (config.get as jest.Mock).mockReturnValue(true);
    queue.add.mockRejectedValue(new Error('Redis connection is closed'));
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

    expect(await svc.enqueue(data, 'd1')).toEqual({ outcome: 'dispatched' });
    expect(queue.add).toHaveBeenCalledWith('ingress', data, {
      jobId: 'd1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(loader.dispatchWebhookForInstance).toHaveBeenCalledWith(data);
  });

  describe('resolveIngressJobOptions', () => {
    it('defaults to 3 attempts with exponential backoff', () => {
      expect(resolveIngressJobOptions()).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    });

    it('honors INGRESS_MAX_ATTEMPTS / INGRESS_RETRY_DELAY_MS overrides', () => {
      const prevA = process.env.INGRESS_MAX_ATTEMPTS;
      const prevD = process.env.INGRESS_RETRY_DELAY_MS;
      try {
        process.env.INGRESS_MAX_ATTEMPTS = '5';
        process.env.INGRESS_RETRY_DELAY_MS = '1000';
        expect(resolveIngressJobOptions()).toEqual({ attempts: 5, backoff: { type: 'exponential', delay: 1000 } });
      } finally {
        if (prevA === undefined) delete process.env.INGRESS_MAX_ATTEMPTS;
        else process.env.INGRESS_MAX_ATTEMPTS = prevA;
        if (prevD === undefined) delete process.env.INGRESS_RETRY_DELAY_MS;
        else process.env.INGRESS_RETRY_DELAY_MS = prevD;
      }
    });
  });

  describe('buildIngressDeadLetterRow', () => {
    it('mirrors the ingress-processor dead-letter shape so a redrive reads it back (attempts=1, redriven=false)', () => {
      expect(buildIngressDeadLetterRow(data, 'boom')).toEqual({
        direction: 'inbound',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        sessionId: 'sess-1',
        deliveryId: 'd1',
        attempts: 1,
        lastError: 'boom',
        payload: { route: 'chatwoot', providerConversationId: undefined, ingress: data.payload },
        redriven: false,
      });
    });

    it('defaults sessionId to null and supplies a fallback lastError when the error is absent', () => {
      const row = buildIngressDeadLetterRow({ ...data, sessionId: undefined }, undefined);
      expect(row.sessionId).toBeNull();
      expect(row.lastError).toBe('inline ingress dispatch failed');
    });
  });
});
