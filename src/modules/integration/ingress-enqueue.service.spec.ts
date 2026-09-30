import {
  IngressEnqueueService,
  resolveIngressJobOptions,
  buildIngressDeadLetterRow,
  sanitizeIngressJobId,
} from './ingress-enqueue.service';
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

  it('adds a job to the ingress queue keyed by the namespaced jobId when queueing is enabled and a queue is present', async () => {
    (config.get as jest.Mock).mockReturnValue(true);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

    expect(await svc.enqueue(data, 'd1')).toEqual({ outcome: 'queued' });

    expect(queue.add).toHaveBeenCalledWith('ingress', data, {
      jobId: sanitizeIngressJobId('d1', 'chatwoot\u0000acct1'),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(loader.dispatchWebhookForInstance).not.toHaveBeenCalled();
  });

  describe('existingJobState', () => {
    it('reads the state of the job under the same namespaced jobId enqueue() would use', async () => {
      (config.get as jest.Mock).mockReturnValue(true);
      const getJobState = jest.fn().mockResolvedValue('failed');
      const svc = new IngressEnqueueService(
        loader as PluginLoaderService,
        config as ConfigService,
        {
          ...queue,
          getJobState,
        } as never,
      );

      expect(await svc.existingJobState(data, 'd1')).toBe('failed');
      expect(getJobState).toHaveBeenCalledWith(sanitizeIngressJobId('d1', 'chatwoot\u0000acct1'));
    });

    it('reports no job when the queue holds none, is off, or cannot answer', async () => {
      (config.get as jest.Mock).mockReturnValue(true);
      const getJobState = jest.fn().mockResolvedValueOnce('unknown').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const svc = new IngressEnqueueService(
        loader as PluginLoaderService,
        config as ConfigService,
        {
          ...queue,
          getJobState,
        } as never,
      );
      expect(await svc.existingJobState(data, 'd1')).toBeUndefined();
      expect(await svc.existingJobState(data, 'd1')).toBeUndefined();

      (config.get as jest.Mock).mockReturnValue(false);
      expect(await svc.existingJobState(data, 'd1')).toBeUndefined();
      expect(getJobState).toHaveBeenCalledTimes(2);
    });
  });

  // BullMQ refuses integer jobIds and colon ids that do not split into exactly 3 parts; before the
  // sanitizer those throws read as "Redis unreachable" in the catch-all and silently degraded the
  // delivery to inline dispatch (no retry, no backoff, blocked redrive loop).
  describe('sanitizeIngressJobId', () => {
    it('hashes ids BullMQ would accept too, so the namespace always applies', () => {
      for (const id of ['d1', 'evt_abc-123', 'a:b:c', '0abc']) {
        expect(sanitizeIngressJobId(id)).toMatch(/^ing-[0-9a-f]{40}$/);
      }
    });

    it('namespaces a non-numeric id two instances share (one Svix message fanned out to both)', () => {
      const a = sanitizeIngressJobId('msg_2LJx9', 'chatwoot\u0000acct-1');
      const b = sanitizeIngressJobId('msg_2LJx9', 'chatwoot\u0000acct-2');
      expect(a).not.toBe(b);
      expect(sanitizeIngressJobId('msg_2LJx9', 'chatwoot\u0000acct-1')).toBe(a);
    });

    it('hashes the shapes BullMQ refuses, deterministically', () => {
      const integer = sanitizeIngressJobId('12345');
      const redrive = sanitizeIngressJobId('redrive:3f8e2a1b-9c4d-4e6f-8a2b-7d1c0e5f9a3b');
      const twoPart = sanitizeIngressJobId('a:b');
      const zeroLedThreePart = sanitizeIngressJobId('0:tenant:123'); // Queue.addJob: "cannot start with '0:'"
      for (const hashed of [integer, redrive, twoPart, zeroLedThreePart]) {
        expect(hashed).toMatch(/^ing-[0-9a-f]{40}$/);
        expect(hashed).not.toContain(':');
      }
      expect(sanitizeIngressJobId('12345')).toBe(integer);
      expect(sanitizeIngressJobId('redrive:3f8e2a1b-9c4d-4e6f-8a2b-7d1c0e5f9a3b')).toBe(redrive);
      expect(sanitizeIngressJobId('0')).toMatch(/^ing-/); // Queue.addJob rejects the literal '0' too
    });

    it('coerces a non-string id (a duplicated header can surface as string[]) instead of throwing', () => {
      const coerced = sanitizeIngressJobId(['0:tenant', '123'] as unknown as string);
      expect(coerced).toMatch(/^ing-[0-9a-f]{40}$/);
    });

    it('namespaces the hash by plugin/instance so two instances sharing a numeric id do not collide', () => {
      // BullMQ dedups jobIds across the whole shared queue while the DB dedup is
      // (pluginId, instanceId, providerDeliveryId); numeric provider ids are per-account sequences.
      const a = sanitizeIngressJobId('12345', 'chatwoot\u0000acct-1');
      const b = sanitizeIngressJobId('12345', 'chatwoot\u0000acct-2');
      expect(a).toMatch(/^ing-[0-9a-f]{40}$/);
      expect(a).not.toBe(b);
      expect(sanitizeIngressJobId('12345', 'chatwoot\u0000acct-1')).toBe(a); // stable for replays
    });

    it.each([
      ['a numeric provider dedup header', '12345'],
      ['the redrive replay id', 'redrive:3f8e2a1b-9c4d-4e6f-8a2b-7d1c0e5f9a3b'],
      ['a two-part colon id', 'a:b'],
      ['a zero-led three-part colon id', '0:tenant:123'],
    ])('still queues (%s) instead of tripping the inline fallback', async (_label, jobId) => {
      (config.get as jest.Mock).mockReturnValue(true);
      const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

      expect(await svc.enqueue(data, jobId)).toEqual({ outcome: 'queued' });

      expect(queue.add).toHaveBeenCalledWith('ingress', data, {
        jobId: sanitizeIngressJobId(jobId, `${data.pluginId}\u0000${data.instanceId}`),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      expect(loader.dispatchWebhookForInstance).not.toHaveBeenCalled();
    });
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

  describe('onApplicationBootstrap (queue-wiring tripwire)', () => {
    const ORIGINAL = process.env.QUEUE_ENABLED;

    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.QUEUE_ENABLED;
      else process.env.QUEUE_ENABLED = ORIGINAL;
    });

    it('throws when QUEUE_ENABLED=true but no queue resolved (broken wiring must fail the boot)', () => {
      process.env.QUEUE_ENABLED = 'true';
      const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, undefined);

      expect(() => svc.onApplicationBootstrap()).toThrow(
        /QUEUE_ENABLED=true but the 'ingress-queue' BullMQ queue did not resolve/,
      );
    });

    it('does not throw when QUEUE_ENABLED=true and the queue resolved', () => {
      process.env.QUEUE_ENABLED = 'true';
      const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

      expect(() => svc.onApplicationBootstrap()).not.toThrow();
    });

    it.each(['false', undefined])(
      'does not throw when QUEUE_ENABLED=%s and no queue resolved (inline is the contract)',
      value => {
        if (value === undefined) delete process.env.QUEUE_ENABLED;
        else process.env.QUEUE_ENABLED = value;
        const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, undefined);

        expect(() => svc.onApplicationBootstrap()).not.toThrow();
      },
    );
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
      jobId: sanitizeIngressJobId('d1', 'chatwoot\u0000acct1'),
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

    it.each(['1e1', '0x10', '0'])('falls back to 3 attempts for INGRESS_MAX_ATTEMPTS=%p', raw => {
      const prevA = process.env.INGRESS_MAX_ATTEMPTS;
      try {
        process.env.INGRESS_MAX_ATTEMPTS = raw;
        expect(resolveIngressJobOptions().attempts).toBe(3);
      } finally {
        if (prevA === undefined) delete process.env.INGRESS_MAX_ATTEMPTS;
        else process.env.INGRESS_MAX_ATTEMPTS = prevA;
      }
    });

    it('treats a blank INGRESS_RETRY_DELAY_MS as unset, not as 0', () => {
      const prevD = process.env.INGRESS_RETRY_DELAY_MS;
      try {
        process.env.INGRESS_RETRY_DELAY_MS = '';
        expect(resolveIngressJobOptions()).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      } finally {
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
