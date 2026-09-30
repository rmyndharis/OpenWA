import { DelayedError, Job } from 'bullmq';
import { FindOperator, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WebhookProcessor } from './webhook.processor';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import { HookManager } from '../../../core/hooks';
import { WebhookJobData } from '../../webhook/webhook.service';
import { getWebhookDeliveryFailuresTotal } from '../../../common/metrics/webhook-delivery-metrics';
import { fetch as undiciFetch } from 'undici';
import { createHmac } from 'crypto';

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
  let repo: { update: jest.Mock; findOne: jest.Mock };
  let failureRepo: { insert: jest.Mock; count: jest.Mock; delete: jest.Mock };
  let failureRows: Array<{ webhookId?: string; idempotencyKey?: string | null; attempts?: number }>;
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
        attempt: 1,
        maxRetries: 3,
        ...overrides,
      },
    }) as unknown as Job<WebhookJobData>;

  beforeEach(() => {
    repo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // The live row matches makeJob()'s snapshot unless a test says otherwise.
      findOne: jest.fn().mockResolvedValue({ id: 'wh-1', active: true, url: 'https://8.8.8.8/hook', events: ['*'] }),
    };
    // Stateful like the real table: the recorder counts existing rows for the delivery before it
    // inserts, so a constant would leave that guard unexercised here and let a duplicated row pass.
    failureRows = [];
    const insertedFailures = failureRows;
    failureRepo = {
      insert: jest.fn().mockImplementation((rowToInsert: { webhookId?: string; idempotencyKey?: string | null }) => {
        insertedFailures.push(rowToInsert);
        return Promise.resolve({});
      }),
      delete: jest
        .fn()
        .mockImplementation((where: { webhookId?: string; idempotencyKey?: string; attempts?: number }) => {
          const keep = failureRows.filter(
            r =>
              r.webhookId !== where.webhookId ||
              r.idempotencyKey !== where.idempotencyKey ||
              (where.attempts !== undefined && r.attempts !== where.attempts),
          );
          const affected = failureRows.length - keep.length;
          failureRows.splice(0, failureRows.length, ...keep);
          return Promise.resolve({ affected });
        }),
      count: jest
        .fn()
        .mockImplementation((opts: { where: { webhookId?: string; idempotencyKey?: string; attempts?: unknown } }) =>
          Promise.resolve(
            insertedFailures.filter(
              r =>
                r.webhookId === opts.where.webhookId &&
                r.idempotencyKey === opts.where.idempotencyKey &&
                (opts.where.attempts === undefined ||
                  (opts.where.attempts instanceof FindOperator && opts.where.attempts.type === 'moreThan'
                    ? ((r as { attempts?: number }).attempts ?? 0) > (opts.where.attempts.value as number)
                    : (r as { attempts?: number }).attempts === opts.where.attempts)),
            ).length,
          ),
        ),
    };
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
    repo.findOne.mockResolvedValue({ id: 'wh-x', active: true, url: 'https://8.8.8.8/h', events: ['*'] });

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

  it("replaces a replayed delivery's attempts-0 shed row with its own final-attempt row", async () => {
    // The shed row's dedup entry would otherwise suppress this row and keep only the capacity reason.
    failureRows.push({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

    await expect(processor.process(makeJob({ maxRetries: 3 }, 2))).rejects.toThrow();

    expect(failureRepo.delete).toHaveBeenCalledWith({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });
    expect(failureRows).toEqual([expect.objectContaining({ idempotencyKey: 'k', attempts: 3, lastStatusCode: 503 })]);
  });

  it('keeps the delivery error and both rows when the shed-row delete fails', async () => {
    // The final-attempt row is written before the shed row is removed, so a failed delete leaves
    // the event recorded twice rather than not at all. It is logged, not thrown: process() still
    // rejects with the HTTP error.
    failureRows.push({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });
    failureRepo.delete.mockRejectedValueOnce(new Error('db down'));
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

    await expect(processor.process(makeJob({ maxRetries: 3 }, 2))).rejects.toThrow('HTTP 503');

    expect(failureRows).toEqual([
      expect.objectContaining({ idempotencyKey: 'k', attempts: 0 }),
      expect.objectContaining({ idempotencyKey: 'k', attempts: 3, lastStatusCode: 503 }),
    ]);
  });

  it('deletes nothing for a job whose payload carries no idempotency key', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    const job = makeJob({ maxRetries: 3 }, 2);
    (job.data.payload as { idempotencyKey?: string }).idempotencyKey = undefined;

    await expect(processor.process(job)).rejects.toThrow();

    expect(failureRepo.delete).not.toHaveBeenCalled();
    expect(failureRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('leaves the shed row alone on an attempt that is not final', async () => {
    failureRows.push({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    await expect(processor.process(makeJob({ maxRetries: 3 }, 0))).rejects.toThrow();

    expect(failureRepo.delete).not.toHaveBeenCalled();
    expect(failureRows).toEqual([expect.objectContaining({ idempotencyKey: 'k', attempts: 0 })]);
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
    repo.findOne.mockResolvedValue({ id: 'wh-1', active: true, url: 'https://169.254.169.254/h', events: ['*'] });
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

  it('clears every failure row of the delivery once the job delivers it', async () => {
    // An earlier inline replay failed (attempts > 0) after a shed (attempts 0); this queued replay
    // then delivered. Both rows would list a delivered event as lost. Another delivery's row stays.
    failureRows.push(
      { webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 },
      { webhookId: 'wh-1', idempotencyKey: 'k', attempts: 3 },
      { webhookId: 'wh-1', idempotencyKey: 'other', attempts: 3 },
    );
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await expect(processor.process(makeJob())).resolves.toMatchObject({ success: true });

    expect(failureRows).toEqual([expect.objectContaining({ idempotencyKey: 'other' })]);
  });

  it('keeps the success outcome when clearing the failure rows fails', async () => {
    failureRepo.delete.mockRejectedValueOnce(new Error('db down'));
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await expect(processor.process(makeJob({ maxRetries: 3 }, 2))).resolves.toMatchObject({ success: true });

    expect(failureRepo.delete).toHaveBeenCalledTimes(1);
    expect(failureRepo.insert).not.toHaveBeenCalled();
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

  // The job is a snapshot from enqueue time; the operator may have changed the webhook since.
  describe('stale snapshot', () => {
    const live = { id: 'wh-1', active: true, url: 'https://8.8.8.8/hook', events: ['*'] };

    it.each([
      ['deleted', null],
      ['disabled', { ...live, active: false }],
      ['unsubscribed', { ...live, events: ['message.sent'] }],
    ])('does not POST, retry or dead-letter a job for a %s webhook', async (_label, row) => {
      repo.findOne.mockResolvedValue(row);
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Final attempt, so a failure path would file a dead-letter row.
      const result = await processor.process(makeJob({ maxRetries: 3 }, 2));

      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(failureRepo.insert).not.toHaveBeenCalled();
      expect(hookManager.execute).not.toHaveBeenCalled();
    });

    it('treats a failed webhook read as a failed attempt: retried, and dead-lettered on the last one', async () => {
      repo.findOne.mockRejectedValue(new Error('db down'));

      await expect(processor.process(makeJob({ maxRetries: 3 }, 0))).rejects.toThrow('db down');
      expect(failureRepo.insert).not.toHaveBeenCalled();

      await expect(processor.process(makeJob({ maxRetries: 3 }, 2))).rejects.toThrow('db down');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(failureRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('delivers to the current URL with the current headers and secret, not the enqueue-time ones', async () => {
      repo.findOne.mockResolvedValue({
        ...live,
        url: 'https://8.8.4.4/new',
        events: ['message.received'],
        headers: { Authorization: 'Bearer new' },
        secret: 'rotated',
      });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      // Jobs no longer carry headers, but one enqueued by an earlier release still holds a snapshot
      // in Redis; it must be ignored in favour of the current row.
      const job = makeJob({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer old',
          'X-OpenWA-Signature': 'sha256=old',
        },
      } as Partial<WebhookJobData>);

      const result = await processor.process(job);

      expect(result.success).toBe(true);
      const [url, init] = mockFetch.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      expect(url).toBe('https://8.8.4.4/new');
      expect(init.headers.Authorization).toBe('Bearer new');
      const expected = `sha256=${createHmac('sha256', 'rotated').update(init.body).digest('hex')}`;
      expect(init.headers['X-OpenWA-Signature']).toBe(expected);
      expect(init.body).toBe(JSON.stringify(job.data.payload));
    });
  });

  // BullMQ fails a job that stalls more than maxStalledCount (default 1) WITHOUT calling process():
  // the worker emits 'failed' with "job stalled more than allowable limit". Those failures must land
  // in the same dead-letter/metric/hook channels as an ordinary final-attempt failure.
  describe('stall exhaustion (worker failed event)', () => {
    it('records a dead-letter row, metric, and webhook:error for a job failed by a double stall', async () => {
      const failuresBefore = getWebhookDeliveryFailuresTotal();
      // Re-pointed since enqueue: the row names the URL a retry would have used, not the snapshot's.
      repo.findOne.mockResolvedValue({ id: 'wh-stall', active: true, url: 'https://8.8.8.8/s', events: ['*'] });

      await processor.onWorkerFailed(
        makeJob({ webhookId: 'wh-stall', url: 'https://8.8.8.8/old' }, 1),
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

    it.each([
      ['deleted', null],
      ['disabled', { id: 'wh-1', active: false, url: 'https://8.8.8.8/hook', events: ['*'] }],
    ])('files nothing for a job whose webhook was %s', async (_label, row) => {
      repo.findOne.mockResolvedValue(row);

      await processor.onWorkerFailed(makeJob({}, 1), new Error('job stalled more than allowable limit'));

      expect(failureRepo.insert).not.toHaveBeenCalled();
      expect(hookManager.execute).not.toHaveBeenCalled();
    });

    it("replaces a replayed delivery's attempts-0 shed row with the stall row", async () => {
      failureRows.push({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });

      await processor.onWorkerFailed(makeJob({}, 1), new Error('job stalled more than allowable limit'));

      expect(failureRows).toEqual([
        expect.objectContaining({
          idempotencyKey: 'k',
          attempts: 1,
          lastError: 'job stalled more than allowable limit',
        }),
      ]);
    });

    it('still files the stall row when the shed-row delete fails', async () => {
      failureRepo.delete.mockRejectedValueOnce(new Error('db down'));

      await processor.onWorkerFailed(makeJob({}, 1), new Error('job stalled more than allowable limit'));

      expect(failureRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'k', attempts: 1 }));
    });

    it('still records the stall against the enqueue-time URL when the webhook row cannot be read', async () => {
      repo.findOne.mockRejectedValue(new Error('db down'));

      await processor.onWorkerFailed(makeJob({}, 1), new Error('job stalled more than allowable limit'));

      expect(failureRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://8.8.8.8/hook' }));
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

  describe('failing-receiver gate', () => {
    // One slot per session for failing receivers, so the arithmetic below stays small.
    const gatedProcessor = (retryDelay = 1000): WebhookProcessor => {
      configService.get.mockImplementation((key: string, def?: unknown) => {
        if (key === 'webhook.degradedSessionConcurrency') return 1;
        if (key === 'webhook.retryDelay') return retryDelay;
        return key === 'webhook.timeout' ? 25000 : def;
      });
      return new WebhookProcessor(
        repo as unknown as Repository<Webhook>,
        failureRepo as unknown as Repository<WebhookDeliveryFailure>,
        hookManager as unknown as HookManager,
        configService as unknown as ConfigService,
      );
    };
    const withMoveToDelayed = (job: Job<WebhookJobData>): jest.Mock => {
      const move = jest.fn().mockResolvedValue(undefined);
      (job as unknown as { moveToDelayed: jest.Mock }).moveToDelayed = move;
      return move;
    };
    const hang = (): { release: () => void } => {
      const handle = { release: () => undefined as void };
      mockFetch.mockImplementationOnce(
        () => new Promise(resolve => (handle.release = () => resolve({ ok: true, status: 200 }))),
      );
      return handle;
    };

    it('delays a job for a failing webhook past the session cap without spending an attempt or failing it', async () => {
      const gp = gatedProcessor();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
      await expect(gp.process(makeJob())).rejects.toThrow('HTTP 500');
      const first = hang();
      mockFetch.mockClear();
      const inFlight = gp.process(makeJob(), 'tok-1');
      await new Promise(resolve => setImmediate(resolve));
      repo.findOne.mockClear();
      failureRepo.insert.mockClear();

      // The last attempt of its job: a gate bounce must still not dead-letter it.
      const job = makeJob({}, 2);
      const move = withMoveToDelayed(job);
      const before = Date.now();
      await expect(gp.process(job, 'tok-2')).rejects.toBeInstanceOf(DelayedError);

      expect(move).toHaveBeenCalledWith(expect.any(Number), 'tok-2');
      expect((move.mock.calls[0] as [number])[0]).toBeGreaterThanOrEqual(before + 1000);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1); // only the in-flight job's POST
      expect(failureRepo.insert).not.toHaveBeenCalled();

      first.release();
      await inFlight;
    });

    // BullMQ promotes a job delayed to "now" straight back to wait, so a zero delay would spin it.
    it('waits at least a second before a bounced job returns, even with WEBHOOK_RETRY_DELAY=0', async () => {
      const gp = gatedProcessor(0);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
      await expect(gp.process(makeJob())).rejects.toThrow('HTTP 500');
      const first = hang();
      const inFlight = gp.process(makeJob(), 'tok-1');
      await new Promise(resolve => setImmediate(resolve));

      const job = makeJob();
      const move = withMoveToDelayed(job);
      const before = Date.now();
      await expect(gp.process(job, 'tok-2')).rejects.toBeInstanceOf(DelayedError);

      expect((move.mock.calls[0] as [number])[0]).toBeGreaterThanOrEqual(before + 1000);
      first.release();
      await inFlight;
    });

    it('never holds back a healthy webhook, however many of its jobs run at once', async () => {
      const gp = gatedProcessor();
      const a = hang();
      const b = hang();
      const jobs = [gp.process(makeJob()), gp.process(makeJob())];
      await new Promise(resolve => setImmediate(resolve));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      a.release();
      b.release();
      await Promise.all(jobs);
    });

    it('lifts the gate when a job finds its failing webhook gone', async () => {
      const gp = gatedProcessor();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
      await expect(gp.process(makeJob())).rejects.toThrow('HTTP 500');
      repo.findOne.mockResolvedValueOnce(null);
      await expect(gp.process(makeJob())).resolves.toMatchObject({ success: false });

      // Re-created or re-enabled under the same id: its jobs are no longer held to one slot.
      const a = hang();
      const b = hang();
      const jobs = [gp.process(makeJob()), gp.process(makeJob())];
      await new Promise(resolve => setImmediate(resolve));
      expect(mockFetch).toHaveBeenCalledTimes(3);
      a.release();
      b.release();
      await Promise.all(jobs);
    });

    it('lifts the gate once the webhook answers 2xx again, and frees the slot on success and on failure', async () => {
      const gp = gatedProcessor();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
      await expect(gp.process(makeJob())).rejects.toThrow('HTTP 500');
      // Gated now, with a free slot: a failing job takes it and gives it back when it throws.
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
      await expect(gp.process(makeJob())).rejects.toThrow('HTTP 500');
      // ...and a succeeding job takes it, gives it back, and clears the failing mark.
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      await expect(gp.process(makeJob())).resolves.toMatchObject({ success: true });

      const a = hang();
      const b = hang();
      const jobs = [gp.process(makeJob()), gp.process(makeJob())];
      await new Promise(resolve => setImmediate(resolve));
      expect(mockFetch).toHaveBeenCalledTimes(5);
      a.release();
      b.release();
      await Promise.all(jobs);
    });
  });
});
