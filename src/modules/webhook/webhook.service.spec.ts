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

import { createHmac } from 'crypto';
import { setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { FindOperator, In, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { WebhookService } from './webhook.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { buildDeliveryHeaders } from './utils/deliver-once';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import { HookManager } from '../../core/hooks';
import { QUEUE_NAMES } from '../queue/queue-names';
import { Session } from '../session/entities/session.entity';

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
  let testingModule: TestingModule;
  let repository: jest.Mocked<Partial<Repository<Webhook>>>;
  let failureRepository: jest.Mocked<Partial<Repository<WebhookDeliveryFailure>>>;
  let sessionRepository: jest.Mocked<Partial<Repository<Session>>>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let webhookQueue: jest.Mocked<Record<string, jest.Mock>>;
  let lidStore: { getCached: jest.Mock; resolveLid: jest.Mock };

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
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    sessionRepository = {
      // Default to an existing session; the 404 cases below override this per test.
      exists: jest.fn().mockResolvedValue(true),
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

    testingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        WebhookDeliveryService,
        { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
        { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: failureRepository },
        {
          provide: WebhookOutboxService,
          useValue: { open: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessionRepository },
        { provide: ConfigService, useValue: configService },
        { provide: HookManager, useValue: hookManager },
        { provide: LidMappingStoreService, useValue: lidStore },
        { provide: getQueueToken(QUEUE_NAMES.WEBHOOK), useValue: webhookQueue },
      ],
    }).compile();

    service = testingModule.get<WebhookService>(WebhookService);
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

    // ── session existence ─────────────────────────────────

    it('returns 404 when the session does not exist, without persisting anything', async () => {
      (sessionRepository.exists as jest.Mock).mockResolvedValue(false);

      await expect(service.create('sess-missing', { url: 'https://example.com/webhook' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.create('sess-missing', { url: 'https://example.com/webhook' })).rejects.toThrow(
        "Session with id 'sess-missing' not found",
      );
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.count).not.toHaveBeenCalled(); // existence is checked before the fan-out cap
    });

    it('checks session existence against the sessions table and creates when present', async () => {
      const webhook = createMockWebhook();
      (repository.create as jest.Mock).mockReturnValue(webhook);
      (repository.save as jest.Mock).mockResolvedValue(webhook);

      await expect(service.create('sess-1', { url: 'https://example.com/webhook' })).resolves.toBeDefined();
      expect(sessionRepository.exists).toHaveBeenCalledWith({ where: { id: 'sess-1' } });
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

    // ── URLs must not embed credentials ───────────────────

    it('rejects a webhook URL carrying userinfo at registration', async () => {
      await expect(service.create('sess-1', { url: 'https://user:pass@example.com/hook' })).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.create('sess-1', { url: 'https://user:pass@example.com/hook' })).rejects.toThrow(
        /must not contain credentials/,
      );
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a username-only userinfo URL as well', async () => {
      await expect(service.create('sess-1', { url: 'https://user@example.com/hook' })).rejects.toThrow(
        /must not contain credentials/,
      );
    });

    it('rejects userinfo URLs even when SSRF protection is explicitly disabled', async () => {
      const origProtect = process.env.WEBHOOK_SSRF_PROTECT;
      process.env.WEBHOOK_SSRF_PROTECT = 'false';
      try {
        await expect(service.create('sess-1', { url: 'https://user:pass@example.com/hook' })).rejects.toMatchObject({
          status: 400,
        });
        expect(repository.create).not.toHaveBeenCalled();
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

      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC', id: 'DESC' }, take: 1000, skip: 0 });
    });

    it('applies bounded pagination to cross-session listing', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(['sess-1'], { limit: 5000, offset: -5 });

      expect(repository.find).toHaveBeenCalledWith({
        where: { sessionId: In(['sess-1']) },
        order: { createdAt: 'DESC', id: 'DESC' },
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
      (repository.update as jest.Mock).mockImplementation((_where, patch: Partial<Webhook>) => {
        Object.assign(webhook, patch);
        return Promise.resolve({ affected: 1 });
      });

      const result = await service.update('sess-1', 'wh-uuid-1', { url: 'https://new-url.com/hook' });

      expect(result.url).toBe('https://new-url.com/hook');
      expect(result.events).toEqual(['message.received']); // unchanged
    });

    it('writes only the fields the request carries, scoped to the row as it exists now', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.update('sess-1', 'wh-uuid-1', { active: false, secret: '' });

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'wh-uuid-1', sessionId: 'sess-1' },
        { active: false, secret: null },
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('answers 404 instead of re-creating a webhook deleted while the update was in flight', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 0 });

      await expect(service.update('sess-1', 'wh-uuid-1', { active: false })).rejects.toThrow(NotFoundException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a URL carrying userinfo on update and leaves the stored URL unchanged', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);

      await expect(
        service.update('sess-1', 'wh-uuid-1', { url: 'https://user:pass@evil.example/hook' }),
      ).rejects.toMatchObject({ status: 400 });
      expect(webhook.url).toBe('https://example.com/webhook');
      expect(repository.update).not.toHaveBeenCalled();
    });

    describe('with the SSRF guard on', () => {
      const origProtect = process.env.WEBHOOK_SSRF_PROTECT;
      beforeEach(() => delete process.env.WEBHOOK_SSRF_PROTECT); // default: on
      afterEach(() => {
        if (origProtect === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
        else process.env.WEBHOOK_SSRF_PROTECT = origProtect;
      });

      it('saves an edit that re-sends an unchanged URL the guard would now refuse', async () => {
        const webhook = createMockWebhook({ url: 'https://169.254.169.254/hook' });
        (repository.findOne as jest.Mock).mockResolvedValue(webhook);
        (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

        await service.update('sess-1', 'wh-uuid-1', {
          url: 'https://169.254.169.254/hook',
          active: false,
        });

        expect(repository.update).toHaveBeenCalledWith({ id: 'wh-uuid-1', sessionId: 'sess-1' }, { active: false });
      });

      it('still refuses a changed URL the guard blocks', async () => {
        const webhook = createMockWebhook();
        (repository.findOne as jest.Mock).mockResolvedValue(webhook);

        await expect(
          service.update('sess-1', 'wh-uuid-1', { url: 'https://169.254.169.254/hook', active: false }),
        ).rejects.toMatchObject({ status: 400 });
        expect(webhook.url).toBe('https://example.com/webhook');
        expect(repository.update).not.toHaveBeenCalled();
      });
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

    it('pruneDeliveryFailurePayloads clears expired payloads and keeps the rows', async () => {
      (failureRepository.update as jest.Mock).mockResolvedValue({ affected: 2 });
      const before = Date.now();

      await expect(service.pruneDeliveryFailurePayloads(72)).resolves.toBe(2);

      const [where, patch] = (failureRepository.update as jest.Mock).mock.calls[0] as [
        { payload: FindOperator<unknown>; createdAt: FindOperator<Date> },
        Record<string, unknown>,
      ];
      expect(patch).toEqual({ payload: null });
      expect(where.payload.type).toBe('not');
      expect(where.createdAt.type).toBe('lessThan');
      const cutoff = where.createdAt.value.getTime();
      expect(cutoff).toBeLessThanOrEqual(before - 72 * 3600_000 + 1000);
      expect(cutoff).toBeGreaterThanOrEqual(before - 72 * 3600_000 - 1000);
      expect(failureRepository.delete).not.toHaveBeenCalled();
    });

    it('with payload retention off, startup clears leftover payloads once and schedules nothing', () => {
      jest.useFakeTimers();
      try {
        service.onModuleInit();
        expect(failureRepository.update).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(2 * 60 * 60 * 1000);
        expect(failureRepository.update).toHaveBeenCalledTimes(1);
      } finally {
        service.onModuleDestroy();
        jest.useRealTimers();
      }
    });

    it('with payload retention on, expired payloads are cleared at startup and then hourly', () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T) =>
        key === 'webhook.failurePayloadRetentionHours' ? 24 : def,
      );
      jest.useFakeTimers();
      try {
        service.onModuleInit();
        expect(failureRepository.update).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(failureRepository.update).toHaveBeenCalledTimes(2);
      } finally {
        service.onModuleDestroy();
        jest.useRealTimers();
      }
    });
  });

  // ── dispatch facade ───────────────────────────────────────────────

  describe('dispatch (facade)', () => {
    it("delegates dispatch to the delivery engine with the caller's arguments", async () => {
      const delivery = testingModule.get<WebhookDeliveryService>(WebhookDeliveryService);
      const dispatchSpy = jest.spyOn(delivery, 'dispatch').mockResolvedValue(undefined);

      await service.dispatch('sess-1', 'message.received', { x: 1 });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith('sess-1', 'message.received', { x: 1 });
      expect(repository.find).not.toHaveBeenCalled(); // the engine, not the facade, loads webhooks
    });

    it('lets go of an over-cap media event while its delivery waits on the receiver', async () => {
      // Process-wide: later suites in this jest worker also see a global gc in new vm contexts.
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const mockFetch = undiciFetch as jest.Mock;
      const webhook = createMockWebhook();
      (repository.find as jest.Mock).mockResolvedValue([webhook]);
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (hookManager.execute as jest.Mock).mockResolvedValue({ continue: true, data: {} });
      let answer!: (response: Response) => void;
      const posted = new Promise<void>(reached =>
        mockFetch.mockImplementationOnce(() => {
          reached();
          return new Promise<Response>(resolve => (answer = resolve));
        }),
      );
      try {
        // Over the default 1 MiB inline cap, so the engine sheds it before fan-out.
        let media: Record<string, unknown> | undefined = {
          mimetype: 'image/jpeg',
          data: Buffer.alloc(1024 * 1024 + 1, 5).toString('base64'),
        };
        const original = new WeakRef(media);
        const dispatched = service.dispatch('sess-1', 'message.received', { from: 'x@c.us', media });
        media = undefined;

        await posted;
        await new Promise(resolve => setImmediate(resolve));
        gc();
        // Only the marker copy may stay reachable while the receiver hangs: a frame that still
        // holds the caller's event keeps every parked delivery's full blob in memory.
        expect(original.deref() === undefined).toBe(true);

        answer(new Response('ok', { status: 200 }));
        await dispatched;
        const body = JSON.parse((mockFetch.mock.calls[0] as [unknown, { body: string }])[1].body) as {
          data: { media: Record<string, unknown> };
        };
        expect(body.data.media).toEqual({ mimetype: 'image/jpeg', omitted: true, sizeBytes: 1024 * 1024 + 1 });
      } finally {
        mockFetch.mockReset();
      }
    });
  });

  // ── test probe ────────────────────────────────────────────────────

  describe('test', () => {
    const mockFetch = undiciFetch as jest.Mock;

    afterEach(() => mockFetch.mockReset());

    it('test() probes the receiver using the configured WEBHOOK_TIMEOUT', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

      await service.test('sess-1', webhook.id);

      expect(mockFetch).toHaveBeenCalled();
      expect(timeoutSpy).toHaveBeenCalledWith(25000);
      timeoutSpy.mockRestore();
    });

    // Receivers dedup on X-OpenWA-Idempotency-Key. A key that repeats per webhook makes every test
    // after the first a silent duplicate that reports success while the handler never runs.
    it('test() sends a fresh idempotency key on every call, suffixed with the webhook id', async () => {
      const webhook = createMockWebhook({ events: ['message.received'] });
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);

      await service.test('sess-1', webhook.id);
      await service.test('sess-1', webhook.id);

      const keys = (mockFetch.mock.calls as Array<[string, { headers: Record<string, string> }]>).map(
        ([, init]) => init.headers['X-OpenWA-Idempotency-Key'],
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
      for (const key of keys) expect(key.endsWith(`_${webhook.id}`)).toBe(true);
    });

    // The probe must carry exactly what a real delivery would, or a receiver that passes the test can
    // still reject live traffic (a stripped header, a signature over different bytes).
    it('test() sends the headers of a real delivery, signed over the exact body', async () => {
      const webhook = createMockWebhook({
        secret: 'probe-secret',
        headers: { 'X-Custom': 'a', 'X-OpenWA-Event': 'forged', 'Content-Type': 'text/plain', Connection: 'close' },
      });
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(service.test('sess-1', webhook.id)).resolves.toEqual({ success: true, statusCode: 200 });

      const [, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
      const sent = JSON.parse(init.body) as { idempotencyKey: string; deliveryId: string };
      expect(init.headers).toEqual(
        buildDeliveryHeaders(webhook, 'test', sent.idempotencyKey, sent.deliveryId, init.body),
      );
      expect(init.headers).toMatchObject({
        'X-Custom': 'a',
        'X-OpenWA-Event': 'test',
        'Content-Type': 'application/json',
        'X-OpenWA-Retry-Count': '0',
        'X-OpenWA-Signature': `sha256=${createHmac('sha256', 'probe-secret').update(init.body).digest('hex')}`,
      });
      expect(init.headers).not.toHaveProperty('Connection');
    });

    it('test() reports a non-2xx receiver answer as a status, without throwing', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      await expect(service.test('sess-1', webhook.id)).resolves.toEqual({ success: false, statusCode: 500 });
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
  });

  describe('listDeliveryFailures', () => {
    it('queries most-recent-first, optionally scoped to a session', async () => {
      (failureRepository.find as jest.Mock).mockResolvedValue([{ id: 'f1' }]);

      const out = await service.listDeliveryFailures({ sessionId: 's1', limit: 10 });

      expect(out).toHaveLength(1);
      // sessionId resolves through resolveSessionScope, so the WHERE is an IN over the effective scope
      // ([s1] here for an unrestricted key narrowing to one session) — behaviourally the same rows.
      expect(failureRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sessionId: In(['s1']) }, order: { createdAt: 'DESC', id: 'DESC' } }),
      );
    });

    it('flags the rows that still hold a replay payload, without reading any payload', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string, def?: unknown) =>
        key === 'webhook.failurePayloadRetentionHours' ? 24 : def,
      );
      (failureRepository.find as jest.Mock)
        .mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }])
        .mockResolvedValueOnce([{ id: 'f2' }]);

      const out = await service.listDeliveryFailures({});

      expect(out).toEqual([
        { id: 'f1', replayable: false },
        { id: 'f2', replayable: true },
      ]);
      const second = ((failureRepository.find as jest.Mock).mock.calls as unknown[][])[1][0] as {
        select: Record<string, boolean>;
        where: Record<string, unknown>;
      };
      expect(second.select).toEqual({ id: true });
      expect(second.where.id).toEqual(In(['f1', 'f2']));
      expect(second.where.createdAt).toEqual(expect.any(FindOperator));
    });

    it('reports retained payloads as unavailable when retention is disabled', async () => {
      (failureRepository.find as jest.Mock).mockResolvedValue([{ id: 'f1' }]);
      await expect(service.listDeliveryFailures({})).resolves.toEqual([{ id: 'f1', replayable: false }]);
      expect(failureRepository.find).toHaveBeenCalledTimes(1);
    });

    it('skips the replayable lookup for an empty page', async () => {
      (failureRepository.find as jest.Mock).mockResolvedValue([]);
      await expect(service.listDeliveryFailures({})).resolves.toEqual([]);
      expect(failureRepository.find).toHaveBeenCalledTimes(1);
    });
  });
});
