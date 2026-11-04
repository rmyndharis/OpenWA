// GET /webhooks/delivery-failures takes sessionId as a QUERY param, which the ApiKeyGuard fence
// (route-params only) does not scope. A session-restricted ADMIN key must not read another session's
// failed-delivery rows — which carry the webhook URL, event, idempotencyKey and lastError. Exercised
// end-to-end against a real in-memory DB, mirroring webhook-session-scope.spec.ts.
import { DataSource } from 'typeorm';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { Webhook } from './entities/webhook.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';

describe('WebhookService.listDeliveryFailures session scoping', () => {
  let ds: DataSource;
  let service: WebhookService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WebhookDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    const failureRepo = ds.getRepository(WebhookDeliveryFailure);
    const cfg = { get: () => false };
    // 2nd arg is the delivery-failure repo; the webhook/session repos and the delivery service
    // (5th arg) are never touched by the scoping paths under test.
    service = new WebhookService({} as never, failureRepo, {} as never, cfg as never, {} as never);
    for (const sessionId of ['sessA', 'sessB']) {
      await failureRepo.save(
        failureRepo.create({
          webhookId: `wh-${sessionId}`,
          sessionId,
          event: 'message.received',
          url: `https://${sessionId}.example/hook`,
          attempts: 3,
          lastError: 'ECONNREFUSED',
        }),
      );
    }
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('a key scoped to sessA sees only sessA failures, never sessB', async () => {
    const rows = await service.listDeliveryFailures({}, ['sessA']);
    expect(rows.map(r => r.sessionId)).toEqual(['sessA']);
  });

  it('a scoped key requesting sessB (outside its scope) gets nothing', async () => {
    const rows = await service.listDeliveryFailures({ sessionId: 'sessB' }, ['sessA']);
    expect(rows).toEqual([]);
  });

  it('an unrestricted key (null allowlist) sees all sessions', async () => {
    const rows = await service.listDeliveryFailures({}, null);
    expect(rows.map(r => r.sessionId).sort()).toEqual(['sessA', 'sessB']);
  });

  it('an unrestricted key can narrow to a single session via the query param', async () => {
    const rows = await service.listDeliveryFailures({ sessionId: 'sessB' }, null);
    expect(rows.map(r => r.sessionId)).toEqual(['sessB']);
  });
});

// With payload retention on, a failure row keeps the whole event it was built from, which can be a message
// body. The route serializes the rows it gets as they are, so the column staying out of the read is what
// keeps that text from every key that may list failures.
describe('WebhookService.listDeliveryFailures retained event body', () => {
  let ds: DataSource;
  let service: WebhookService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    const failureRepo = ds.getRepository(WebhookDeliveryFailure);
    const webhookRepo = ds.getRepository(Webhook);
    const cfg = {
      get: (key: string, fallback?: unknown) => (key === 'webhook.failurePayloadRetentionHours' ? 24 : fallback),
    };
    service = new WebhookService(webhookRepo, failureRepo, {} as never, cfg as never, {} as never);
    await ds.getRepository(Session).save({ id: 'sessA', name: 'sessA', status: SessionStatus.READY, config: {} });
    // The row is replayable only while its webhook exists.
    const webhook = await webhookRepo.save({ sessionId: 'sessA', url: 'https://sessA.example/hook' });
    await failureRepo.save(
      failureRepo.create({
        webhookId: webhook.id,
        sessionId: 'sessA',
        event: 'message.received',
        url: 'https://sessA.example/hook',
        idempotencyKey: 'key-1',
        attempts: 3,
        lastError: 'ECONNREFUSED',
        payload: { body: 'private message text' },
      }),
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('flags a row as replayable without returning the event body it retains', async () => {
    const rows = await service.listDeliveryFailures({}, null);

    expect(rows.map(r => r.replayable)).toEqual([true]);
    expect(JSON.stringify(rows)).not.toContain('private message text');
  });
});
