import http from 'http';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { Webhook } from './../src/modules/webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from './../src/modules/webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from './../src/modules/webhook/entities/webhook-delivery-failure.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { WebhookService } from './../src/modules/webhook/webhook.service';

/**
 * A message whose id the engine could not read is reported with the empty id and still reaches the webhooks (the
 * message pipeline stores it under no id and announces it). Two such messages are two events: each must get its own
 * idempotency key and its own outbox record, or a receiver that deduplicates on `X-OpenWA-Idempotency-Key` keeps the
 * first and drops the rest, only one of them has a durable replay copy, and the delivery of one message settles the
 * records of another.
 */
describe('Webhook delivery of messages whose id could not be read (e2e)', () => {
  let app: INestApplication<App>;
  let receiver: http.Server;
  let receiverUrl: string;
  let receiverStatus: number;
  let webhookService: WebhookService;
  let webhooks: Repository<Webhook>;
  let outbox: Repository<WebhookOutboxEvent>;
  let failures: Repository<WebhookDeliveryFailure>;
  let sessions: Repository<Session>;
  let received: Array<{ key: string | undefined; body: Record<string, unknown> }>;
  let prevSsrf: string | undefined;

  beforeAll(async () => {
    prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    webhookService = app.get(WebhookService);
    webhooks = app.get<Repository<Webhook>>(getRepositoryToken(Webhook, 'data'));
    outbox = app.get<Repository<WebhookOutboxEvent>>(getRepositoryToken(WebhookOutboxEvent, 'data'));
    failures = app.get<Repository<WebhookDeliveryFailure>>(getRepositoryToken(WebhookDeliveryFailure, 'data'));
    sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));

    received = [];
    receiverStatus = 200;
    receiver = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        received.push({
          key: req.headers['x-openwa-idempotency-key'] as string | undefined,
          body: JSON.parse(raw || '{}') as Record<string, unknown>,
        });
        res.writeHead(receiverStatus).end();
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    await app?.close();
    if (prevSsrf === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
  });

  const newWebhook = async (event: string, retryCount?: number): Promise<{ sessionId: string; webhookId: string }> => {
    received.length = 0;
    receiverStatus = 200;
    const session = await sessions.save(sessions.create({ name: `unreadable-id-${Date.now()}-${Math.random()}` }));
    const webhook = await webhooks.save(
      webhooks.create({ sessionId: session.id, url: receiverUrl, events: [event], active: true, retryCount }),
    );
    return { sessionId: session.id, webhookId: webhook.id };
  };

  const dispatchTwoUnreadable = async (sessionId: string, event: string): Promise<void> => {
    const base = { id: '', from: '628111111111@c.us', chatId: '628111111111@c.us', type: 'text' };
    await webhookService.dispatch(sessionId, event, { ...base, body: 'first', timestamp: 1790000000 });
    await webhookService.dispatch(sessionId, event, { ...base, body: 'second', timestamp: 1790000005 });
  };

  describe.each(['message.received', 'message.sent', 'message.revoked'])('%s', event => {
    it('gives two events with an unreadable id two idempotency keys', async () => {
      const { sessionId } = await newWebhook(event);

      await dispatchTwoUnreadable(sessionId, event);

      expect(received.map(r => (r.body.data as { body: string }).body)).toEqual(['first', 'second']);
      expect(new Set(received.map(r => r.key)).size).toBe(2);
    });

    it('records two outbox rows for two events with an unreadable id, under the keys it sent', async () => {
      const { sessionId, webhookId } = await newWebhook(event);

      await dispatchTwoUnreadable(sessionId, event);

      const rows = await outbox.find({ where: { webhookId } });
      expect(rows.map(r => r.idempotencyKey).sort()).toEqual(received.map(r => r.key).sort());
    });
  });

  it('keeps the documented key for a message whose id was read, and still collapses its duplicate', async () => {
    const { sessionId, webhookId } = await newWebhook('message.received');
    const data = { id: '3EB0ABC123', from: 'a@c.us', body: 'hi' };

    await webhookService.dispatch(sessionId, 'message.received', data);
    await webhookService.dispatch(sessionId, 'message.received', data);

    expect(received.map(r => r.key)).toEqual([`msg_${sessionId}_3EB0ABC123_${webhookId}`, expect.any(String)]);
    expect(received[1].key).toBe(received[0].key);
    expect(await outbox.count({ where: { webhookId } })).toBe(1);
  });

  it('keeps the terminal failure record of one message when another message with an unreadable id is delivered', async () => {
    const { sessionId, webhookId } = await newWebhook('message.received', 1);
    const base = { id: '', from: '628111111111@c.us', chatId: '628111111111@c.us', type: 'text' };

    receiverStatus = 500;
    await webhookService.dispatch(sessionId, 'message.received', { ...base, body: 'A', timestamp: 1790000000 });
    expect(await failures.count({ where: { webhookId } })).toBe(1);

    receiverStatus = 200;
    await webhookService.dispatch(sessionId, 'message.received', { ...base, body: 'B', timestamp: 1790000005 });

    expect(await failures.count({ where: { webhookId } })).toBe(1);
    expect(await outbox.count({ where: { webhookId } })).toBe(2);
  });
});
