import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WebhookProcessor } from './webhook.processor';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import { HookManager } from '../../../core/hooks';
import { WebhookJobData } from '../../webhook/webhook.service';
import { getWebhookDeliveryFailuresTotal } from '../../../common/metrics/webhook-delivery-metrics';
import { fetch as undiciFetch } from 'undici';

// Delivery goes through undici's fetch (via the SSRF-pinning helper), so mock that, not global fetch.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

/**
 * Regression coverage for the production (QUEUE_ENABLED) webhook delivery path, which was
 * previously untested. Covers the success path, the off-by-one final-attempt gate, the
 * retry-count header, and the redirect refusal when SSRF protection is on.
 */
describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;
  let repo: { update: jest.Mock };
  let failureRepo: { insert: jest.Mock };
  let hookManager: { execute: jest.Mock };
  let configService: { get: jest.Mock };
  let mockFetch: jest.Mock;
  const origProtect = process.env.WEBHOOK_SSRF_PROTECT;

  const makeJob = (overrides: Partial<WebhookJobData> = {}, attemptsMade = 0): Job<WebhookJobData> =>
    ({
      id: 'job-1',
      attemptsMade,
      data: {
        webhookId: 'wh-1',
        url: 'https://8.8.8.8/hook', // IP literal → SSRF guard needs no DNS lookup
        event: 'message.received',
        payload: {
          event: 'message.received',
          timestamp: '',
          sessionId: 'sess-1',
          idempotencyKey: 'k',
          deliveryId: 'd',
          data: {},
        },
        headers: { 'Content-Type': 'application/json' },
        attempt: 1,
        maxRetries: 3,
        ...overrides,
      },
    }) as unknown as Job<WebhookJobData>;

  beforeEach(() => {
    repo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    failureRepo = { insert: jest.fn().mockResolvedValue({}) };
    hookManager = { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) };
    configService = { get: jest.fn((key: string, def?: unknown) => (key === 'webhook.timeout' ? 25000 : def)) };
    processor = new WebhookProcessor(
      repo as unknown as Repository<Webhook>,
      failureRepo as unknown as Repository<WebhookDeliveryFailure>,
      hookManager as unknown as HookManager,
      configService as unknown as ConfigService,
    );
    // The merged delivery path uses withSafeFetch (undici), so mock undici's fetch, not global.fetch.
    mockFetch = undiciFetch as jest.Mock;
    process.env.WEBHOOK_SSRF_PROTECT = 'false'; // delivery-logic tests; redirect test flips it on
  });

  afterEach(() => {
    mockFetch.mockReset();
    if (origProtect === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = origProtect;
  });

  it('uses the configured WEBHOOK_TIMEOUT for the request abort signal (not a hardcoded 10s)', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await processor.process(makeJob());

    expect(configService.get).toHaveBeenCalledWith('webhook.timeout', 10000);
    expect(timeoutSpy).toHaveBeenCalledWith(25000);
    timeoutSpy.mockRestore();
  });

  it('on success updates lastTriggeredAt and fires webhook:delivered', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await processor.process(makeJob());

    expect(result.success).toBe(true);
    expect(repo.update).toHaveBeenCalledTimes(1);
    const updateArgs = repo.update.mock.calls[0] as unknown as [string, { lastTriggeredAt: Date }];
    expect(updateArgs[0]).toBe('wh-1');
    expect(updateArgs[1].lastTriggeredAt).toBeInstanceOf(Date);
    expect(hookManager.execute).toHaveBeenCalledWith('webhook:delivered', expect.anything(), expect.anything());
  });

  it('sets X-OpenWA-Retry-Count to the attempt number', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await processor.process(makeJob({}, 2));

    const call = mockFetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['X-OpenWA-Retry-Count']).toBe('2');
  });

  it('throws on a non-ok response WITHOUT firing webhook:error before the final attempt', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    await expect(processor.process(makeJob({ maxRetries: 3 }, 0))).rejects.toThrow();
    expect(hookManager.execute).not.toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
  });

  it('fires webhook:error only on the final attempt', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    // attemptsMade=2, maxRetries=3 -> attemptsMade+1 >= maxRetries -> final
    await expect(processor.process(makeJob({ maxRetries: 3 }, 2))).rejects.toThrow();
    expect(hookManager.execute).toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
  });

  it('persists a durable delivery-failure record on the final attempt (with parsed HTTP status)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

    await expect(
      processor.process(makeJob({ maxRetries: 3, webhookId: 'wh-x', url: 'https://8.8.8.8/h' }, 2)),
    ).rejects.toThrow();

    expect(failureRepo.insert).toHaveBeenCalledTimes(1);
    expect(failureRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: 'wh-x',
        url: 'https://8.8.8.8/h',
        sessionId: 'sess-1',
        attempts: 3,
        lastStatusCode: 503,
        lastError: 'HTTP 503: Service Unavailable',
      }),
    );
  });

  it('does NOT persist a delivery-failure record before the final attempt', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    await expect(processor.process(makeJob({ maxRetries: 3 }, 0))).rejects.toThrow();
    expect(failureRepo.insert).not.toHaveBeenCalled();
  });

  it('refuses to follow a redirect when SSRF protection is on', async () => {
    process.env.WEBHOOK_SSRF_PROTECT = 'true';
    mockFetch.mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' });

    await expect(processor.process(makeJob({ maxRetries: 1 }, 0))).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledWith('https://8.8.8.8/hook', expect.objectContaining({ redirect: 'manual' }));
    expect(repo.update).not.toHaveBeenCalled(); // never treated as delivered
  });

  // A literal link-local IP triggers the SSRF guard synchronously before any fetch/DNS, so this is
  // fully offline. The webhook:error hook payload and the durable DLQ row must both carry the generic
  // message — the resolved internal IP is a recon oracle. The server-side logger.error keeps full detail.
  it('redacts the resolved internal IP from the webhook:error payload and DLQ row on an SSRF block', async () => {
    process.env.WEBHOOK_SSRF_PROTECT = 'true';
    // final attempt (attemptsMade=0, maxRetries=1 → 1 >= 1) so the hook + DLQ fire
    await expect(processor.process(makeJob({ url: 'https://169.254.169.254/h', maxRetries: 1 }, 0))).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled(); // blocked before any network

    const hookCalls = hookManager.execute.mock.calls as unknown as Array<[string, { error: string }, unknown]>;
    const errorHookCall = hookCalls.find(c => c[0] === 'webhook:error');
    expect(errorHookCall).toBeDefined();
    expect(errorHookCall![1].error).toBe('Destination address is not allowed');
    expect(errorHookCall![1].error).not.toMatch(/169\.254\.169\.254/);

    expect(failureRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = (failureRepo.insert.mock.calls[0] as unknown[])[0] as { lastError: string };
    expect(inserted.lastError).toBe('Destination address is not allowed');
    expect(inserted.lastError).not.toMatch(/169\.254\.169\.254/);
  });

  it('keeps the success outcome when post-delivery bookkeeping fails after a 2xx (no retry, no DLQ row)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    repo.update.mockRejectedValue(new Error('db down'));
    const failuresBefore = getWebhookDeliveryFailuresTotal();

    // Final attempt (attemptsMade=2, maxRetries=3): a bookkeeping throw reaching the catch would
    // file a dead-letter row AND rethrow for a retry — over an already-delivered event.
    const result = await processor.process(makeJob({ maxRetries: 3 }, 2));

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(failureRepo.insert).not.toHaveBeenCalled();
    expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore);
    expect(hookManager.execute).toHaveBeenCalledWith('webhook:delivered', expect.anything(), expect.anything());
    expect(hookManager.execute).not.toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
  });

  // BullMQ fails a job that stalls more than maxStalledCount (default 1) WITHOUT calling process():
  // the worker emits 'failed' with "job stalled more than allowable limit". Those failures must land
  // in the same dead-letter/metric/hook channels as an ordinary final-attempt failure.
  describe('stall exhaustion (worker failed event)', () => {
    it('records a dead-letter row, metric, and webhook:error for a job failed by a double stall', async () => {
      const failuresBefore = getWebhookDeliveryFailuresTotal();

      await processor.onWorkerFailed(
        makeJob({ webhookId: 'wh-stall', url: 'https://8.8.8.8/s' }, 1),
        new Error('job stalled more than allowable limit'),
      );

      expect(failureRepo.insert).toHaveBeenCalledTimes(1);
      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 'wh-stall',
          url: 'https://8.8.8.8/s',
          sessionId: 'sess-1',
          attempts: 1,
          lastStatusCode: null, // no HTTP exchange completed on the stalled attempts
          lastError: 'job stalled more than allowable limit',
        }),
      );
      expect(hookManager.execute).toHaveBeenCalledWith(
        'webhook:error',
        expect.objectContaining({ webhookId: 'wh-stall', error: 'job stalled more than allowable limit' }),
        expect.anything(),
      );
      expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore + 1);
    });

    it('ignores ordinary delivery failures — process() already records those on the final attempt', async () => {
      await processor.onWorkerFailed(makeJob(), new Error('HTTP 500: Server Error'));

      expect(failureRepo.insert).not.toHaveBeenCalled();
      expect(hookManager.execute).not.toHaveBeenCalled();
    });

    it('ignores an undefined job (BullMQ may pass none when removeOnFail deleted it first)', async () => {
      await processor.onWorkerFailed(undefined, new Error('job stalled more than allowable limit'));

      expect(failureRepo.insert).not.toHaveBeenCalled();
      expect(hookManager.execute).not.toHaveBeenCalled();
    });
  });
});
