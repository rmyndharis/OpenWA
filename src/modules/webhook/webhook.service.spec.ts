import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { WebhookService, WebhookPayload } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
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
  let configService: jest.Mocked<Partial<ConfigService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let webhookQueue: jest.Mocked<Record<string, jest.Mock>>;

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
    };

    configService = {
      get: jest.fn().mockImplementation(<T>(key: string, def?: T): T | boolean | number => {
        if (key === 'queue.enabled') return false;
        if (key === 'webhook.retryDelay') return 100;
        if (key === 'webhook.timeout') return 10000;
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
        { provide: ConfigService, useValue: configService },
        { provide: HookManager, useValue: hookManager },
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

      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it('should return webhook by id', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);

      const result = await service.findOne('wh-uuid-1');
      expect(result.id).toBe('wh-uuid-1');
    });

    it('should throw NotFoundException if not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update only provided fields', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      (repository.save as jest.Mock).mockImplementation(w => Promise.resolve(w));

      const result = await service.update('wh-uuid-1', { url: 'https://new-url.com/hook' });

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

      await service.delete('wh-uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(webhook);
    });
  });

  // ── test ─────────────────────────────────────────────────────────

  describe('test', () => {
    const mockFetch = jest.fn();

    beforeEach(() => {
      global.fetch = mockFetch as typeof global.fetch;
      jest.spyOn(service as unknown as { delay: (ms: number) => Promise<void> }, 'delay').mockResolvedValue(undefined);
    });

    afterEach(() => {
      mockFetch.mockReset();
      jest.restoreAllMocks();
    });

    it('should return success when endpoint responds with 2xx', async () => {
      const webhook = createMockWebhook();
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: jest.fn().mockResolvedValue('ok'),
      });

      const result = await service.test('sess-1', 'wh-uuid-1');

      expect(result).toEqual({ success: true, statusCode: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should retry transient 404 and succeed on next attempt', async () => {
      const webhook = createMockWebhook({ retryCount: 2 });
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: jest.fn().mockResolvedValue('route not ready'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: jest.fn().mockResolvedValue('ok'),
        });

      const result = await service.test('sess-1', 'wh-uuid-1');

      expect(result).toEqual({ success: true, statusCode: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return detailed error for non-2xx response', async () => {
      const webhook = createMockWebhook({ retryCount: 1 });
      (repository.findOne as jest.Mock).mockResolvedValue(webhook);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: jest.fn().mockResolvedValue('Cannot POST /webhook'),
      });

      const result = await service.test('sess-1', 'wh-uuid-1');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.error).toContain('HTTP 404 Not Found');
      expect(result.error).toContain('Cannot POST /webhook');
    });
  });

  // ── dispatch (direct mode — queue disabled) ───────────────────────

  describe('dispatch (direct mode)', () => {
    const mockFetch = jest.fn();

    beforeEach(() => {
      global.fetch = mockFetch as typeof global.fetch;
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    afterEach(() => {
      mockFetch.mockReset();
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

      await service.dispatch('sess-1', 'message.received', { from: '628123456789@c.us' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );
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
      const mockFetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
        Object.assign(capturedHeaders, opts.headers as Record<string, string>);
        return Promise.resolve({ ok: true, status: 200 });
      });
      global.fetch = mockFetch as typeof global.fetch;

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

      // Verify signature correctness
      const body = JSON.stringify({
        event: 'message.received',
        data: {},
        timestamp: '',
        sessionId: 'sess-1',
        idempotencyKey: 'k',
        deliveryId: 'd',
      });
      const expected = `sha256=${crypto.createHmac('sha256', 'test-secret-123').update(body).digest('hex')}`;
      expect(capturedHeaders['X-OpenWA-Signature']).toBe(expected);

      mockFetch.mockReset();
    });
  });

  // ── dispatch (queue mode) ─────────────────────────────────────────

  describe('dispatch (queue mode)', () => {
    it('should add job to queue when queue is enabled', async () => {
      // Create a new service with queue enabled
      const queueModule: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookService,
          { provide: getRepositoryToken(Webhook, 'data'), useValue: repository },
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
  });
});
