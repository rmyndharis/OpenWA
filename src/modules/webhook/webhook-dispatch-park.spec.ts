jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookService } from './webhook.service';
import { WebhookReconcilerService } from './webhook-reconciler.service';
import { MessageProjector } from '../session/message-projector.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from '../session/session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '628111@c.us';

/** Webhook events dispatched while the database cannot answer: kept, and dispatched once it does. */
describe('Webhook events the database refused, kept until it answers (SQLite)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let webhookService: WebhookService;
  let reconciler: WebhookReconcilerService;
  let hookManager: HookManager;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;
  let webhook: Webhook;
  let owns: boolean;
  // 'on': every statement fails; 'writes': the database reads but refuses every write.
  let outage: 'off' | 'on' | 'writes';

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    outage = 'off';
    owns = true;
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    sessionId = (
      await ds
        .getRepository(Session)
        .save(ds.getRepository(Session).create({ name: 'park', status: SessionStatus.READY, config: {} }))
    ).id;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const realQuery = BetterSqlite3QueryRunner.prototype.query;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      ...args: Parameters<BetterSqlite3QueryRunner['query']>
    ) {
      const write = !/^\s*SELECT/i.test(String(args[0]));
      if (outage === 'on' || (outage === 'writes' && write)) {
        return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
      }
      return realQuery.apply(this, args);
    } as never);
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
          'webhook.mediaInlineMaxBytes': 1024,
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
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);
    projector = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
      undefined,
      undefined,
      undefined,
      { owns: () => owns } as unknown as SessionOwnershipService,
    );
    webhook = await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events: ['*', 'message.receipt'],
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 1,
      }),
    );
  });

  afterEach(async () => {
    outage = 'off';
    await delivery.onModuleDestroy();
    await reconciler.onModuleDestroy();
    await outbox.onModuleDestroy();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  const settle = async (turns = 60): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
  };
  /** The database answers again: what was kept runs now rather than on its timer. */
  const recover = async (): Promise<void> => {
    outage = 'off';
    await projector.retryParkedChanges();
    await settle();
  };
  const posted = (): Array<{ event: string; key: string; data: Record<string, unknown> }> =>
    mockFetch.mock.calls.map(([, init]) => {
      const { body, headers } = init as { body: string; headers: Record<string, string> };
      const parsed = JSON.parse(body) as { event: string; data: Record<string, unknown> };
      return { event: parsed.event, key: headers['X-OpenWA-Idempotency-Key'], data: parsed.data };
    });
  const dropped = (): Array<{ event?: string; reason?: string }> =>
    [
      ...((LoggerService.prototype.warn as jest.Mock).mock.calls as unknown[][]),
      ...((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][]),
    ]
      .map(call => call.find(arg => (arg as { action?: string } | undefined)?.action === 'webhook_dispatch_dropped'))
      .filter(Boolean) as Array<{ event?: string; reason?: string }>;

  const EVENTS = [
    'message.received',
    'message.sent',
    'message.ack',
    'message.receipt',
    'message.failed',
    'message.revoked',
    'message.reaction',
    'message.edited',
    'status.received',
    'session.status',
    'session.qr',
    'session.authenticated',
    'session.disconnected',
    'session.reconnect_loop',
    'session.restriction',
    'presence.update',
    'event.response',
    'poll.vote',
    'group.join',
    'group.leave',
    'group.update',
    'group.join_request',
    'call.received',
    'call.accepted',
    'call.rejected',
    'call.missed',
  ];
  const NOT_KEPT = ['message.receipt', 'presence.update', 'session.qr'];
  const dataFor = (event: string): Record<string, unknown> => ({
    sessionId,
    id: 'WA-X-1',
    messageId: 'WA-X-1',
    chatId: CHAT,
    from: CHAT,
    to: '628222@c.us',
    fromMe: false,
    body: event,
    type: 'text',
    status: 'read',
    participant: '628333@c.us',
    callId: 'CALL-1',
    groupId: '1203@g.us',
    participantIds: ['628333@c.us'],
    timestamp: 1_700_000_000,
  });

  it('keeps every event but three while the database is away, and dispatches each once when it answers', async () => {
    outage = 'on';
    for (const event of EVENTS) await webhookService.dispatch(sessionId, event, dataFor(event));
    expect(mockFetch).not.toHaveBeenCalled();

    await recover();

    const kept = EVENTS.filter(event => !NOT_KEPT.includes(event));
    expect(posted().map(post => post.event)).toEqual(kept);
    // Each with its key, as its outbox row holds it (events with the same key share one row).
    const rows = await ds.getRepository(WebhookOutboxEvent).find();
    const postedKeys = [...new Set(posted().map(post => post.key))].sort();
    expect(postedKeys).toEqual(rows.map(row => row.idempotencyKey).sort());
    expect(
      dropped()
        .map(log => log.event)
        .sort(),
    ).toEqual([...NOT_KEPT].sort());
  });

  it("keeps a session's events in order, a new one after those kept before it", async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'a' });
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'b' });
    outage = 'off';
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'c' });
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();

    await recover();

    expect(posted().map(post => post.data.status)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the key of an event whose dispatch is tried again', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'message.edited', { sessionId, messageId: 'M-1', body: 'x' });
    const opened = jest.spyOn(outbox, 'openBatch');
    // The webhooks can be read again, but no outbox row can be written yet.
    outage = 'writes';
    await projector.retryParkedChanges();
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();

    await recover();

    const keys = opened.mock.calls.map(([rows]) => rows[0].idempotencyKey);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
    expect(posted().map(post => post.key)).toEqual([keys[0]]);
  });

  it('still delivers live an event whose outbox row was written before the database went away', async () => {
    const opened = jest.spyOn(outbox, 'openBatch');
    opened.mockImplementationOnce(async rows => {
      const written = await outbox.open(rows[0]).then(() => null);
      outage = 'on';
      return written;
    });

    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    await settle();

    expect(posted().map(post => post.event)).toEqual(['group.join']);
    outage = 'off';
    await recover();
    expect(posted()).toHaveLength(1);
  });

  it('keeps an event that left no durable copy: no outbox row, a receiver down, no failure row', async () => {
    outage = 'writes';
    mockFetch.mockResolvedValue(new Response('down', { status: 500 }));
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    await settle(200);
    expect(posted()).toHaveLength(1);

    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    await recover();

    expect(posted().map(post => post.event)).toEqual(['group.join', 'group.join']);
    expect(new Set(posted().map(post => post.key)).size).toBe(1);
  });

  it('keeps a message.revoked past the byte budget and the age cap, as a kept revoke is', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'], now: Date.now() });
    try {
      outage = 'on';
      await webhookService.dispatch(sessionId, 'message.revoked', dataFor('message.revoked'));
      const big = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 66; i++) await webhookService.dispatch(sessionId, 'group.update', { sessionId, i, big });
      expect(dropped().filter(log => log.reason === 'bytes').length).toBeGreaterThan(0);
      jest.setSystemTime(Date.now() + 61 * 60 * 1000);

      await recover();

      expect(posted().map(post => post.event)).toEqual(['message.revoked']);
      expect(dropped().filter(log => log.event === 'message.revoked')).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the inline media of an event out of what it holds', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'message.received', {
      ...dataFor('message.received'),
      media: { mimetype: 'image/png', data: 'x'.repeat(64 * 1024) },
    });

    await recover();

    expect(posted()).toHaveLength(1);
    expect(JSON.stringify(posted()[0].data).length).toBeLessThan(8 * 1024);
  });

  it('dispatches what is kept at shutdown once the database answers, and logs what it still refuses', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    outage = 'off';
    await delivery.onModuleDestroy();
    expect(await ds.getRepository(WebhookOutboxEvent).count()).toBe(1);
  });

  it('logs what the database still refuses at shutdown as lost', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    await delivery.onModuleDestroy();

    expect(dropped()).toEqual([expect.objectContaining({ event: 'group.join', reason: 'shutdown' })]);
  });

  it('drops a state event of a session this node no longer owns, and dispatches the rest', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'READY' });
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    owns = false;

    await recover();

    expect(posted().map(post => post.event)).toEqual(['group.join']);
    expect(dropped()).toEqual([expect.objectContaining({ event: 'session.status', reason: 'ownership' })]);
  });

  describe('an own send the gateway does not store, while the database is away', () => {
    const FILED = '628444@c.us';
    const send = {
      id: 'M-9',
      chatId: CHAT,
      from: '628222@c.us',
      to: CHAT,
      fromMe: true,
      type: 'text',
      body: 'first text',
      timestamp: 1_700_000_000,
      ephemeralDuration: 86_400,
    } as unknown as IncomingMessage;
    let previous: string | undefined;
    beforeEach(() => {
      previous = process.env.STORE_EPHEMERAL_MESSAGES;
      process.env.STORE_EPHEMERAL_MESSAGES = 'false';
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.STORE_EPHEMERAL_MESSAGES;
      else process.env.STORE_EPHEMERAL_MESSAGES = previous;
    });
    const echoWhileDown = async (): Promise<void> => {
      outage = 'on';
      projector.handleOwnSendEcho(sessionId, engine, send);
      await settle();
    };
    const sent = (): Array<Record<string, unknown>> =>
      posted()
        .filter(post => post.event === 'message.sent')
        .map(post => post.data);

    it("keeps the engine's chat of a message a handler filed elsewhere, and runs the filters when it is dispatched", async () => {
      hookManager.register('mover', 'message:sent', (ctx: { data: unknown }) =>
        Promise.resolve({
          continue: true,
          data: { ...(ctx.data as Record<string, unknown>), chatId: FILED, to: FILED },
        }),
      );
      await echoWhileDown();

      await recover();

      expect(sent()).toEqual([expect.objectContaining({ chatId: FILED, body: 'first text' })]);
      const row = await ds
        .getRepository(WebhookOutboxEvent)
        .findOne({ where: { event: 'message.sent' }, select: { id: true, engineRef: true } });
      expect(row?.engineRef).toMatchObject({ chatId: CHAT, direction: MessageDirection.OUTGOING });
    });

    it('dispatches nothing the filters exclude since it was kept', async () => {
      await echoWhileDown();
      outage = 'off';
      await ds.getRepository(Webhook).update(webhook.id, {
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'other' }] },
      });

      await recover();

      expect(sent()).toEqual([]);
    });

    it.each([
      [
        'an engine revoke',
        () => projector.recordRevoke(sessionId, 'M-9', { kind: 'revoke', chatId: CHAT, fromMe: true }, true),
        [],
      ],
      [
        'a delete through the API',
        () => projector.recordRevoke(sessionId, 'M-9', { kind: 'revoke', chatId: CHAT }),
        [expect.objectContaining({ type: 'revoked', body: '' })],
      ],
      [
        'an edit',
        async () => {
          projector.applyMessageEditQueued(sessionId, {
            messageId: 'M-9',
            chatId: CHAT,
            body: 'edited text',
            fromMe: true,
          } as never);
          await settle();
        },
        [expect.objectContaining({ body: 'edited text' })],
      ],
    ] as const)('dispatches the kept event as %s left it', async (_label, change, expected) => {
      await echoWhileDown();

      await change();
      await recover();

      expect(sent()).toEqual(expected);
    });

    it('dispatches nothing of an edit whose text the filters exclude', async () => {
      await ds.getRepository(Webhook).update(webhook.id, {
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'first' }] },
      });
      await echoWhileDown();

      projector.applyMessageEditQueued(sessionId, {
        messageId: 'M-9',
        chatId: CHAT,
        body: 'edited text',
        fromMe: true,
      } as never);
      await settle();
      await recover();

      expect(sent()).toEqual([]);
    });
  });

  describe('a received message whose row the database refused', () => {
    const msg = {
      id: 'R-1',
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      fromMe: false,
      type: 'text',
      body: 'first text',
      timestamp: 1_700_000_000,
    } as unknown as IncomingMessage;
    const received = (): Array<Record<string, unknown>> =>
      posted()
        .filter(post => post.event === 'message.received')
        .map(post => post.data);

    it.each([
      [
        'an engine revoke',
        () => projector.recordRevoke(sessionId, 'R-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
        [],
      ],
      [
        'a delete through the API',
        () => projector.recordRevoke(sessionId, 'R-1', { kind: 'revoke', chatId: CHAT }),
        [expect.objectContaining({ type: 'revoked', body: '' })],
      ],
      [
        'an edit',
        async () => {
          projector.applyMessageEditQueued(sessionId, {
            messageId: 'R-1',
            chatId: CHAT,
            body: 'edited text',
            fromMe: false,
          } as never);
          await settle();
        },
        [expect.objectContaining({ body: 'edited text' })],
      ],
    ] as const)('dispatches its kept announcement as %s left it', async (_label, change, expected) => {
      outage = 'on';
      void projector.handleInboundMessage(sessionId, engine, msg);
      await settle(200);

      await change();
      await recover();

      expect(received()).toEqual(expected);
    });
  });
});
