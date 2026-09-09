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
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { fetch as undiciFetch } from 'undici';
import { WebhookDeliveryService, WebhookPayload, WebhookJobData } from './webhook-delivery.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { Session } from '../session/entities/session.entity';
import { WebhookFilters } from './filters/filter-types';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import { HookManager } from '../../core/hooks';
import { QUEUE_NAMES } from '../queue/queue-names';
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

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let repository: jest.Mocked<Partial<Repository<Webhook>>>;
  let failureRepository: jest.Mocked<Partial<Repository<WebhookDeliveryFailure>>>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let webhookQueue: jest.Mocked<Record<string, jest.Mock>>;
  let lidStore: { getCached: jest.Mock; resolveLid: jest.Mock };
  let outboxService: { open: jest.Mock; close: jest.Mock };

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    // Backed by the rows it accepts, not a constant: the dedupe guard reads count() before every
    // insert, and a jest.fn() returning undefined would make the guard silently inert here while
    // still passing every assertion.
    const insertedFailures: Array<{ webhookId?: string; idempotencyKey?: string | null }> = [];
    failureRepository = {
      insert: jest.fn().mockImplementation((rowToInsert: { webhookId?: string; idempotencyKey?: string | null }) => {
        insertedFailures.push(rowToInsert);
        return Promise.resolve({});
      }),
      count: jest
        .fn()
        .mockImplementation((opts: { where: { webhookId?: string; idempotencyKey?: string } }) =>
          Promise.resolve(
            insertedFailures.filter(
              r => r.webhookId === opts.where.webhookId && r.idempotencyKey === opts.where.idempotencyKey,
            ).length,
          ),
        ),
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

    lidStore = {
      getCached: jest.fn().mockReturnValue(null),
      // Mirrors the real implementation so tests keep driving resolution through getCached mocks.
      resolveLid: jest.fn((jid: string) => (lidStore.getCached(userPart(jid)) as string | null | undefined) ?? null),
    };

    outboxService = { open: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
        { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
        { provide: WebhookOutboxService, useValue: outboxService },
        { provide: ConfigService, useValue: configService },
        { provide: HookManager, useValue: hookManager },
        { provide: LidMappingStoreService, useValue: lidStore },
        { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
      ],
    }).compile();

    service = module.get<WebhookDeliveryService>(WebhookDeliveryService);
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

    it('records the delivery before attempting it, and retires the record once it lands', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      // Durability is only worth anything if the row exists BEFORE the attempt: a crash during the
      // POST is exactly the window this closes.
      expect(outboxService.open).toHaveBeenCalledTimes(1);
      const opened = (outboxService.open.mock.calls as unknown as Record<string, unknown>[][])[0][0];
      expect(opened).toMatchObject({ webhookId: webhook.id, sessionId: 'sess-1', event: 'message.received' });
      expect(opened.idempotencyKey).toEqual(expect.stringContaining(webhook.id));
      expect(outboxService.open.mock.invocationCallOrder[0]).toBeLessThan(mockFetch.mock.invocationCallOrder[0]);

      // Retired once a durable owner has it, so the reconciler never replays a delivered event.
      expect(outboxService.close).toHaveBeenCalledWith(webhook.id, opened.idempotencyKey, 'dispatched');
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

    // The reconciler branches on this VALUE, never on a throw: every failing path inside redeliver
    // dead-letters in place, so nothing reaches the caller as an exception. When this reported
    // nothing, a replay that never delivered was retired 'dispatched' on the first sweep and the
    // documented WEBHOOK_RECONCILE_MAX_ATTEMPTS budget was unreachable.
    it('redeliver reports failed when the receiver never accepts, and delivered when it does', async () => {
      const webhook = createMockWebhook({ events: ['message.received'], retryCount: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });

      mockFetch.mockReset();
      mockFetch.mockRejectedValue(new Error('receiver down'));
      await expect(
        service.redeliver(webhook, 'sess-1', 'message.received', 'stored-key-1', { from: 'x@c.us' }),
      ).resolves.toBe('failed');

      // Control: the same call on a receiver that answers 2xx must NOT report 'failed', otherwise
      // the assertion above is satisfied by a method that reports failure unconditionally.
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      await expect(
        service.redeliver(webhook, 'sess-1', 'message.received', 'stored-key-2', { from: 'x@c.us' }),
      ).resolves.toBe('delivered');
    });

    it('reports a plugin-cancelled dispatch as cancelled, recording no failure and sending nothing', async () => {
      // A before-hook that stops the dispatch is a deliberate drop. Reported as 'failed' it looked
      // identical to a lost delivery, so the reconciler replayed it once per sweep until the budget
      // ran out and then marked it terminally lost against a failure row nothing ever wrote.
      const webhook = createMockWebhook({ events: ['message.received'], retryCount: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: false, data: {} });
      const failuresBefore = getWebhookDeliveryFailuresTotal();
      mockFetch.mockReset();

      await expect(
        service.redeliver(webhook, 'sess-1', 'message.received', 'cancelled-key', { from: 'x@c.us' }),
      ).resolves.toBe('cancelled');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(failureRepository.insert).not.toHaveBeenCalled();
      expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore);
    });

    it('records one failure row per lost delivery however many times the reconciler replays it', async () => {
      // The reconciler leaves a failed row pending and sweeps it again until the attempt budget is
      // spent. Every replay reaching the dead-letter table turned one lost event into as many rows
      // and as many increments of the loss metric as the budget allowed.
      const webhook = createMockWebhook({ events: ['message.received'], retryCount: 1 });
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });
      mockFetch.mockReset();
      mockFetch.mockRejectedValue(new Error('receiver down'));
      const failuresBefore = getWebhookDeliveryFailuresTotal();

      for (let sweep = 0; sweep < 3; sweep++) {
        await expect(
          service.redeliver(webhook, 'sess-1', 'message.received', 'stranded-key', { from: 'x@c.us' }),
        ).resolves.toBe('failed');
      }

      expect(failureRepository.insert).toHaveBeenCalledTimes(1);
      expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore + 1);

      // Control: a genuinely different delivery must still be recorded, or the assertion above is
      // satisfied by a guard that suppresses every row after the first.
      await expect(
        service.redeliver(webhook, 'sess-1', 'message.received', 'other-key', { from: 'x@c.us' }),
      ).resolves.toBe('failed');
      expect(failureRepository.insert).toHaveBeenCalledTimes(2);
      expect(getWebhookDeliveryFailuresTotal()).toBe(failuresBefore + 2);
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
      service.invalidateWebhooks();
      mockFetch.mockClear();
      const webhook = createMockWebhook({ events: ['*'], filters });
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      await service.dispatch('sess-1', event, data);
      return mockFetch.mock.calls.length;
    }

    // A condition names a field the event's payload does not carry — `sender` resolves from
    // author/from, and message.ack dispatches { id, messageId, status, ack }. The condition cannot
    // match, so the delivery is dropped. That is the filter working as specified; what was missing
    // was any way to find out it had happened.
    it('logs when a filter suppresses a subscribed webhook', async () => {
      const logger = (service as unknown as { logger: { debug: jest.Mock } }).logger;
      const spy = jest.spyOn(logger, 'debug');

      expect(
        await deliveries(conds({ field: 'sender', operator: 'is', value: ['111@c.us'] }), 'message.ack', {
          messageId: 'm1',
          status: 'read',
        }),
      ).toBe(0);

      const suppressed = spy.mock.calls.filter(c => String(c[0]).includes('suppressed a delivery'));
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0][1]).toMatchObject({ event: 'message.ack', subscribed: 1, suppressed: 1 });
      // The payload's own fields are recorded, because the usual cause is a condition on a field
      // this event does not have — that list is the answer to "why did nothing fire?".
      expect((suppressed[0][1] as { payloadFields: string }).payloadFields).toBe('messageId,status');
      spy.mockRestore();
    });

    it('stays quiet when nothing is suppressed', async () => {
      const logger = (service as unknown as { logger: { debug: jest.Mock } }).logger;
      const spy = jest.spyOn(logger, 'debug');

      expect(
        await deliveries(conds({ field: 'sender', operator: 'is', value: ['111@c.us'] }), 'message.received', {
          from: '111@c.us',
        }),
      ).toBe(1);

      expect(spy.mock.calls.filter(c => String(c[0]).includes('suppressed a delivery'))).toHaveLength(0);
      spy.mockRestore();
    });

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

    const buildQueueService = async (
      configGet: (key: string, def?: unknown) => unknown,
    ): Promise<WebhookDeliveryService> => {
      const queueModule: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookDeliveryService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
          { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
          { provide: WebhookOutboxService, useValue: outboxService },
          { provide: WebhookOutboxService, useValue: outboxService },
          { provide: ConfigService, useValue: { get: jest.fn().mockImplementation(configGet) } },
          { provide: HookManager, useValue: hookManager },
          { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
        ],
      }).compile();
      return queueModule.get<WebhookDeliveryService>(WebhookDeliveryService);
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
      const queueService = await buildQueueService(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return true;
        if (key === 'webhook.retryDelay') return 5000;
        return def as T;
      });

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
      const queueService = await buildQueueService(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return true;
        if (key === 'webhook.retryDelay') return 5000;
        if (key === 'webhook.timeout') return 25000;
        return def as T;
      });
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
  });

  describe('active webhooks in-memory cache', () => {
    it('caches loaded webhooks per session to avoid DB lookups on repeated dispatches', async () => {
      const webhook = createMockWebhook({ events: ['*'] });
      (repository.find as jest.Mock).mockClear();
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      const mockFetch = undiciFetch as jest.Mock;
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      service.invalidateWebhooks();
      expect(repository.find).toHaveBeenCalledTimes(0);

      await service.dispatch('sess-cache-1', 'message.received', { text: 'one' });
      expect(repository.find).toHaveBeenCalledTimes(1);

      await service.dispatch('sess-cache-1', 'message.received', { text: 'two' });
      // Served from memory cache: find was NOT called again
      expect(repository.find).toHaveBeenCalledTimes(1);

      // Invalidation forces a fresh DB lookup
      service.invalidateWebhooks('sess-cache-1');
      await service.dispatch('sess-cache-1', 'message.received', { text: 'three' });
      expect(repository.find).toHaveBeenCalledTimes(2);

      mockFetch.mockReset();
    });
  });
});
