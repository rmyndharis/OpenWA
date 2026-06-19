import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WebhookProcessor } from './webhook.processor';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { HookManager } from '../../../core/hooks';
import { WebhookJobData } from '../../webhook/webhook.service';
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
        signature: '',
        headers: { 'Content-Type': 'application/json' },
        attempt: 1,
        maxRetries: 3,
        ...overrides,
      },
    }) as unknown as Job<WebhookJobData>;

  beforeEach(() => {
    repo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    hookManager = { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) };
    configService = { get: jest.fn((key: string, def?: unknown) => (key === 'webhook.timeout' ? 25000 : def)) };
    processor = new WebhookProcessor(
      repo as unknown as Repository<Webhook>,
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

  it('refuses to follow a redirect when SSRF protection is on', async () => {
    process.env.WEBHOOK_SSRF_PROTECT = 'true';
    mockFetch.mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' });

    await expect(processor.process(makeJob({ maxRetries: 1 }, 0))).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledWith('https://8.8.8.8/hook', expect.objectContaining({ redirect: 'manual' }));
    expect(repo.update).not.toHaveBeenCalled(); // never treated as delivered
  });
});
