// SSRF protection is now ON by default; resolve any host to a public IP so existing
// dispatch/create tests stay offline. Literal-IP tests (8.8.8.8 / 127.0.0.1) bypass lookup.
jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

// Webhook delivery goes through undici's fetch (via the SSRF-pinning helper); mock it, not global fetch.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { In, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { fetch as undiciFetch } from 'undici';
import { WebhookService, WebhookPayload, WebhookJobData } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookFilters } from './filters/filter-types';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { HookManager } from '../../core/hooks';
import { QUEUE_NAMES } from '../queue/queue-names';
import { Session } from '../session/entities/session.entity';
import { getWebhookDeliveryFailuresTotal } from '../../common/metrics/webhook-delivery-metrics';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

function createMockWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-uuid-1',
    sessionId: 'sess-1',
    url: 'https://example.com/webhook',
    events: ['message.received'],
    secret: null,
    headers: {},
    filters: null,
    active: true,
    retryCount: 3,
    lastTriggeredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    session: undefined as unknown as Session,
    ...overrides,
  };
}

describe('WebhookService', () => {
  let service: WebhookService;
  let repository: jest.Mocked<Partial<Repository<Webhook>>>;
  let failureRepository: jest.Mocked<Partial<Repository<WebhookDeliveryFailure>>>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let webhookQueue: jest.Mocked<Record<string, jest.Mock>>;
  let lidStore: { getCached: jest.Mock };

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };

    failureRepository = {
      insert: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    configService = {
      get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.retryDelay') return 100;
        // Distinct from the hardcoded 10000 fallback so a regression to a literal timeout is caught.
        if (key === 'webhook.timeout') return 25000;
        // A small, non-default cap so the fan-out-bound test (5 webhooks) can assert the limiter holds.
        if (key === 'webhook.dispatchConcurrency') return 2;
        return def as T;
      }),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', event: 'message.received', payload: {} },
      }),
    };

    webhookQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    lidStore = { getCached: jest.fn().mockReturnValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
        { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
        { provide: ConfigService, useValue: configService },
        { provide: HookManager, useValue: hookManager },
        { provide: LidMappingStoreService, useValue: lidStore },
        { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  // ── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a webhook with default events', async () => {
      const webhook = createMockWebhook();
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      const result = await service.create('sess-1', {
        url: 'https://example.com/webhook',
      });

      expect(result.sessionId).toBe('sess-1');
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          events: ['message.received'],
        }),
      );
    });

    it('should create webhook with custom events and secret', async () => {
      const webhook = createMockWebhook({
        events: ['*'],
        secret: 'my-secret',
      });
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      await service.create('sess-1', {
        url: 'https://example.com/webhook',
        events: ['*'],
        secret: 'my-secret',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          events: ['*'],
          secret: 'my-secret',
        }),
      );
    });

    // ── validate URL at registration, default-on ──────────

    it('rejects an internal webhook URL at registration with 400 and a generic message (no IP leak)', async () => {
      const origProtect = process.env.WEBHOOK_SSRF_PROTECT;
      delete process.env.WEBHOOK_SSRF_PROTECT; // default → on
      try {
        await expect(service.create('sess-1', { url: 'http://127.0.0.1/hook' })).rejects.toMatchObject({
          response: { message: 'Destination address is not allowed' },
        });
        expect(repository.create).not.toHaveBeenCalled();
      } finally {
        if (origProtect === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
        else process.env.WEBHOOK_SSRF_PROTECT = origProtect;
      }
    });

    it('accepts an internal webhook URL when protection is explicitly disabled', async () => {
      const origProtect = process.env.WEBHOOK_SSRF_PROTECT;
      process.env.WEBHOOK_SSRF_PROTECT = 'false';
      try {
        const webhook = createMockWebhook({ url: 'http://127.0.0.1/hook' });
        (repository.create as jest.Mock).mockReturnValue(webhook);
        (repository.save as jest.Mock).mockResolvedValue(webhook);

        await expect(service.create('sess-1', { url: 'http://127.0.0.1/hook' })).resolves.toBeDefined();
      } finally {
        if (origProtect === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
        else process.env.WEBHOOK_SSRF_PROTECT = origProtect;
      }
    });

    // ── per-session fan-out cap ───────────────────────────

    it('rejects a NEW webhook with 400 once the session is at the per-session cap (default 16)', async () => {
      (repository.count as jest.Mock).mockResolvedValue(16);

      await expect(service.create('sess-1', { url: 'https://example.com/webhook' })).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.create('sess-1', { url: 'https://example.com/webhook' })).rejects.toThrow(
        /Webhook limit reached/,
      );
      // Refused BEFORE persisting — and grandfathered rows are never deleted to make room.
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    });

    it('creates the webhook while the session is under the cap', async () => {
      (repository.count as jest.Mock).mockResolvedValue(15);
      const webhook = createMockWebhook();
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      await expect(service.create('sess-1', { url: 'https://example.com/webhook' })).resolves.toBeDefined();
      expect(repository.count).toHaveBeenCalledWith({ where: { sessionId: 'sess-1' } });
    });

    it('honors a custom WEBHOOK_MAX_PER_SESSION', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'webhook.maxPerSession') return 2;
        return def as T;
      });
      (repository.count as jest.Mock).mockResolvedValue(2);

      await expect(service.create('sess-1', { url: 'https://example.com/webhook' })).rejects.toMatchObject({
        status: 400,
      });
    });

    it('WEBHOOK_MAX_PER_SESSION=0 disables the cap (legacy unlimited behavior)', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'webhook.maxPerSession') return 0;
        return def as T;
      });
      (repository.count as jest.Mock).mockResolvedValue(9999);
      const webhook = createMockWebhook();
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      await expect(service.create('sess-1', { url: 'https://example.com/webhook' })).resolves.toBeDefined();
      expect(repository.count).not.toHaveBeenCalled(); // no count query when the cap is off
    });
  });

  // ── findBySession / findAll / findOne ──────────────────────────────

  describe('findBySession', () => {
    it('should return webhooks for a session', async () => {
      const webhooks = [createMockWebhook()];
      (repository.find as jest.Mock).mockResolvedValue(webhooks);

      const result = await service.findBySession('sess-1');

      expect(result).toHaveLength(1);
      expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'sess-1' } }));
    });
  });

  describe('findAll', () => {
    it('should return all webhooks ordered by createdAt DESC', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll();

      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' }, take: 1000, skip: 0 });
    });

    it('applies bounded pagination to cross-session listing', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(['sess-1'], { limit: 5000, offset: -5 });

      expect(repository.find).toHaveBeenCalledWith({
        where: { sessionId: In(['sess-1']) },
        order: { createdAt: 'DESC' },
        take: 1000,
        skip: 0,
      });
    });
  });

  describe('findOne', () => {
    it('should return webhook by id', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);

      const result = await service.findOne('sess-1', 'wh-uuid-1');
      expect(result.id).toBe('wh-uuid-1');
    });

    it('should throw NotFoundException if not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('sess-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update only provided fields', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.save as jest.Mock).mockImplementation(w => Promise.resolve(w));

      const result = await service.update('sess-1', 'wh-uuid-1', { url: 'https://new-url.com/hook' });

      expect(result.url).toBe('https://new-url.com/hook');
      expect(result.events).toEqual(['message.received']); // unchanged
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should remove the webhook', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.remove as jest.Mock).mockResolvedValue(webhook);

      await service.delete('sess-1', 'wh-uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(webhook);
    });
  });

  // ── dispatch (direct mode — queue disabled) ───────────────────────

  describe('delivery-failure retention', () => {
    afterEach(() => service.onModuleDestroy());

    it('pruneDeliveryFailures deletes rows older than the retention window and returns the count', async () => {
      (failureRepository.delete as jest.Mock).mockResolvedValue({ affected: 3 });
      await expect(service.pruneDeliveryFailures(90)).resolves.toBe(3);
      expect(failureRepository.delete).toHaveBeenCalledTimes(1);
    });

    it('onModuleInit skips scheduling when WEBHOOK_FAILURE_RETENTION_DAYS <= 0 (retention disabled)', () => {
      const prev = process.env.WEBHOOK_FAILURE_RETENTION_DAYS;
      process.env.WEBHOOK_FAILURE_RETENTION_DAYS = '0';
      try {
        service.onModuleInit();
        expect(failureRepository.delete).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.WEBHOOK_FAILURE_RETENTION_DAYS;
        else process.env.WEBHOOK_FAILURE_RETENTION_DAYS = prev;
      }
    });

    it('onModuleInit prunes once at startup when retention is enabled', () => {
      const prev = process.env.WEBHOOK_FAILURE_RETENTION_DAYS;
      process.env.WEBHOOK_FAILURE_RETENTION_DAYS = '30';
      try {
        service.onModuleInit();
        expect(failureRepository.delete).toHaveBeenCalledTimes(1);
      } finally {
        if (prev === undefined) delete process.env.WEBHOOK_FAILURE_RETENTION_DAYS;
        else process.env.WEBHOOK_FAILURE_RETENTION_DAYS = prev;
      }
    });
  });

  // The drain bound at shutdown must cover the per-delivery timeout, or a delivery that takes nearly
  // the full timeout is abandoned at shutdown. The defaults already cross (drain 5s < timeout 10s),
  // so the warning is the only signal an operator gets that their config silently truncates deliveries.
  describe('onModuleInit drain-vs-timeout warning', () => {
    const drainSpy = () =>
      jest.spyOn((service as unknown as { logger: { warn: jest.Mock; error: jest.Mock } }).logger, 'warn');

    const withConfig = (drainMs: number, timeoutMs: number, fn: () => void): void => {
      const orig = configService.get as jest.Mock;
      const impl = orig.getMockImplementation() as ((key: string, def?: unknown) => unknown) | undefined;
      orig.mockImplementation((key: string, def?: unknown) => {
        if (key === 'webhook.shutdownDrainMs') return drainMs;
        if (key === 'webhook.timeout') return timeoutMs;
        // Preserve the other keys the service reads at startup (queue.enabled etc.) by delegating
        // to the original implementation for anything we did not override.
        if (impl) return impl(key, def);
        return def;
      });
      try {
        fn();
      } finally {
        if (impl) orig.mockImplementation(impl);
      }
    };

    it('warns when WEBHOOK_SHUTDOWN_DRAIN_MS < WEBHOOK_TIMEOUT (the default-derived cross)', () => {
      const warn = drainSpy();
      withConfig(5000, 10000, () => service.onModuleInit());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('WEBHOOK_SHUTDOWN_DRAIN_MS');
      expect(warn.mock.calls[0][0]).toContain('WEBHOOK_TIMEOUT');
    });

    it('does not warn when WEBHOOK_SHUTDOWN_DRAIN_MS >= WEBHOOK_TIMEOUT (drain covers the delivery)', () => {
      const warn = drainSpy();
      withConfig(15000, 10000, () => service.onModuleInit());
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when either value is non-finite (let the per-call site handle a bad config)', () => {
      const warn = drainSpy();
      withConfig(Number.NaN, 10000, () => service.onModuleInit());
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('dispatch (direct mode)', () => {
    const mockFetch = undiciFetch as jest.Mock;

    beforeEach(() => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    afterEach(() => {
      mockFetch.mockReset();
    });

    it('resolves (never rejects) when the webhook lookup fails — callers fire-and-forget it', async () => {
      (repository.find as jest.Mock).mockRejectedValue(new Error('db down'));
      await expect(service.dispatch('sess-1', 'message.received', { x: 1 })).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should dispatch to webhooks matching the event', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Mock hook to return the payload properly
      const mockPayload: WebhookPayload = {
        event: 'message.received',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        idempotencyKey: 'test-key',
        deliveryId: 'test-delivery',
        data: { from: '628123456789@c.us' },
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: mockPayload,
        },
      });

      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );
      // Direct delivery path honors the configured WEBHOOK_TIMEOUT, not a literal 10s.
      expect(timeoutSpy).toHaveBeenCalledWith(25000);
      timeoutSpy.mockRestore();
    });

    it('dispatches to sibling webhooks concurrently — a slow receiver does not block the others', async () => {
      const wA = createMockWebhook({ id: 'wh-a', url: 'https://a.example/hook', events: ['message.received'] });
      const wB = createMockWebhook({ id: 'wh-b', url: 'https://b.example/hook', events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([wA, wB]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      let resolveSlow: (v: unknown) => void = () => undefined;
      const slow = new Promise(r => (resolveSlow = r));
      const calledUrls: string[] = [];
      mockFetch.mockImplementation((url: string) => {
        calledUrls.push(url);
        return url.includes('a.example') ? slow : Promise.resolve({ ok: true, status: 200 });
      });

      const dispatchP = service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });
      // Flush until both fetches fire (or give up): with the old sequential loop, only A ever fires while
      // it hangs, so this exhausts and the assertion below fails — exactly the regression we guard.
      for (let i = 0; i < 20 && calledUrls.length < 2; i++) {
        await new Promise(r => setImmediate(r));
      }

      // B is delivered even though A is still hanging — sequential code would not have reached B yet.
      expect(calledUrls).toEqual(expect.arrayContaining(['https://a.example/hook', 'https://b.example/hook']));

      resolveSlow({ ok: true, status: 200 });
      await dispatchP;
    });

    it('bounds concurrent delivery to WEBHOOK_DISPATCH_CONCURRENCY (cap=2, 5 webhooks → peak ≤ 2)', async () => {
      const hooks = Array.from({ length: 5 }, (_, i) =>
        createMockWebhook({ id: `wh-${i}`, url: `https://h${i}.example/hook`, events: ['message.received'] }),
      );
      (repository.find as jest.Mock).mockResolvedValue(hooks);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      let inFlight = 0;
      let peak = 0;
      let resolved = 0;
      const releasers: Array<() => void> = [];
      mockFetch.mockImplementation(
        () =>
          new Promise(resolve => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            releasers.push(() => {
              inFlight -= 1;
              resolved += 1;
              resolve({ ok: true, status: 200 });
            });
          }),
      );

      const dispatchP = service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });
      // Let the limiter admit up to the cap (2) and each reach fetch. The other 3 stay parked.
      for (let i = 0; i < 20 && releasers.length < 2; i++) {
        await new Promise(r => setImmediate(r));
      }
      expect(inFlight).toBeLessThanOrEqual(2);
      // Release in a macrotask loop: freeing a slot lets the limiter admit the next webhook, whose fetch
      // pushes a fresh releaser on the NEXT tick — a single synchronous drain would miss it and hang.
      for (let i = 0; i < 50 && resolved < 5; i++) {
        while (releasers.length) (releasers.shift() as () => void)();
        await new Promise(r => setImmediate(r));
      }
      await dispatchP;
      // Peak across the whole run never exceeded the cap. (An unbounded fan-out would reach 5.)
      expect(peak).toBeLessThanOrEqual(2);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('records a durable failure when the bounded dispatch queue is full', async () => {
      const wA = createMockWebhook({ id: 'wh-a', url: 'https://a.example/hook', events: ['message.received'] });
      const wB = createMockWebhook({ id: 'wh-b', url: 'https://b.example/hook', events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([wA, wB]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockImplementation((_event: string, data: unknown) =>
        Promise.resolve({ continue: true, data }),
      );
      (service as unknown as { dispatchLimiter: ConcurrencyLimiter }).dispatchLimiter = new ConcurrencyLimiter(1, 0);

      let release: (value: unknown) => void = () => undefined;
      mockFetch.mockImplementation(() => new Promise(resolve => (release = resolve)));

      const pending = service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });
      for (let i = 0; i < 20 && mockFetch.mock.calls.length === 0; i++) await new Promise(r => setImmediate(r));
      release({ ok: true, status: 200 });
      await pending;

      expect(failureRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 'wh-b',
          attempts: 0,
          lastError: 'ConcurrencyLimiter queue full',
        }),
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('salts each sibling webhook with a distinct idempotency key so one receiver cannot dedupe out another', async () => {
      const wA = createMockWebhook({ id: 'wh-a', url: 'https://a.example/hook', events: ['message.received'] });
      const wB = createMockWebhook({ id: 'wh-b', url: 'https://b.example/hook', events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([wA, wB]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });

      const keyByUrl = new Map<string, string>();
      for (const call of mockFetch.mock.calls as [string, { headers: Record<string, string> }][]) {
        keyByUrl.set(call[0], call[1].headers['X-OpenWA-Idempotency-Key']);
      }
      const keyA = keyByUrl.get('https://a.example/hook');
      const keyB = keyByUrl.get('https://b.example/hook');
      // Same event + payload, but two distinct endpoints must not collide on the dedupe header.
      expect(keyA).toBeTruthy();
      expect(keyB).toBeTruthy();
      expect(keyA).not.toBe(keyB);
    });

    it('falls back to the original payload when a before-hook omits payload (no undefined body)', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // A misbehaving plugin returns continue:true but no `payload` key on the result.
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', event: 'message.received' },
      });

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0] as [unknown, { body: string }];
      const body = JSON.parse(callArgs[1].body) as WebhookPayload;
      expect(body).not.toBeUndefined();
      expect(body.event).toBe('message.received');
      expect(body.data).toEqual({ from: '628123456789@c.us' });
    });

    it('falls back to the original payload when a before-hook returns null data', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: null });

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      const callArgs = mockFetch.mock.calls[0] as [unknown, { body: string }];
      const body = JSON.parse(callArgs[1].body) as WebhookPayload;
      expect(body.event).toBe('message.received');
      expect(body.data).toEqual({ from: '628123456789@c.us' });
    });

    it('keeps the server-canonical idempotency/delivery ids on the signed body, overriding a tampering plugin', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // A webhook:before plugin returns a payload with forged identifiers (other hook events pass through).
      (hookManager.execute as jest.Mock).mockImplementation((event: string, ctx: { payload?: WebhookPayload }) =>
        event === 'webhook:before' && ctx.payload
          ? Promise.resolve({
              continue: true,
              data: { payload: { ...ctx.payload, idempotencyKey: 'PLUGIN-FORGED', deliveryId: 'PLUGIN-FORGED' } },
            })
          : Promise.resolve({ continue: true, data: {} }),
      );

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      const call = mockFetch.mock.calls[0] as [unknown, { headers: Record<string, string>; body: string }];
      const headers = call[1].headers;
      const body = JSON.parse(call[1].body) as WebhookPayload;
      // Receivers dedupe on the header, so the signed body field must equal the header — and both must
      // be the server's value, not the plugin's forgery.
      expect(body.idempotencyKey).toBe(headers['X-OpenWA-Idempotency-Key']);
      expect(body.deliveryId).toBe(headers['X-OpenWA-Delivery-Id']);
      expect(body.idempotencyKey).not.toBe('PLUGIN-FORGED');
      expect(body.deliveryId).not.toBe('PLUGIN-FORGED');
    });

    it('re-asserts event/sessionId/timestamp on the signed body after a tampering webhook:before hook', async () => {
      const webhook = createMockWebhook({ events: ['message.received'], secret: 'sek' });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // The plugin rewrites every remaining identity field; other hook events pass through. The
      // canonical timestamp is captured from the payload the hook was given.
      let canonicalTimestamp = '';
      (hookManager.execute as jest.Mock).mockImplementation((event: string, ctx: { payload?: WebhookPayload }) => {
        if (event === 'webhook:before' && ctx.payload) {
          canonicalTimestamp = ctx.payload.timestamp;
          return Promise.resolve({
            continue: true,
            data: {
              payload: {
                ...ctx.payload,
                event: 'forged.event',
                sessionId: 'other-session',
                timestamp: '1999-01-01T00:00:00.000Z',
              },
            },
          });
        }
        return Promise.resolve({ continue: true, data: {} });
      });

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      const call = mockFetch.mock.calls[0] as [unknown, { headers: Record<string, string>; body: string }];
      const headers = call[1].headers;
      const body = JSON.parse(call[1].body) as WebhookPayload;
      expect(body.event).toBe('message.received');
      expect(body.sessionId).toBe('sess-1');
      expect(body.timestamp).toBe(canonicalTimestamp);
      // Body and headers tell the same story, and the signature covers the exact bytes sent — a
      // forged identity field would have diverged body from header/signature.
      expect(headers['X-OpenWA-Event']).toBe(body.event);
      const expected = `sha256=${crypto.createHmac('sha256', 'sek').update(call[1].body).digest('hex')}`;
      expect(headers['X-OpenWA-Signature']).toBe(expected);
    });

    it('records (never sends) a hook-mutated payload that exceeds the payload size cap', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.maxPayloadBytes') return 1024;
        return def as T;
      });
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (hookManager.execute as jest.Mock).mockImplementation((event: string, ctx: { payload?: WebhookPayload }) =>
        event === 'webhook:before' && ctx.payload
          ? Promise.resolve({
              continue: true,
              data: { payload: { ...ctx.payload, data: { big: 'x'.repeat(64 * 1024) } } },
            })
          : Promise.resolve({ continue: true, data: {} }),
      );

      await service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(failureRepository.insert).toHaveBeenCalledTimes(1);
      expect(failureRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: webhook.id,
          attempts: 0,
          lastStatusCode: null,
        }),
      );
      const oversizeInsert = (failureRepository.insert as jest.Mock).mock.calls as Array<[{ lastError: string }]>;
      expect(oversizeInsert[0][0].lastError).toContain('exceeding the 1024-byte cap');
      expect(hookManager.execute).toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
    });

    it('replaces over-threshold inline media with the omitted marker before fan-out (input not mutated)', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.mediaInlineMaxBytes') return 1024;
        return def as T;
      });
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      const base64 = Buffer.alloc(2048, 7).toString('base64'); // 2048 decoded bytes > 1024 cap
      const data: Record<string, unknown> = {
        from: 'x@c.us',
        media: { mimetype: 'image/jpeg', data: base64 },
      };
      await service.dispatch('sess-1', 'message.received', data);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse((mockFetch.mock.calls[0] as [unknown, { body: string }])[1].body) as {
        data: { media: Record<string, unknown> };
      };
      // The documented marker shape — the blob itself never reaches the wire.
      expect(body.data.media).toEqual({ mimetype: 'image/jpeg', omitted: true, sizeBytes: 2048 });
      // The caller's event data keeps its media — shedding works on a copy.
      expect((data.media as { data?: string }).data).toBe(base64);
      expect(failureRepository.insert).not.toHaveBeenCalled();
    });

    it('keeps under-threshold media inline, unchanged', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      const base64 = Buffer.alloc(512, 3).toString('base64'); // default inline cap is 1 MiB
      await service.dispatch('sess-1', 'message.received', {
        from: 'x@c.us',
        media: { mimetype: 'image/jpeg', data: base64 },
      });

      const body = JSON.parse((mockFetch.mock.calls[0] as [unknown, { body: string }])[1].body) as {
        data: { media: { data?: string; omitted?: boolean } };
      };
      expect(body.data.media.data).toBe(base64);
      expect(body.data.media.omitted).toBeUndefined();
    });

    it('sheds inline media to fit the payload budget instead of recording the event undelivered', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.maxPayloadBytes') return 1024;
        if (key === 'webhook.mediaInlineMaxBytes') return 50 * 1024 * 1024; // pre-fan-out shed stays out of the way
        return def as T;
      });
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      // 2048 decoded bytes → ~2.7 KB base64 → serialized payload over the 1024-byte budget.
      const base64 = Buffer.alloc(2048, 9).toString('base64');
      await service.dispatch('sess-1', 'message.received', {
        from: 'x@c.us',
        media: { mimetype: 'image/jpeg', filename: 'photo.jpg', data: base64 },
      });

      // Delivered with the marker (filename preserved) — NOT dropped as undelivered.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse((mockFetch.mock.calls[0] as [unknown, { body: string }])[1].body) as {
        data: { media: Record<string, unknown> };
      };
      expect(body.data.media).toEqual({
        mimetype: 'image/jpeg',
        filename: 'photo.jpg',
        omitted: true,
        sizeBytes: 2048,
      });
      expect(failureRepository.insert).not.toHaveBeenCalled();
    });

    it('still records undelivered when an over-budget payload has no inline media to shed', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.maxPayloadBytes') return 1024;
        return def as T;
      });
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      await service.dispatch('sess-1', 'message.received', { from: 'x@c.us', body: 'y'.repeat(4096) });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(failureRepository.insert).toHaveBeenCalledTimes(1);
    });

    it('does not retry or record a failure when lastTriggeredAt bookkeeping fails after a 2xx', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockRejectedValue(new Error('db down'));
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });
      const failuresBefore = getWebhookDeliveryFailuresTotal();

      await service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });

      // The receiver answered 2xx: no redelivery, no dead-letter row, delivered-hooks still fire.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(failureRepository.insert).not.toHaveBeenCalled();
      expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore);
      expect(hookManager.execute).toHaveBeenCalledWith('webhook:delivered', expect.anything(), expect.anything());
      expect(hookManager.execute).not.toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
    });

    it("isolates each webhook's data so an in-place before-hook mutation cannot bleed across webhooks", async () => {
      const a = createMockWebhook({ id: 'wh-a', events: ['message.received'] });
      const b = createMockWebhook({ id: 'wh-b', events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([a, b]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // The hook mutates payload.data in place every time it runs (returns no payload key → finalPayload
      // is the mutated input). With a shared data object the second webhook would see the first's tag.
      (hookManager.execute as jest.Mock).mockImplementation((event: string, ctx: { payload?: WebhookPayload }) => {
        if (event === 'webhook:before' && ctx.payload) {
          const d = ctx.payload.data as { tag?: number };
          d.tag = (d.tag ?? 0) + 1;
          return Promise.resolve({ continue: true, data: { payload: ctx.payload } });
        }
        return Promise.resolve({ continue: true, data: {} });
      });

      await service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });

      const bodyA = JSON.parse((mockFetch.mock.calls[0] as [unknown, { body: string }])[1].body) as {
        data: { tag: number };
      };
      const bodyB = JSON.parse((mockFetch.mock.calls[1] as [unknown, { body: string }])[1].body) as {
        data: { tag: number };
      };
      // Each webhook starts from its own clone of the original data, so both see exactly one increment.
      expect(bodyA.data.tag).toBe(1);
      expect(bodyB.data.tag).toBe(1);
    });

    it('test() probes the receiver using the configured WEBHOOK_TIMEOUT', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

      await service.test('sess-1', webhook.id);

      expect(mockFetch).toHaveBeenCalled();
      expect(timeoutSpy).toHaveBeenCalledWith(25000);
      timeoutSpy.mockRestore();
    });

    // A literal link-local IP is rejected synchronously by the SSRF guard before any fetch/DNS, so this
    // is fully offline. The raw SsrfBlockedError message names the resolved internal IP — an SSRF
    // disclosure oracle — so the test() response must surface the generic constant instead.
    it('test() does not leak the resolved internal IP when the SSRF guard blocks the URL', async () => {
      const origProtect = process.env.WEBHOOK_SSRF_PROTECT;
      delete process.env.WEBHOOK_SSRF_PROTECT; // default → on
      try {
        const webhook = createMockWebhook({ url: 'https://169.254.169.254/' });
        (repository.findOne as jest.Mock).mockResolvedValue(webhook);

        const result = await service.test('sess-1', webhook.id);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Destination address is not allowed');
        expect(result.error).not.toMatch(/169\.254\.169\.254/);
        expect(mockFetch).not.toHaveBeenCalled(); // blocked before any network
      } finally {
        if (origProtect === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
        else process.env.WEBHOOK_SSRF_PROTECT = origProtect;
      }
    });

    it('should NOT dispatch to webhooks that do not match the event', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      await service.dispatch('sess-1', 'session.ready', { phone: '628123456789' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should dispatch to webhooks with wildcard (*) event filter', async () => {
      const webhook = createMockWebhook({ events: ['*'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const wildcardPayload: WebhookPayload = {
        event: 'anything.goes',
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: '',
        deliveryId: '',
        data: {},
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'anything.goes',
          payload: wildcardPayload,
        },
      });

      await service.dispatch('sess-1', 'anything.goes', {});

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should skip dispatch when plugin cancels via hook', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: false, data: {} });

      await service.dispatch('sess-1', 'message.received', {});

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('dispatch (queued mode) — serialization safety', () => {
    it('catches an unserializable webhook:before payload instead of aborting the loop / rejecting', async () => {
      (service as unknown as { queueEnabled: boolean }).queueEnabled = true;
      // A plugin's webhook:before returns a payload JSON.stringify cannot serialize (BigInt). The
      // preflight size check serializes the hook result, so the throw lands in the preflight catch
      // and the payload is recorded as undelivered.
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: { payload: { x: 1n } } });
      const webhook = createMockWebhook({ secret: 'sek', events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      // Must NOT reject (the loop/dispatch promise stays settled); the throw is caught + logged.
      await expect(service.dispatch('sess-1', 'message.received', { ok: true })).resolves.toBeUndefined();

      expect(webhookQueue.add).not.toHaveBeenCalled(); // never enqueued the un-signable job
      expect(hookManager.execute).toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
    });
  });

  // ── shutdown drain ────────────────────────────────────────────────

  describe('shutdown drain', () => {
    const mockFetch = undiciFetch as jest.Mock;

    afterEach(() => mockFetch.mockReset());

    it('records parked deliveries on close and abandons a hung in-flight delivery within the drain bound', async () => {
      const hooks = [
        createMockWebhook({ id: 'wh-a', url: 'https://a.example/hook', events: ['message.received'] }),
        createMockWebhook({ id: 'wh-b', url: 'https://b.example/hook', events: ['message.received'] }),
        createMockWebhook({ id: 'wh-c', url: 'https://c.example/hook', events: ['message.received'] }),
      ];
      (repository.find as jest.Mock).mockResolvedValue(hooks);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockImplementation((_event: string, data: unknown) =>
        Promise.resolve({ continue: true, data }),
      );
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.shutdownDrainMs') return 150;
        return def as T;
      });
      // One active slot, generous parked bound: B and C park behind the hanging A.
      (service as unknown as { dispatchLimiter: ConcurrencyLimiter }).dispatchLimiter = new ConcurrencyLimiter(1, 1000);

      let releaseActive: (value: unknown) => void = () => undefined;
      mockFetch.mockImplementation(() => new Promise(resolve => (releaseActive = resolve)));
      const loggerSpy = jest.spyOn((service as unknown as { logger: { error: jest.Mock } }).logger, 'error');

      const dispatchP = service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });
      for (let i = 0; i < 20 && mockFetch.mock.calls.length === 0; i++) await new Promise(r => setImmediate(r));

      const start = Date.now();
      await service.onModuleDestroy();
      const elapsed = Date.now() - start;

      // Bounded: the hanging in-flight delivery did not stall teardown past the drain window.
      expect(elapsed).toBeLessThan(2000);
      // The two parked deliveries were rejected by the closing limiter and recorded as undelivered —
      // they never reached the receiver, so a dead-letter row is the honest record.
      expect(failureRepository.insert).toHaveBeenCalledTimes(2);
      const shutdownInserts = (failureRepository.insert as jest.Mock).mock.calls as Array<
        [{ webhookId: string; lastError: string }]
      >;
      const recorded = shutdownInserts.map(c => c[0]);
      expect(recorded.map(r => r.webhookId)).toEqual(expect.arrayContaining(['wh-b', 'wh-c']));
      for (const r of recorded) expect(r.lastError).toBe('ConcurrencyLimiter closed');
      // The in-flight delivery was NOT falsely dead-lettered (the receiver may have it); it is
      // logged as abandoned so the loss is still operator-visible.
      expect(
        loggerSpy.mock.calls.some(c => {
          const meta = c[2] as { action?: string; webhookId?: string } | undefined;
          return meta?.action === 'webhook_delivery_abandoned_shutdown' && meta.webhookId === 'wh-a';
        }),
      ).toBe(true);

      releaseActive({ ok: true, status: 200 });
      await dispatchP;
      loggerSpy.mockRestore();
    });

    it('queued mode: parked enqueues drain to the queue on shutdown instead of dead-lettering', async () => {
      (service as unknown as { queueEnabled: boolean }).queueEnabled = true;
      const hooks = [
        createMockWebhook({ id: 'wh-a', url: 'https://a.example/hook', events: ['message.received'] }),
        createMockWebhook({ id: 'wh-b', url: 'https://b.example/hook', events: ['message.received'] }),
        createMockWebhook({ id: 'wh-c', url: 'https://c.example/hook', events: ['message.received'] }),
      ];
      (repository.find as jest.Mock).mockResolvedValue(hooks);
      (hookManager.execute as jest.Mock).mockImplementation((_event: string, data: unknown) =>
        Promise.resolve({ continue: true, data }),
      );
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return true;
        if (key === 'webhook.shutdownDrainMs') return 1000;
        return def as T;
      });
      // One active slot, generous parked bound: B and C park behind A, whose enqueue hangs.
      (service as unknown as { dispatchLimiter: ConcurrencyLimiter }).dispatchLimiter = new ConcurrencyLimiter(1, 1000);

      let releaseActive: (value: unknown) => void = () => undefined;
      let firstAdd = true;
      (webhookQueue.add as jest.Mock).mockImplementation(
        () =>
          new Promise(resolve => {
            if (firstAdd) {
              firstAdd = false;
              releaseActive = resolve;
            } else {
              resolve(undefined);
            }
          }),
      );

      const dispatchP = service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });
      for (let i = 0; i < 20 && webhookQueue.add.mock.calls.length === 0; i++) await new Promise(r => setImmediate(r));

      // Shutdown starts while A holds the slot and B/C are parked. Queued mode must not close the
      // limiter: a parked task is just webhookQueue.add() — durable in Redis once it runs — and it
      // holds an activeCount slot via handoff, so the drain loop waits for the whole chain.
      const destroyP = service.onModuleDestroy();
      releaseActive(undefined);
      await destroyP;
      await dispatchP;

      // All three reached the queue; none was dead-lettered as webhook_dispatch_shutdown.
      expect(webhookQueue.add).toHaveBeenCalledTimes(3);
      expect(failureRepository.insert).not.toHaveBeenCalled();
    });

    it('records a dispatch that arrives after the limiter closed (no fetch, dead-letter row)', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (hookManager.execute as jest.Mock).mockImplementation((_event: string, data: unknown) =>
        Promise.resolve({ continue: true, data }),
      );

      await service.onModuleDestroy(); // nothing in flight → returns immediately
      await service.dispatch('sess-1', 'message.received', { from: 'x@c.us' });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(failureRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ webhookId: webhook.id, attempts: 0, lastError: 'ConcurrencyLimiter closed' }),
      );
    });
  });

  // ── dispatch (smart filters) ──────────────────────────────────────
  // The event still has to match `events[]`; filters then refine WHETHER it fires based
  // on the payload. A webhook with no filters behaves exactly as before (fires on match).

  describe('dispatch (smart filters)', () => {
    const mockFetch = undiciFetch as jest.Mock;

    beforeEach(() => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
    });

    afterEach(() => mockFetch.mockReset());

    const conds = (...conditions: WebhookFilters['conditions']): WebhookFilters => ({ conditions });

    // events:['*'] isolates the filter logic from event-name matching. Returns the number
    // of outbound HTTP deliveries the dispatch performed (1 = fired, 0 = filtered out).
    async function deliveries(
      filters: WebhookFilters | null,
      event: string,
      data: Record<string, unknown>,
    ): Promise<number> {
      mockFetch.mockClear();
      const webhook = createMockWebhook({ events: ['*'], filters });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      await service.dispatch('sess-1', event, data);
      return mockFetch.mock.calls.length;
    }

    it('fires with no filters (additive: zero-config behaviour is unchanged)', async () => {
      expect(await deliveries(null, 'message.received', { from: '111@c.us' })).toBe(1);
      expect(await deliveries(conds(), 'message.received', { from: '111@c.us' })).toBe(1);
    });

    it('sender "is": fires on a match, filters out a mismatch', async () => {
      const f = conds({ field: 'sender', operator: 'is', value: ['111@c.us'] });
      expect(await deliveries(f, 'message.received', { from: '111@c.us' })).toBe(1);
      expect(await deliveries(f, 'message.received', { from: '222@c.us' })).toBe(0);
    });

    it('sender "isNot": filters out the named sender, fires for everyone else', async () => {
      const f = conds({ field: 'sender', operator: 'isNot', value: ['spammer@c.us'] });
      expect(await deliveries(f, 'message.received', { from: 'spammer@c.us' })).toBe(0);
      expect(await deliveries(f, 'message.received', { from: 'friend@c.us' })).toBe(1);
    });

    it('resolves sender to the group participant (author), not the group JID', async () => {
      const f = conds({ field: 'sender', operator: 'is', value: ['part@c.us'] });
      const data = { from: '120@g.us', author: 'part@c.us', isGroup: true };
      expect(await deliveries(f, 'message.received', data)).toBe(1);
    });

    it('ANDs multiple conditions (all must match)', async () => {
      const f = conds(
        { field: 'sender', operator: 'is', value: ['boss@c.us'] },
        { field: 'body', operator: 'contains', value: 'invoice' },
      );
      expect(await deliveries(f, 'message.received', { from: 'boss@c.us', body: 'the invoice is ready' })).toBe(1);
      expect(await deliveries(f, 'message.received', { from: 'boss@c.us', body: 'lunch?' })).toBe(0);
      expect(await deliveries(f, 'message.received', { from: 'other@c.us', body: 'invoice' })).toBe(0);
    });

    it('body "contains" is case-insensitive by default and respects caseSensitive', async () => {
      const ci = conds({ field: 'body', operator: 'contains', value: 'ping' });
      expect(await deliveries(ci, 'message.received', { body: 'PING me' })).toBe(1);
      const cs = conds({ field: 'body', operator: 'contains', value: 'ping', caseSensitive: true });
      expect(await deliveries(cs, 'message.received', { body: 'PING me' })).toBe(0);
    });

    it('body "equals" fires only on an exact match', async () => {
      const f = conds({ field: 'body', operator: 'equals', value: 'order 42' });
      expect(await deliveries(f, 'message.received', { body: 'order 42' })).toBe(1);
      expect(await deliveries(f, 'message.received', { body: 'order 4242' })).toBe(0);
    });

    it('type "is" matches one of the listed message types', async () => {
      const f = conds({ field: 'type', operator: 'is', value: ['image', 'video'] });
      expect(await deliveries(f, 'message.received', { type: 'image' })).toBe(1);
      expect(await deliveries(f, 'message.received', { type: 'text' })).toBe(0);
    });

    it('boolean fields: fromMe and hasMedia', async () => {
      const fromMe = conds({ field: 'fromMe', operator: 'is', value: true });
      expect(await deliveries(fromMe, 'message.received', { fromMe: true })).toBe(1);
      expect(await deliveries(fromMe, 'message.received', { fromMe: false })).toBe(0);

      const hasMedia = conds({ field: 'hasMedia', operator: 'is', value: true });
      expect(await deliveries(hasMedia, 'message.received', { media: { mimetype: 'image/png' } })).toBe(1);
      expect(await deliveries(hasMedia, 'message.received', { body: 'just text' })).toBe(0);
    });

    it('filters message.edited through a wildcard subscription using its normalized message fields', async () => {
      const f = conds(
        { field: 'sender', operator: 'is', value: ['part@c.us'] },
        { field: 'body', operator: 'contains', value: 'invoice' },
        { field: 'type', operator: 'is', value: ['image'] },
        { field: 'hasMedia', operator: 'is', value: true },
      );
      const data = {
        from: '120@g.us',
        author: 'part@c.us',
        body: 'Updated invoice',
        type: 'image',
        hasMedia: true,
      };

      expect(await deliveries(f, 'message.edited', data)).toBe(1);
      expect(await deliveries(f, 'message.edited', { ...data, body: 'lunch?', hasMedia: false })).toBe(0);
    });

    it('mentions: fires when the message mentions one of the listed JIDs', async () => {
      const f = conds({ field: 'mentions', operator: 'is', value: ['boss@c.us'] });
      expect(await deliveries(f, 'message.received', { mentionedIds: ['boss@c.us', 'x@c.us'] })).toBe(1);
      expect(await deliveries(f, 'message.received', { mentionedIds: ['x@c.us'] })).toBe(0);
    });

    it('skips message-only conditions on a non-message event (so it still fires)', async () => {
      // A webhook subscribed to '*' with message filters must not suppress non-message events.
      const f = conds({ field: 'sender', operator: 'is', value: ['nobody@c.us'] });
      expect(await deliveries(f, 'session.status', { status: 'connected' })).toBe(1);
      expect(await deliveries(f, 'message.received', { from: 'someone@c.us' })).toBe(0);
    });

    it('resolves a lid sender to its phone via the table, so a phone filter fires (else a silent miss)', async () => {
      const f = conds({ field: 'sender', operator: 'is', value: ['628999'] });
      const data = { from: '120@g.us', author: '111@lid', isGroup: true };

      // No mapping yet -> the lid author never matches the phone filter.
      lidStore.getCached.mockReturnValue(null);
      expect(await deliveries(f, 'message.received', data)).toBe(0);

      // Table maps lid 111 -> 628999 -> the same message now fires.
      lidStore.getCached.mockImplementation((lid: string) => (lid === '111' ? '628999' : null));
      expect(await deliveries(f, 'message.received', data)).toBe(1);
    });
  });

  // ── custom-header sanitization ───────────────────────────────

  describe('custom header merge', () => {
    it('drops reserved custom headers so the system headers always win', async () => {
      const webhook = createMockWebhook({
        events: ['message.received'],
        headers: { 'X-OpenWA-Event': 'forged', 'Content-Type': 'text/plain', 'X-Custom': 'ok' },
      });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const captured: Record<string, string> = {};
      const mockFetch = undiciFetch as jest.Mock;
      mockFetch.mockImplementation((_url: string, opts: RequestInit) => {
        Object.assign(captured, opts.headers as Record<string, string>);
        return Promise.resolve({ ok: true, status: 200 });
      });

      const payload: WebhookPayload = {
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', event: 'message.received', payload },
      });

      await service.dispatch('sess-1', 'message.received', {});

      expect(captured['X-OpenWA-Event']).toBe('message.received'); // system value, not 'forged'
      expect(captured['Content-Type']).toBe('application/json');
      expect(captured['X-Custom']).toBe('ok'); // legitimate custom header preserved
      mockFetch.mockReset();
    });
  });

  // ── redirect refusal ─────────────────────────────────────────

  describe('dispatch — redirect refusal', () => {
    const mockFetch = undiciFetch as jest.Mock;
    const origProtect = process.env.WEBHOOK_SSRF_PROTECT;

    beforeEach(() => {
      process.env.WEBHOOK_SSRF_PROTECT = 'true';
    });

    afterEach(() => {
      mockFetch.mockReset();
      if (origProtect === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
      else process.env.WEBHOOK_SSRF_PROTECT = origProtect;
    });

    it('does NOT follow a redirect and treats it as a delivery failure when protection is on', async () => {
      // Public literal IP → assertSafeFetchUrl passes with no DNS lookup; retryCount:1 → no retry loop.
      const webhook = createMockWebhook({
        url: 'https://8.8.8.8/webhook',
        events: ['message.received'],
        retryCount: 1,
      });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      // Simulate undici's redirect:'manual' result — an opaque redirect, never followed.
      mockFetch.mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' });

      const payload: WebhookPayload = {
        event: 'message.received',
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
        data: {},
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', event: 'message.received', payload },
      });

      await service.dispatch('sess-1', 'message.received', {});

      // fetch was issued with redirect:'manual' and the redirect was NOT followed (no success path)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://8.8.8.8/webhook',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(repository.update).not.toHaveBeenCalled(); // lastTriggeredAt never set → delivery failed
      expect(hookManager.execute).toHaveBeenCalledWith('webhook:error', expect.anything(), expect.anything());
    });
  });

  // ── generateSignature (via dispatch) ──────────────────────────────

  describe('generateSignature', () => {
    it('should produce valid HMAC-SHA256 signature', async () => {
      const webhook = createMockWebhook({
        events: ['message.received'],
        secret: 'test-secret-123',
      });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      const capturedHeaders: Record<string, string> = {};
      const mockFetch = undiciFetch as jest.Mock;
      mockFetch.mockImplementation((_url: string, opts: RequestInit) => {
        Object.assign(capturedHeaders, opts.headers as Record<string, string>);
        return Promise.resolve({ ok: true, status: 200 });
      });

      const sigPayload: WebhookPayload = {
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: sigPayload,
        },
      });

      await service.dispatch('sess-1', 'message.received', {});

      // Verify signature format
      expect(capturedHeaders['X-OpenWA-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify signature correctness against the ACTUAL delivered body. The body now carries the
      // server-canonical idempotency/delivery ids (re-asserted over the plugin's 'k'/'d'), so the
      // signature is checked against what the receiver actually gets — the real verification contract.
      const sentBody = (mockFetch.mock.calls[0] as [unknown, { body: string }])[1].body;
      const expected = `sha256=${crypto.createHmac('sha256', 'test-secret-123').update(sentBody).digest('hex')}`;
      expect(capturedHeaders['X-OpenWA-Signature']).toBe(expected);

      mockFetch.mockReset();
    });
  });

  // ── dispatch (queue mode) ─────────────────────────────────────────

  describe('dispatch (queue mode)', () => {
    afterEach(() => (undiciFetch as jest.Mock).mockReset());

    const buildQueueService = async (configGet: (key: string, def?: unknown) => unknown): Promise<WebhookService> => {
      const queueModule: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
          { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
          { provide: ConfigService, useValue: { get: jest.fn().mockImplementation(configGet) } },
          { provide: HookManager, useValue: hookManager },
          { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
        ],
      }).compile();
      return queueModule.get<WebhookService>(WebhookService);
    };

    it('enqueues a small, media-shed job when the event carries over-threshold media', async () => {
      const queueService = await buildQueueService((key: string, def?: unknown) => {
        if (key === 'queue.enabled') return true;
        if (key === 'webhook.retryDelay') return 5000;
        if (key === 'webhook.mediaInlineMaxBytes') return 1024;
        return def;
      });
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      const base64 = Buffer.alloc(2048, 5).toString('base64'); // 2048 decoded bytes > 1024 cap
      await queueService.dispatch('sess-1', 'message.received', {
        from: 'x@c.us',
        media: { mimetype: 'image/jpeg', data: base64 },
      });

      expect(webhookQueue.add).toHaveBeenCalledTimes(1);
      const addCalls = (webhookQueue.add as jest.Mock).mock.calls as Array<[string, WebhookJobData]>;
      const jobData = addCalls[0][1];
      // The blob is shed BEFORE enqueue: a failed job retains only the marker in Redis, and the
      // bounded removeOnFail window (WEBHOOK_QUEUE_JOB_OPTIONS) keeps count × bytes bounded.
      expect((jobData.payload.data as { media: Record<string, unknown> }).media).toEqual({
        mimetype: 'image/jpeg',
        omitted: true,
        sizeBytes: 2048,
      });
      expect(JSON.stringify(jobData).length).toBeLessThan(2048);
    });

    it('keys the queue job by the delivery id, so a retried enqueue cannot double-deliver', async () => {
      const queueService = await buildQueueService((key: string, def?: unknown) => {
        if (key === 'queue.enabled') return true;
        if (key === 'webhook.retryDelay') return 5000;
        return def;
      });
      (repository.find as jest.Mock).mockResolvedValue([createMockWebhook({ events: ['message.received'] })]);
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      await queueService.dispatch('sess-1', 'message.received', {});

      const [, jobData, opts] = (webhookQueue.add as jest.Mock).mock.calls[0] as [
        string,
        WebhookJobData,
        { jobId?: string },
      ];
      // BullMQ's dedupe boundary and the receiver's must key off the SAME identifier, or a job
      // that BullMQ accepts twice still looks like one delivery to the receiver (and vice versa).
      expect(opts.jobId).toBe(jobData.headers['X-OpenWA-Delivery-Id']);
      expect(opts.jobId).toBe(jobData.payload.deliveryId);
    });

    it('gives sibling webhooks distinct job ids, so one event fanning out is not collapsed into one job', async () => {
      const queueService = await buildQueueService((key: string, def?: unknown) => {
        if (key === 'queue.enabled') return true;
        if (key === 'webhook.retryDelay') return 5000;
        return def;
      });
      (repository.find as jest.Mock).mockResolvedValue([
        createMockWebhook({ id: 'wh-uuid-1', events: ['message.received'] }),
        createMockWebhook({ id: 'wh-uuid-2', events: ['message.received'], url: 'https://example.com/other' }),
      ]);
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      await queueService.dispatch('sess-1', 'message.received', {});

      // Guards the invariant that makes jobId = deliveryId safe: deliveryId is minted per webhook
      // per dispatch. Were it ever hoisted to per-event, BullMQ would silently drop every
      // subscription after the first — a data-loss bug with no error anywhere.
      expect(webhookQueue.add).toHaveBeenCalledTimes(2);
      const jobIds = (webhookQueue.add as jest.Mock).mock.calls.map(
        (call: [string, WebhookJobData, { jobId?: string }]) => call[2].jobId,
      );
      expect(new Set(jobIds).size).toBe(2);
    });

    it('should add job to queue when queue is enabled', async () => {
      // Create a new service with queue enabled
      const queueModule: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
          { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
                if (key === 'queue.enabled') return true;
                if (key === 'webhook.retryDelay') return 5000;
                return def as T;
              }),
            },
          },
          { provide: HookManager, useValue: hookManager },
          { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
        ],
      }).compile();

      const queueService = queueModule.get<WebhookService>(WebhookService);

      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);

      const queuePayload: WebhookPayload = {
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      };
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          sessionId: 'sess-1',
          event: 'message.received',
          payload: queuePayload,
        },
      });

      await queueService.dispatch('sess-1', 'message.received', {});

      expect(webhookQueue.add).toHaveBeenCalledWith(
        expect.stringContaining('webhook-'),
        expect.objectContaining({
          webhookId: 'wh-uuid-1',
          url: 'https://example.com/webhook',
          event: 'message.received',
        }),
        expect.objectContaining({
          attempts: 3,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      );
    });

    it('falls back to direct delivery when queue add fails', async () => {
      const queueModule: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
          { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
                if (key === 'queue.enabled') return true;
                if (key === 'webhook.retryDelay') return 5000;
                if (key === 'webhook.timeout') return 25000;
                return def as T;
              }),
            },
          },
          { provide: HookManager, useValue: hookManager },
          { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
        ],
      }).compile();

      const queueService = queueModule.get<WebhookService>(WebhookService);
      const webhook = createMockWebhook({ events: ['message.received'], retryCount: 1 });
      const queuePayload: WebhookPayload = {
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      };
      const mockFetch = undiciFetch as jest.Mock;
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', event: 'message.received', payload: queuePayload },
      });
      webhookQueue.add.mockRejectedValueOnce(new Error('redis down'));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await queueService.dispatch('sess-1', 'message.received', {});

      expect(webhookQueue.add).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(hookManager.execute).toHaveBeenCalledWith(
        'webhook:delivered',
        expect.objectContaining({ webhookId: webhook.id, fallback: 'queue_failed' }),
        expect.anything(),
      );
    });
  });

  describe('delivery-failure dead-letter', () => {
    it('records a durable failure when a direct delivery exhausts its retries', async () => {
      const webhook = createMockWebhook({ events: ['message.received'], retryCount: 1 });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (hookManager.execute as jest.Mock).mockResolvedValue({
        continue: true,
        data: {
          payload: {
            event: 'message.received',
            timestamp: '',
            sessionId: 'sess-1',
            idempotencyKey: 'k',
            deliveryId: 'd',
            data: {},
          },
        },
      });
      const mockFetch = undiciFetch as jest.Mock;
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

      const failuresBefore = getWebhookDeliveryFailuresTotal();
      await service.dispatch('sess-1', 'message.received', {});

      expect(failureRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: webhook.id,
          attempts: 1,
          lastStatusCode: 500,
          lastError: 'HTTP 500: Server Error',
        }),
      );
      // The terminal failure also bumps the Prometheus counter exactly once.
      expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore + 1);
      mockFetch.mockReset();
    });

    it('listDeliveryFailures queries most-recent-first, optionally scoped to a session', async () => {
      (failureRepository.find as jest.Mock).mockResolvedValue([{ id: 'f1' }]);

      const out = await service.listDeliveryFailures({ sessionId: 's1', limit: 10 });

      expect(out).toHaveLength(1);
      // sessionId resolves through resolveSessionScope, so the WHERE is an IN over the effective scope
      // ([s1] here for an unrestricted key narrowing to one session) — behaviourally the same rows.
      expect(failureRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sessionId: In(['s1']) }, order: { createdAt: 'DESC' } }),
      );
    });
  });
});
