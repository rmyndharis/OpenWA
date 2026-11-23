jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookReconcilerService } from '../webhook/webhook-reconciler.service';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function incomingMsg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'WA-MSG-1',
    chatId: '628111@c.us',
    from: '628111@c.us',
    to: '628222@c.us',
    body: 'hello world',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    ...over,
  } as IncomingMessage;
}

describe('MessageProjector + WebhookOutbox transactional atomicity (SQLite)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let webhookService: WebhookService;
  let reconciler: WebhookReconcilerService;
  let hookManager: HookManager;
  let eventsGateway: {
    emitMessage: jest.Mock;
    emitMessageSent: jest.Mock;
    emitMessageRevoked: jest.Mock;
    emitMessageReaction: jest.Mock;
  };
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();

    const session = await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        name: 'atomic-test',
        status: SessionStatus.READY,
        config: {},
      }),
    );
    sessionId = session.id;

    const configService = {
      get: <T>(key: string, defaultValue?: T): T => {
        const values: Record<string, unknown> = {
          'queue.enabled': false,
          'webhook.dispatchConcurrency': 8,
          'webhook.dispatchMaxQueued': 100,
          'webhook.timeout': 5000,
          'webhook.retryDelay': 50,
          'webhook.shutdownDrainMs': 1000,
          'webhook.failurePayloadRetentionHours': 0,
          'webhook.maxPayloadBytes': 1024 * 1024,
          'webhook.mediaInlineMaxBytes': 1024 * 1024,
        };
        return (key in values ? values[key] : defaultValue) as T;
      },
    } as unknown as ConfigService;

    hookManager = new HookManager();
    outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
    delivery = new WebhookDeliveryService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      configService,
      hookManager,
      outbox,
    );
    webhookService = new WebhookService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      ds.getRepository(Session),
      configService,
      delivery,
    );
    reconciler = new WebhookReconcilerService(ds.getRepository(Webhook), outbox, delivery, configService);

    eventsGateway = {
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageRevoked: jest.fn(),
      emitMessageReaction: jest.fn(),
    };
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);

    projector = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      eventsGateway as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
    );
  });

  afterEach(async () => {
    await delivery.onModuleDestroy();
    await reconciler.onModuleDestroy();
    await outbox.onModuleDestroy();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  async function seedWebhook(events: string[], overrides: Partial<Webhook> = {}): Promise<Webhook> {
    return ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events,
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 1,
        ...overrides,
      }),
    );
  }

  it('rolls back the messages row when outbox.openBatch fails inside the transaction, and commits both on retry', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-ROLLBACK-1' });

    let failOutbox = true;
    const realOpenBatch = outbox.openBatch.bind(outbox);
    const openBatchSpy = jest.spyOn(outbox, 'openBatch').mockImplementation((rows, manager) => {
      if (failOutbox) {
        if (manager) return Promise.reject(new Error('simulated outbox failure'));
        return Promise.resolve(null);
      }
      return realOpenBatch(rows, manager);
    });

    const first = projector.handleInboundMessage(sessionId, engine, msg);
    await first?.settled;
    await flush();

    // Outbox failure inside the transaction must roll back the messages row atomically.
    expect(openBatchSpy).toHaveBeenCalled();
    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-ROLLBACK-1' } })).toBe(0);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);

    // Subsequent retry succeeds and commits BOTH messages and webhook_outbox_events atomically.
    failOutbox = false;
    const retry = projector.handleInboundMessage(sessionId, engine, msg);
    await retry?.settled;
    await waitFor(async () => {
      const row = await ds.getRepository(WebhookOutboxEvent).findOne({ where: { sessionId } });
      return row?.state === 'dispatched';
    });

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-ROLLBACK-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
  });

  it('commits messages and pending webhook_outbox_events atomically so WebhookReconcilerService replays after a post-commit crash', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-CRASH-1', body: 'survives crash' });

    // Simulate process death immediately after transaction commit, before dispatchPrepared runs.
    const crashSpy = jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(crashSpy).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();

    // Both messages and a pending outbox row with replay payload must be durable in DB.
    const storedMsg = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: 'WA-CRASH-1' } });
    expect(storedMsg).not.toBeNull();
    expect(storedMsg?.body).toBe('survives crash');

    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      webhookId: webhook.id,
      sessionId,
      event: 'message.received',
      state: 'pending',
    });
    expect(outboxRows[0].payload).toMatchObject({ id: 'WA-CRASH-1', body: 'survives crash' });

    // After restart, WebhookReconcilerService replays the stranded pending outbox row.
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(init.headers['X-OpenWA-Idempotency-Key']).toBe(outboxRows[0].idempotencyKey);
    expect(JSON.parse(init.body)).toMatchObject({
      event: 'message.received',
      data: expect.objectContaining({ id: 'WA-CRASH-1', body: 'survives crash' }) as unknown,
    });

    const settledRow = await ds.getRepository(WebhookOutboxEvent).findOneBy({ id: outboxRows[0].id });
    expect(settledRow?.state).toBe('dispatched');
    expect(settledRow?.payload).toBeNull();
  });

  it('dedups duplicate waMessageId without rolling back concurrent writes or adding extra outbox rows', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-DUP-1', body: 'original' });

    const first = projector.handleInboundMessage(sessionId, engine, msg);
    await first?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);

    mockFetch.mockClear();

    // Replay the exact same waMessageId concurrently with an unrelated DB write.
    const dupReceipt = projector.handleInboundMessage(sessionId, engine, msg);
    const concurrentWrite = ds.getRepository(WebhookDeliveryFailure).insert({
      webhookId: 'w-other',
      sessionId,
      event: 'message.ack',
      url: 'https://receiver.example/hook',
      idempotencyKey: 'concurrent_write_key',
      deliveryId: 'conc-1',
      attempts: 1,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    });
    await Promise.all([dupReceipt?.settled, concurrentWrite]);
    await flush();

    // Duplicate inserted 0 extra messages, 0 extra outbox rows, did not dispatch again,
    // and never rolled back the concurrent write on SQLite's shared connection.
    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-DUP-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(
      await ds.getRepository(WebhookDeliveryFailure).count({ where: { idempotencyKey: 'concurrent_write_key' } }),
    ).toBe(1);
  });

  it('commits outbound echo messages and message.sent outbox rows atomically in commitOwnSendEcho', async () => {
    const webhook = await seedWebhook(['message.sent']);
    const echo = incomingMsg({
      id: 'WA-ECHO-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent from phone',
    });

    // 1. Outbox failure rolls back the outgoing messages row atomically.
    let failOutbox = true;
    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementation((rows, manager) => {
      if (failOutbox) {
        if (manager) return Promise.reject(new Error('outbox failure on echo'));
        return Promise.resolve(null);
      }
      return realOpenBatch(rows, manager);
    });

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => eventsGateway.emitMessageSent.mock.calls.length === 1);
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-ECHO-1' } })).toBe(0);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);

    // 2. Simulate post-commit crash on retry: both outgoing message and pending message.sent outbox row survive.
    failOutbox = false;
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());
    mockFetch.mockClear();

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(
      async () => (await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-ECHO-1' } })) === 1,
    );
    await flush();

    const stored = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: 'WA-ECHO-1' } });
    expect(stored?.direction).toBe(MessageDirection.OUTGOING);
    expect(stored?.body).toBe('sent from phone');

    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      webhookId: webhook.id,
      sessionId,
      event: 'message.sent',
      state: 'pending',
    });
    expect(mockFetch).not.toHaveBeenCalled();

    // Reconciler replays the committed message.sent outbox row.
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('closes the prepared outbox row and suppresses message.received dispatch when revoked mid-flight', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-REV-1', body: 'secret text' });

    // Trigger an engine revoke immediately after openBatch writes the outbox row inside the tx
    // (before dispatchInboundMessage inspects withChangesMadeInFlight).
    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      // Schedule the revoke on the next microtask so it lands right after tx commit, before dispatch.
      queueMicrotask(() => {
        projector.handleMessageRevoked(sessionId, engine, {
          id: msg.id,
          revokedId: msg.id,
          chatId: msg.chatId,
          from: msg.from,
          timestamp: msg.timestamp + 1,
        } as never);
      });
      return res;
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    // message.received must NOT be dispatched.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessage).not.toHaveBeenCalled();

    // The committed outbox row must have been closed (payload retired) so reconciler never replays it.
    const rows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId, event: 'message.received' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('dispatched');
    expect(rows[0].payload).toBeNull();

    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('runs webhook:before hooks strictly outside any SQLite transaction', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-HOOK-TX-1' });
    let inTxDuringHook: boolean | undefined;

    hookManager.register('test', 'webhook:before', (data: unknown) => {
      const conn = (ds.driver as { databaseConnection?: { inTransaction?: boolean } }).databaseConnection;
      inTxDuringHook = conn?.inTransaction;
      return Promise.resolve({ continue: true, data });
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);

    expect(inTxDuringHook).toBe(false);
  });

  it('preserves fail-open webhook delivery on a non-unique messages persistence error', async () => {
    await seedWebhook(['message.received']);
    await ds.query(`
      CREATE TRIGGER fail_msg_insert BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated messages storage error');
      END
    `);

    const msg = incomingMsg({ id: 'WA-FAILOPEN-1', body: 'still delivered' });
    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-FAILOPEN-1' } })).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('dispatches message.sent cleanly when commitOwnSendEcho sees an existing REST-persisted outgoing row', async () => {
    await seedWebhook(['message.sent']);
    await ds.getRepository(Message).insert({
      sessionId,
      waMessageId: 'WA-REST-1',
      chatId: '628111@c.us',
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent via api',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 1_700_000_000,
    });

    const echo = incomingMsg({
      id: 'WA-REST-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent via api',
    });

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => mockFetch.mock.calls.length === 1);

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-REST-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId, event: 'message.sent' } })).toBe(1);
  });

  it('redacts committed outbox and dispatches deletedPlaceholder on mid-flight REST revoke (announced=false)', async () => {
    const catchAll = await seedWebhook(['message.received'], { url: 'https://receiver.example/all' });
    const secretFiltered = await seedWebhook(['message.received'], {
      url: 'https://receiver.example/secret-only',
      filters: { conditions: [{ field: 'body', operator: 'contains', value: 'TOPSECRET' }] },
    });
    const msg = incomingMsg({ id: 'WA-REST-REV-1', body: 'TOPSECRET password' });

    // Crash right before live dispatch so we can inspect the reconciled pending outbox row first.
    const capturedPayloads: Array<{ url: string; body: string }> = [];
    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      // REST revoke (announced=false) lands right after commit, before dispatchInboundMessage.
      queueMicrotask(() => {
        void projector.recordRevoke(sessionId, msg.id, undefined, false);
      });
      return res;
    });

    mockFetch.mockImplementation((url: string, init: { body: string }) => {
      capturedPayloads.push({ url, body: init.body });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => capturedPayloads.length >= 1);
    await flush();

    // Only catchAll receives the delivery, with deletedPlaceholder (never the secret body).
    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].url).toBe(catchAll.url);
    const parsed = JSON.parse(capturedPayloads[0].body) as { data: Record<string, unknown> };
    expect(parsed.data).toMatchObject({ id: 'WA-REST-REV-1', type: 'revoked', body: '' });
    expect(capturedPayloads[0].body).not.toContain('TOPSECRET');

    // Neither outbox row retains the unredacted secret body.
    const rows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(rows.some(r => JSON.stringify(r.payload ?? {}).includes('TOPSECRET'))).toBe(false);
    const filteredRow = rows.find(r => r.webhookId === secretFiltered.id);
    expect(filteredRow?.state).toBe('dispatched');
    expect(filteredRow?.payload).toBeNull();
  });

  it('reconciles committed outbox rows, filters, and dispatch payload on mid-flight edit (v1 -> v2)', async () => {
    const catchAll = await seedWebhook(['message.received'], { url: 'https://receiver.example/all' });
    const v1Only = await seedWebhook(['message.received'], {
      url: 'https://receiver.example/v1',
      filters: { conditions: [{ field: 'body', operator: 'contains', value: 'draft-v1' }] },
    });
    const v2Only = await seedWebhook(['message.received'], {
      url: 'https://receiver.example/v2',
      filters: { conditions: [{ field: 'body', operator: 'contains', value: 'final-v2' }] },
    });
    const msg = incomingMsg({ id: 'WA-EDIT-DRIFT-1', body: 'draft-v1' });

    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      queueMicrotask(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'final-v2',
          fromMe: false,
        } as never);
      });
      return res;
    });

    // Pause dispatchPrepared to inspect durable reconciled outbox rows before live POST.
    const crashSpy = jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(crashSpy).toHaveBeenCalledTimes(1);
    const allRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    const byWebhook = new Map(allRows.map(r => [r.webhookId, r]));

    // v1Only stopped matching and was closed; catchAll and v2Only are pending with body='final-v2', edited=true.
    expect(byWebhook.get(v1Only.id)?.state).toBe('dispatched');
    expect(byWebhook.get(v1Only.id)?.payload).toBeNull();
    expect(byWebhook.get(catchAll.id)?.state).toBe('pending');
    expect(byWebhook.get(catchAll.id)?.payload).toMatchObject({ body: 'final-v2', edited: true });
    expect(byWebhook.get(v2Only.id)?.state).toBe('pending');
    expect(byWebhook.get(v2Only.id)?.payload).toMatchObject({ body: 'final-v2', edited: true });

    // Reconciler delivers the exact v2 payload to catchAll and v2Only only.
    const deliveredUrls: string[] = [];
    mockFetch.mockImplementation((url: string, init: { body: string }) => {
      deliveredUrls.push(url);
      expect(JSON.parse(init.body)).toMatchObject({
        data: expect.objectContaining({ body: 'final-v2', edited: true }) as unknown,
      });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(2);
    expect(deliveredUrls.sort()).toEqual([catchAll.url, v2Only.url].sort());
  });

  it('closes pending outbox rows when engine revoke races with engine retire/disconnect without touching sibling message ids', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-REV-RETIRE-1', body: 'must not leak after retire' });

    // Seed a sibling pending row whose waMessageId shares a prefix and SQL wildcard characters.
    await outbox.openBatch([
      {
        webhookId: webhook.id,
        sessionId,
        event: 'message.received',
        idempotencyKey: `msg_${sessionId}_WA-REV-RETIRE-1_sibling_${webhook.id}`,
        deliveryId: 'sib-del-1',
        payload: { id: 'WA-REV-RETIRE-1_sibling', body: 'sibling stays pending' },
      },
    ]);

    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      queueMicrotask(() => {
        projector.handleMessageRevoked(sessionId, engine, {
          id: msg.id,
          revokedId: msg.id,
          chatId: msg.chatId,
          from: msg.from,
          timestamp: msg.timestamp + 1,
        } as never);
        // Retire the engine immediately after revoke so persistInboundMessage exits at !isLive.
        engines.delete(sessionId);
      });
      return res;
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    // Revoked row is closed while the prefix-sharing sibling remains pending.
    const revokedRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-REV-RETIRE-1_${webhook.id}` },
    });
    expect(revokedRow?.state).toBe('dispatched');
    expect(revokedRow?.payload).toBeNull();

    const siblingRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-REV-RETIRE-1_sibling_${webhook.id}` },
    });
    expect(siblingRow?.state).toBe('pending');

    // Reconciler replays ONLY the sibling, never the revoked message.
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(init.body).toContain('WA-REV-RETIRE-1_sibling');
    expect(init.body).not.toContain('must not leak after retire');
  });

  it('keeps unowned pre-existing outbox rows intact on cancel and preserves Note-to-Self and repeated session.qr dispatches', async () => {
    const webhook = await seedWebhook(['message.received', 'message.sent', 'session.qr']);

    // 1. Pre-existing outbox key owned by an earlier attempt must not be closed if a later commit
    //    is revoked mid-flight (openBatch returns [] so cancelPrepared owns 0 rows).
    await outbox.openBatch([
      {
        webhookId: webhook.id,
        sessionId,
        event: 'message.received',
        idempotencyKey: `msg_${sessionId}_WA-PREEXIST-1_${webhook.id}`,
        deliveryId: 'prior-delivery',
        payload: { id: 'WA-PREEXIST-1', chatId: '628999@c.us', fromMe: false, body: 'owned by prior attempt' },
      },
    ]);

    const realCancel = delivery.cancelPrepared.bind(delivery);
    const cancelSpy = jest.spyOn(delivery, 'cancelPrepared').mockImplementation(realCancel);

    const realTransaction = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      const res = await realTransaction(...args);
      // Simulate mid-flight engine revoke (with foreign-chat pre-existing outbox row left alone).
      projector.handleMessageRevoked(
        sessionId,
        engine,
        {
          id: 'WA-PREEXIST-1',
          revokedId: 'WA-PREEXIST-1',
          chatId: '628111@c.us',
          from: '628111@c.us',
          timestamp: 1_700_000_001,
        } as never,
        { fromMe: false },
      );
      return res;
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: 'WA-PREEXIST-1' }));
    await receipt?.settled;
    await flush();

    // cancelPrepared must NOT have been asked to close the unowned pre-existing row.
    expect(cancelSpy).not.toHaveBeenCalled();
    const priorRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-PREEXIST-1_${webhook.id}` },
    });
    expect(priorRow?.state).toBe('pending');
    expect(priorRow?.payload).toMatchObject({ body: 'owned by prior attempt' });

    // 2. Note-to-Self: message.received and message.sent share msg_<session>_<waId>_<whId>;
    //    BOTH events must dispatch live without 7-day outbox retention dropping the second.
    mockFetch.mockClear();
    const receivedEvents: string[] = [];
    mockFetch.mockImplementation((_url, init?: { body?: string }) => {
      if (init?.body) {
        const parsed = JSON.parse(init.body) as { event: string };
        receivedEvents.push(parsed.event);
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('ok') });
    });

    await webhookService.dispatch(sessionId, 'message.received', {
      id: 'WA-NOTE-SELF-1',
      chatId: '628111@c.us',
      fromMe: true,
      body: 'note to self',
    });
    await webhookService.dispatch(sessionId, 'message.sent', {
      id: 'WA-NOTE-SELF-1',
      chatId: '628111@c.us',
      fromMe: true,
      body: 'note to self',
    });
    await flush();
    expect(receivedEvents).toEqual(['message.received', 'message.sent']);

    // 3. Repeated session.qr events within the 7-day retention window must BOTH dispatch.
    receivedEvents.length = 0;
    await webhookService.dispatch(sessionId, 'session.qr', { qr: 'qr-frame-1' });
    await webhookService.dispatch(sessionId, 'session.qr', { qr: 'qr-frame-2' });
    await flush();
    expect(receivedEvents).toEqual(['session.qr', 'session.qr']);

    // 4. Note-to-Self end-to-end through MessageProjector (inbound + own-send echo on same id).
    receivedEvents.length = 0;
    const selfMsg = incomingMsg({
      id: 'WA-NOTE-SELF-PROJECTOR-1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628111@c.us',
      fromMe: true,
      body: 'self note via projector',
    });
    const selfReceipt = projector.handleInboundMessage(sessionId, engine, selfMsg);
    await selfReceipt?.settled;
    await waitFor(() => receivedEvents.length === 1);
    projector.handleOwnSendEcho(sessionId, engine, selfMsg);
    await waitFor(() => receivedEvents.length === 2);
    await flush();
    expect(receivedEvents).toEqual(['message.received', 'message.sent']);
  });

  it('does not silently commit messages with 0 outbox rows on webhook lookup DB error, and commits both on retry', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-LOOKUP-ERR-1', body: 'must not drop outbox' });

    const webhookRepo = ds.getRepository(Webhook);
    let failLookup = true;
    const realFind = webhookRepo.find.bind(webhookRepo);
    jest.spyOn(webhookRepo, 'find').mockImplementation((...args) => {
      if (failLookup) return Promise.reject(new Error('webhooks table unavailable'));
      return realFind(...args);
    });

    const first = projector.handleInboundMessage(sessionId, engine, msg);
    await first?.settled;
    await flush();

    // Lookup error must NOT commit messages with 0 outbox rows (which would poison retries as 'repeat').
    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-LOOKUP-ERR-1' } })).toBe(0);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);

    // Once DB recovers, retrying the same message inserts BOTH messages and webhook_outbox_events.
    failLookup = false;
    const retry = projector.handleInboundMessage(sessionId, engine, msg);
    await retry?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-LOOKUP-ERR-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
  });

  it('preserves fail-open outbox write with latest payload on messages error and closes outbox on retried-dup revoke', async () => {
    await seedWebhook(['message.received']);
    await ds.query(`
      CREATE TRIGGER fail_msg_insert_2 BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'messages storage failure');
      END
    `);

    // Pause dispatchPrepared to verify that fail-open dispatch() still writes a best-effort outbox row.
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const msg = incomingMsg({ id: 'WA-FAILOPEN-OUTBOX-1', body: 'delivered fail-open' });
    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-FAILOPEN-OUTBOX-1' } })).toBe(
      0,
    );
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ event: 'message.received', state: 'pending' });
    expect(outboxRows[0].payload).toMatchObject({ id: 'WA-FAILOPEN-OUTBOX-1', body: 'delivered fail-open' });
  });

  it('closes pending outbox rows when a retried duplicate insert is revoked before dispatch', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-RETRY-DUP-REV-1', body: 'sensitive retry body' });

    // Simulate attempt 1 committing BOTH message + pending outbox row, then throwing a transient
    // post-commit error (e.g. connection drop), followed by an engine revoke before attempt 2 returns dup.
    const realTransaction = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    // Trigger engine revoke while insertWithRetry is sleeping before its retry attempt.
    const origSetTimeout = global.setTimeout;
    let revokeScheduled = false;
    jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (!revokeScheduled && ms === 300) {
        revokeScheduled = true;
        return origSetTimeout(() => {
          projector.handleMessageRevoked(sessionId, engine, {
            id: msg.id,
            revokedId: msg.id,
            chatId: msg.chatId,
            from: msg.from,
            timestamp: msg.timestamp + 1,
          } as never);
          fn(...rest);
        }, 10);
      }
      return origSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    // The pending outbox row committed by attempt 1 must be closed so reconciler never replays it.
    const row = await ds
      .getRepository(WebhookOutboxEvent)
      .findOne({ where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${msg.id}_${webhook.id}` } });
    expect(row?.state).toBe('dispatched');
    expect(row?.payload).toBeNull();

    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls prepareDeliveries exactly once across 0-webhook echo, REST-dup echo, and pre-edited inbound message', async () => {
    const prepareSpy = jest.spyOn(webhookService, 'prepareDeliveries');

    // (a) commitOwnSendEcho with 0 matching webhooks.
    const echo0 = incomingMsg({
      id: 'WA-ECHO-ZERO-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'no webhooks',
    });
    projector.handleOwnSendEcho(sessionId, engine, echo0);
    await waitFor(() => eventsGateway.emitMessageSent.mock.calls.length === 1);
    await flush();
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    // (b) commitOwnSendEcho on a pre-existing REST-persisted row.
    await seedWebhook(['message.sent', 'message.received']);
    await ds.getRepository(Message).insert({
      sessionId,
      waMessageId: 'WA-REST-ONCE-1',
      chatId: '628111@c.us',
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'api send',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 1_700_000_000,
    });
    prepareSpy.mockClear();
    projector.handleOwnSendEcho(
      sessionId,
      engine,
      incomingMsg({ id: 'WA-REST-ONCE-1', fromMe: true, from: '628222@c.us', to: '628111@c.us', body: 'api send' }),
    );
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    // (c) prepareTransactionalDeliveries with a message already edited before prepare starts.
    prepareSpy.mockClear();
    mockFetch.mockClear();
    const preEdited = incomingMsg({
      id: 'WA-PREEDITED-1',
      body: 'edited before prepare',
      originalBody: 'original before prepare',
    });
    const receipt = projector.handleInboundMessage(sessionId, engine, preEdited);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves committed outbox rows with updated or redacted payload when webhook lookup fails during reconcilePrepared', async () => {
    const webhook = await seedWebhook(['message.received']);
    const webhookRepo = ds.getRepository(Webhook);
    const realFind = webhookRepo.find.bind(webhookRepo);
    let failWebhookLookup = false;
    jest.spyOn(webhookRepo, 'find').mockImplementation((...args) => {
      if (failWebhookLookup) return Promise.reject(new Error('transient webhook lookup failure'));
      return realFind(...args);
    });

    // (a) Mid-flight edit (v1 -> v2) when reconcilePrepared hits a webhook lookup DB error.
    // Pause dispatchPrepared so we can inspect the committed pending outbox row AND the payload passed to dispatch.
    const dispatchedEdit: Array<Record<string, unknown>> = [];
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(items => {
      for (const item of items) dispatchedEdit.push(item.baseData);
      return Promise.resolve();
    });

    const editMsg = incomingMsg({ id: 'WA-RECONCILE-ERR-EDIT', body: 'version one' });
    const realTx = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      const res = await realTx(...args);
      failWebhookLookup = true;
      projector.applyMessageEditQueued(sessionId, {
        messageId: editMsg.id,
        chatId: editMsg.chatId,
        body: 'version two',
        fromMe: false,
      } as never);
      return res;
    });

    const editReceipt = projector.handleInboundMessage(sessionId, engine, editMsg);
    await editReceipt?.settled;
    await flush();
    failWebhookLookup = false;

    const editRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${editMsg.id}_${webhook.id}` },
    });
    expect(editRow?.state).toBe('pending');
    expect(editRow?.payload).toMatchObject({ id: editMsg.id, body: 'version two', edited: true });
    expect(dispatchedEdit).toHaveLength(1);
    expect(dispatchedEdit[0]).toMatchObject({ id: editMsg.id, body: 'version two', edited: true });

    // (b) Mid-flight REST revoke (announced=false) when reconcilePrepared hits a webhook lookup DB error.
    const dispatchedRevoke: Array<Record<string, unknown>> = [];
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(items => {
      for (const item of items) dispatchedRevoke.push(item.baseData);
      return Promise.resolve();
    });

    const revokeMsg = incomingMsg({ id: 'WA-RECONCILE-ERR-REV', body: 'top secret' });
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      const res = await realTx(...args);
      failWebhookLookup = true;
      void projector.recordRevoke(sessionId, revokeMsg.id, undefined, false);
      return res;
    });

    const revokeReceipt = projector.handleInboundMessage(sessionId, engine, revokeMsg);
    await revokeReceipt?.settled;
    await flush();
    failWebhookLookup = false;

    const revokeRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${revokeMsg.id}_${webhook.id}` },
    });
    expect(revokeRow?.state).toBe('pending');
    expect(revokeRow?.payload).toMatchObject({ id: revokeMsg.id, body: '', type: 'revoked' });
    expect(dispatchedRevoke).toHaveLength(1);
    expect(dispatchedRevoke[0]).toMatchObject({ id: revokeMsg.id, body: '', type: 'revoked' });
  });

  it('dispatches live webhook immediately on retriedDup after post-commit transient error (inbound and own-send echo)', async () => {
    const webhook = await seedWebhook(['message.received', 'message.sent']);
    const realTransaction = ds.transaction.bind(ds);

    // (a) Inbound message: attempt 1 commits message + outbox then throws transient post-commit error;
    //     attempt 2 sees dup (retried: true) and must STILL dispatch live immediately.
    const inbound = incomingMsg({ id: 'WA-RETRY-DUP-LIVE-IN', body: 'inbound after post-commit drop' });
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, inbound);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, inInit] = mockFetch.mock.calls[0] as [string, { body: string }];
    const inParsed = JSON.parse(inInit.body) as { event: string; data: Record<string, unknown> };
    expect(inParsed.event).toBe('message.received');
    expect(inParsed.data).toMatchObject({ id: inbound.id, body: 'inbound after post-commit drop' });
    const inRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${inbound.id}_${webhook.id}` },
    });
    expect(inRow?.state).toBe('dispatched');

    // (b) Own-send echo: attempt 1 commits message + outbox then throws transient post-commit error;
    //     attempt 2 sees dup (retried: true) and must STILL dispatch message.sent live immediately.
    mockFetch.mockClear();
    const echo = incomingMsg({
      id: 'WA-RETRY-DUP-LIVE-OUT',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'outbound after post-commit drop',
    });
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, outInit] = mockFetch.mock.calls[0] as [string, { body: string }];
    const outParsed = JSON.parse(outInit.body) as { event: string; data: Record<string, unknown> };
    expect(outParsed.event).toBe('message.sent');
    expect(outParsed.data).toMatchObject({ id: echo.id, body: 'outbound after post-commit drop' });
    const outRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${echo.id}_${webhook.id}` },
    });
    expect(outRow?.state).toBe('dispatched');
  });

  it('ignores cross-chat spoofed revokes against another chat pending outbox row when messages row is absent', async () => {
    const webhook = await seedWebhook(['message.received']);
    // Seed a pending outbox row belonging to Chat A with NO row in `messages` (e.g. fail-open or ephemeral).
    const chatAPayload = {
      id: 'WA-SPOOF-REV-1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628222@c.us',
      fromMe: false,
      body: 'chat A private message',
      type: 'text',
      timestamp: 1_700_000_000,
    };
    await outbox.openBatch([
      {
        webhookId: webhook.id,
        sessionId,
        event: 'message.received',
        idempotencyKey: `msg_${sessionId}_WA-SPOOF-REV-1_${webhook.id}`,
        deliveryId: 'dlv-chat-a',
        payload: chatAPayload,
      },
    ]);

    // 1. Spoofed engine revoke (announced=true) from Chat B targeting Chat A's waMessageId.
    projector.handleMessageRevoked(
      sessionId,
      engine,
      {
        id: 'WA-SPOOF-REV-1',
        revokedId: 'WA-SPOOF-REV-1',
        chatId: '628999@c.us',
        from: '628999@c.us',
        timestamp: 1_700_000_005,
      } as never,
      { fromMe: false },
    );
    await flush();

    // 2. Spoofed REST/unannounced revoke (announced=false) with Chat B source.
    await projector.recordRevoke(
      sessionId,
      'WA-SPOOF-REV-1',
      { kind: 'revoke', chatId: '628999@c.us', fromMe: false },
      false,
    );
    await flush();

    // Chat A's pending outbox row MUST remain pending with original body completely untouched.
    const untouched = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-SPOOF-REV-1_${webhook.id}` },
    });
    expect(untouched?.state).toBe('pending');
    expect(untouched?.payload).toMatchObject({ chatId: '628111@c.us', body: 'chat A private message' });

    // 3. A legitimate revoke from Chat A's own sender DOES close Chat A's pending outbox row.
    await projector.recordRevoke(
      sessionId,
      'WA-SPOOF-REV-1',
      { kind: 'revoke', chatId: '628111@c.us', fromMe: false },
      true,
    );
    await flush();

    const closed = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-SPOOF-REV-1_${webhook.id}` },
    });
    expect(closed?.state).toBe('dispatched');
    expect(closed?.payload).toBeNull();
  });
});
