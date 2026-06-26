import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { WebhookController } from './webhook.controller';
import { WebhooksListController } from './webhooks-list.controller';
import { WebhookService } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
import { Session } from '../session/entities/session.entity';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/**
 * Regression locks for the secret/headers leak and read authorization.
 * e2e coverage is deferred (the e2e harness is currently broken),
 * so these controller-level unit tests are the regression gate.
 */

function createSecretWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-uuid-1',
    sessionId: 'sess-1',
    url: 'https://example.com/webhook',
    events: ['message.received'],
    secret: 's3cr3t-hmac-key',
    headers: { Authorization: 'Bearer receiver-token' },
    filters: null,
    active: true,
    retryCount: 3,
    lastTriggeredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    session: undefined as unknown as Session,
    ...overrides,
  };
}

describe('Webhook controllers (secret leak + read authz)', () => {
  let controller: WebhookController;
  let listController: WebhooksListController;
  let reflector: Reflector;
  let service: jest.Mocked<Partial<WebhookService>>;

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findBySession: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController, WebhooksListController],
      providers: [{ provide: WebhookService, useValue: service }],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
    listController = module.get<WebhooksListController>(WebhooksListController);
    reflector = new Reflector();
  });

  // ── secret/headers must never appear in any response body ──────

  it('findOne does not return secret or headers, but keeps safe fields', async () => {
    (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook());

    const result = await controller.findOne('wh-uuid-1');

    expect(result).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('headers');
    expect(JSON.stringify(result)).not.toContain('s3cr3t');
    expect(result.id).toBe('wh-uuid-1');
    expect(result.url).toBe('https://example.com/webhook');
    expect(result.events).toEqual(['message.received']);
    expect(result.active).toBe(true);
  });

  it('findBySession strips secret/headers from every item', async () => {
    (service.findBySession as jest.Mock).mockResolvedValue([
      createSecretWebhook(),
      createSecretWebhook({ id: 'wh-2' }),
    ]);

    const result = await controller.findBySession('sess-1');

    expect(result).toHaveLength(2);
    for (const w of result) {
      expect(w).not.toHaveProperty('secret');
      expect(w).not.toHaveProperty('headers');
    }
    expect(JSON.stringify(result)).not.toContain('s3cr3t');
  });

  it('cross-session findAll strips secret/headers', async () => {
    (service.findAll as jest.Mock).mockResolvedValue([createSecretWebhook()]);

    const result = await listController.findAll();

    expect(result[0]).not.toHaveProperty('secret');
    expect(result[0]).not.toHaveProperty('headers');
    expect(JSON.stringify(result)).not.toContain('Bearer receiver-token');
  });

  it('create response echoes no secret/headers', async () => {
    (service.create as jest.Mock).mockResolvedValue(createSecretWebhook());

    const result = await controller.create('sess-1', { url: 'https://example.com/webhook', secret: 's3cr3t-hmac-key' });

    expect(result).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('headers');
    expect(result.id).toBe('wh-uuid-1');
  });

  it('update response returns no secret/headers', async () => {
    (service.update as jest.Mock).mockResolvedValue(createSecretWebhook({ url: 'https://new.example.com/hook' }));

    const result = await controller.update('wh-uuid-1', { url: 'https://new.example.com/hook' });

    expect(result).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('headers');
    expect(result.url).toBe('https://new.example.com/hook');
  });

  // ── read routes require OPERATOR+ (VIEWER → 403 via guard) ─────

  it('findBySession requires OPERATOR role', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    const role = reflector.get<ApiKeyRole>(REQUIRED_ROLE_KEY, controller.findBySession);
    expect(role).toBe(ApiKeyRole.OPERATOR);
  });

  it('findOne requires OPERATOR role', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    const role = reflector.get<ApiKeyRole>(REQUIRED_ROLE_KEY, controller.findOne);
    expect(role).toBe(ApiKeyRole.OPERATOR);
  });

  it('cross-session findAll requires OPERATOR role', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    const role = reflector.get<ApiKeyRole>(REQUIRED_ROLE_KEY, listController.findAll);
    expect(role).toBe(ApiKeyRole.OPERATOR);
  });
});
