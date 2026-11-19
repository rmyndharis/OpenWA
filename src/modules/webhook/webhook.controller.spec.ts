import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { WebhookController } from './webhook.controller';
import { WebhooksListController } from './webhooks-list.controller';
import { WebhookService } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
import { Session } from '../session/entities/session.entity';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { WebhookRedriveService } from './webhook-redrive.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/**
 * Regression locks for the secret/headers leak and read authorization at the controller level.
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
  let redrive: { redrive: jest.Mock };
  let audit: { logInfo: jest.Mock };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findBySession: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    redrive = { redrive: jest.fn() };
    audit = { logInfo: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController, WebhooksListController],
      providers: [
        { provide: WebhookService, useValue: service },
        { provide: WebhookRedriveService, useValue: redrive },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
    listController = module.get<WebhooksListController>(WebhooksListController);
    reflector = new Reflector();
  });

  // ── secret/headers must never appear in any response body ──────

  it('findOne does not return secret or headers, but keeps safe fields', async () => {
    (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook());

    const result = await controller.findOne('sess-1', 'wh-uuid-1');

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
    (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook());
    (service.update as jest.Mock).mockResolvedValue(createSecretWebhook({ url: 'https://new.example.com/hook' }));

    const result = await controller.update('sess-1', 'wh-uuid-1', { url: 'https://new.example.com/hook' });

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

  // ── redrive sends real events: ADMIN only, scoped by the key, audited ─────

  it('delivery-failure redrive requires ADMIN role', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    const role = reflector.get<ApiKeyRole>(REQUIRED_ROLE_KEY, listController.redriveDeliveryFailures);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });

  it("delivery-failure redrive passes the key's allowedSessions and audits the counts", async () => {
    const result = { redriven: 2, delivered: 2, enqueued: 0, failed: 1, skipped: 0, remaining: 4 };
    redrive.redrive.mockResolvedValue(result);
    const apiKey = { id: 'key-1', allowedSessions: ['sess-1'] } as unknown as ApiKey;

    await expect(listController.redriveDeliveryFailures({ sessionId: 'sess-1', limit: 10 }, apiKey)).resolves.toBe(
      result,
    );

    expect(redrive.redrive).toHaveBeenCalledWith({ sessionId: 'sess-1', limit: 10 }, ['sess-1']);
    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.WEBHOOK_DELIVERIES_REDRIVEN, {
      apiKey,
      sessionId: 'sess-1',
      metadata: { webhookId: undefined, ids: undefined, redriven: 2, failed: 1, skipped: 0, remaining: 4 },
    });
  });

  // ── a webhook streams a session's events to a URL: creating, changing and deleting one is audited ─────

  describe('audit rows for webhook administration', () => {
    const apiKey = { id: 'key-1', name: 'ops-key', allowedSessions: null } as unknown as ApiKey;
    // Tokens sit in the path and the query of chat-tool webhook URLs, and in the custom headers.
    const tokenUrl = 'https://hooks.example.com:8443/services/T000/B000/path-token-1?key=query-token-2';
    const hidden = ['s3cr3t-hmac-key', 'Bearer receiver-token', 'path-token-1', 'query-token-2', '/services/'];

    const expectNothingSecret = (): void => {
      const written = JSON.stringify(audit.logInfo.mock.calls);
      for (const value of hidden) expect(written).not.toContain(value);
    };

    it('records a created webhook with its host and events, for the key and the session', async () => {
      (service.create as jest.Mock).mockResolvedValue(
        createSecretWebhook({ url: tokenUrl, events: ['message.received', 'session.status'] }),
      );

      await controller.create('sess-1', { url: tokenUrl, secret: 's3cr3t-hmac-key' }, apiKey);

      expect(audit.logInfo).toHaveBeenCalledTimes(1);
      expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.WEBHOOK_CREATED, {
        apiKey,
        sessionId: 'sess-1',
        metadata: {
          webhookId: 'wh-uuid-1',
          urlHost: 'hooks.example.com:8443',
          events: ['message.received', 'session.status'],
          active: true,
        },
      });
      expectNothingSecret();
    });

    it('records no row for a webhook the service refused to create', async () => {
      (service.create as jest.Mock).mockRejectedValue(new Error('Destination address is not allowed'));

      await expect(controller.create('sess-1', { url: tokenUrl }, apiKey)).rejects.toThrow('not allowed');

      expect(audit.logInfo).not.toHaveBeenCalled();
    });

    it('records a changed URL with the old and the new host and the names of the changed fields', async () => {
      (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook({ url: tokenUrl }));
      (service.update as jest.Mock).mockResolvedValue(
        createSecretWebhook({ url: 'https://new.example.com/hook', secret: 'another-secret-value', active: false }),
      );

      await controller.update('sess-1', 'wh-uuid-1', { url: 'https://new.example.com/hook' }, apiKey);

      expect(audit.logInfo).toHaveBeenCalledTimes(1);
      expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.WEBHOOK_UPDATED, {
        apiKey,
        sessionId: 'sess-1',
        metadata: {
          webhookId: 'wh-uuid-1',
          urlHost: 'new.example.com',
          events: ['message.received'],
          active: false,
          changed: ['url', 'secret', 'active'],
          previousUrlHost: 'hooks.example.com:8443',
        },
      });
      expectNothingSecret();
      expect(JSON.stringify(audit.logInfo.mock.calls)).not.toContain('another-secret-value');
    });

    it('names a changed secret or header without its value, and no previous host when the URL is unchanged', async () => {
      (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook());
      (service.update as jest.Mock).mockResolvedValue(
        createSecretWebhook({ secret: null, headers: { Authorization: 'Bearer rotated-token' } }),
      );

      await controller.update('sess-1', 'wh-uuid-1', { secret: '', headers: { Authorization: 'x' } }, apiKey);

      const [, context] = audit.logInfo.mock.calls[0] as [AuditAction, { metadata: Record<string, unknown> }];
      expect(context.metadata.changed).toEqual(['secret', 'headers']);
      expect(context.metadata).not.toHaveProperty('previousUrlHost');
      expectNothingSecret();
      expect(JSON.stringify(audit.logInfo.mock.calls)).not.toContain('rotated-token');
    });

    it('records no row for an update that leaves every field as it was', async () => {
      // A client re-sends every field on each edit, so the stored values come back equal, object keys in any order.
      (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook({ headers: { A: '1', B: '2' } }));
      (service.update as jest.Mock).mockResolvedValue(createSecretWebhook({ headers: { B: '2', A: '1' } }));

      await controller.update('sess-1', 'wh-uuid-1', { headers: { B: '2', A: '1' }, active: true }, apiKey);

      expect(audit.logInfo).not.toHaveBeenCalled();
    });

    it('records no row for an update the service refused or could not find', async () => {
      (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook());
      (service.update as jest.Mock).mockRejectedValue(new Error('Destination address is not allowed'));
      await expect(controller.update('sess-1', 'wh-uuid-1', { url: tokenUrl }, apiKey)).rejects.toThrow('not allowed');

      (service.findOne as jest.Mock).mockRejectedValue(new Error('not found'));
      await expect(controller.update('sess-1', 'wh-uuid-9', { active: false }, apiKey)).rejects.toThrow('not found');

      expect(service.update).toHaveBeenCalledTimes(1);
      expect(audit.logInfo).not.toHaveBeenCalled();
    });

    it('records a deleted webhook with the host and events it had, read before the delete', async () => {
      const order: string[] = [];
      (service.findOne as jest.Mock).mockImplementation(() => {
        order.push('read');
        return Promise.resolve(createSecretWebhook({ url: tokenUrl, events: ['*'], active: false }));
      });
      (service.delete as jest.Mock).mockImplementation(() => {
        order.push('delete');
        return Promise.resolve();
      });

      await expect(controller.delete('sess-1', 'wh-uuid-1', apiKey)).resolves.toBeUndefined();

      expect(order).toEqual(['read', 'delete']);
      expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.WEBHOOK_DELETED, {
        apiKey,
        sessionId: 'sess-1',
        metadata: { webhookId: 'wh-uuid-1', urlHost: 'hooks.example.com:8443', events: ['*'], active: false },
      });
      expectNothingSecret();
    });

    it('records no row for a delete that found nothing or failed', async () => {
      (service.findOne as jest.Mock).mockRejectedValue(new Error('not found'));
      await expect(controller.delete('sess-1', 'wh-uuid-9', apiKey)).rejects.toThrow('not found');
      expect(service.delete).not.toHaveBeenCalled();

      (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook());
      (service.delete as jest.Mock).mockRejectedValue(new Error('not found'));
      await expect(controller.delete('sess-1', 'wh-uuid-1', apiKey)).rejects.toThrow('not found');

      expect(audit.logInfo).not.toHaveBeenCalled();
    });

    it('does not wait for the audit write', async () => {
      (service.create as jest.Mock).mockResolvedValue(createSecretWebhook());
      audit.logInfo.mockReturnValue(new Promise(() => undefined));

      await expect(controller.create('sess-1', { url: tokenUrl }, apiKey)).resolves.toMatchObject({ id: 'wh-uuid-1' });
    });

    it('keeps an unparsable stored URL out of the row', async () => {
      (service.findOne as jest.Mock).mockResolvedValue(createSecretWebhook({ url: 'not a url?token=abc' }));
      (service.delete as jest.Mock).mockResolvedValue(undefined);

      await controller.delete('sess-1', 'wh-uuid-1', apiKey);

      const [, context] = audit.logInfo.mock.calls[0] as [AuditAction, { metadata: Record<string, unknown> }];
      expect(context.metadata.urlHost).toBe('unknown');
      expect(JSON.stringify(context)).not.toContain('abc');
    });
  });
});
