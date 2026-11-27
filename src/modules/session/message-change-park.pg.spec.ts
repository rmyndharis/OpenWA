jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
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
import * as sharedConnection from '../../common/utils/shared-connection';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import { postgresUtcExtra } from '../../database/postgres-utc';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;
const CHAT = '628111@c.us';

/**
 * PostgreSQL: a connection that drops right after a commit (reported as a transient error, so the retry and the row
 * alone fail too), and a judging read that fails over a row of another chat. Messages are admitted on arrival, as the
 * PostgreSQL wiring does.
 */
describePostgres('Changes the database refused, kept until it answers (PostgreSQL)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  const options = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let admin: DataSource;
  let ds: DataSource;
  let schema: string;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let reconciler: WebhookReconcilerService;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;
  // 'on': every statement fails; 'reads': only the reads that judge a change against the row fail.
  let outage: 'off' | 'on' | 'reads';
  let hookManager: HookManager;
  let gateway: Record<string, jest.Mock>;

  beforeAll(async () => {
    admin = await new DataSource(options).initialize();
  });
  afterAll(async () => {
    await admin.destroy();
  });

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    outage = 'off';
    schema = `park_${process.pid}_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource({
      ...options,
      schema,
      extra: { ...postgresUtcExtra(), options: `-c search_path=${schema},public`, max: 3 },
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    sessionId = (
      await ds
        .getRepository(Session)
        .save(ds.getRepository(Session).create({ name: 'pg', status: SessionStatus.READY, config: {} }))
    ).id;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const realQuery = PostgresQueryRunner.prototype.query;
    jest.spyOn(PostgresQueryRunner.prototype, 'query').mockImplementation(function (
      this: PostgresQueryRunner,
      ...args: Parameters<PostgresQueryRunner['query']>
    ) {
      const sql = String(args[0]);
      const judging = /^\s*SELECT/i.test(sql) && sql.includes('"messages"') && sql.includes('"engineRef"');
      if (outage === 'on' || (outage === 'reads' && judging)) {
        return Promise.reject(new Error('Connection terminated unexpectedly'));
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
    const webhookService = new WebhookService(
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
      new Proxy((gateway = {}), {
        get: (calls: Record<string, jest.Mock>, name: string): jest.Mock => (calls[name] ??= jest.fn()),
      }) as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
    );
    await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events: ['message.received'],
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
    jest.restoreAllMocks();
    await ds.destroy();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  });

  const waitFor = async (until: () => boolean): Promise<void> => {
    for (const deadline = Date.now() + 10_000; !until();) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  /** Changes of `id` were kept; with `afterCommit`, after its commit gave up (the changes it held, not a direct one). */
  const parked = (id: string, afterCommit = false): boolean => {
    const { warn, error } = LoggerService.prototype as unknown as Record<'warn' | 'error', jest.Mock>;
    const gaveUp = error.mock.calls.findIndex(([text]) =>
      String(text).startsWith(`Failed to save incoming message ${id} `),
    );
    const after = afterCommit ? (gaveUp < 0 ? Infinity : error.mock.invocationCallOrder[gaveUp]) : 0;
    return warn.mock.calls.some(
      ([, meta], i) =>
        (meta as { action?: string; messageId?: string } | undefined)?.action === 'message_change_parked' &&
        (meta as { messageId?: string }).messageId === id &&
        warn.mock.invocationCallOrder[i] > after,
    );
  };
  const settle = async (turns = 80): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
  };
  const rowOf = (id: string): Promise<Message | null> =>
    ds.getRepository(Message).findOneBy({ sessionId, waMessageId: id });
  const recover = async (): Promise<void> => {
    outage = 'off';
    await projector.retryParkedChanges();
    await settle();
  };
  const changes = {
    'an engine revoke': (id: string) =>
      projector.handleMessageRevoked(
        sessionId,
        engine,
        { id, revokedId: id, chatId: CHAT, timestamp: 1_700_000_001 } as never,
        { fromMe: false },
      ),
    'a delete through the API': (id: string) =>
      void projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT }),
    'an edit': (id: string) =>
      projector.applyMessageEditQueued(sessionId, {
        messageId: id,
        chatId: CHAT,
        body: 'edited text',
        fromMe: false,
      } as never),
  } as const;
  type Change = keyof typeof changes;
  const changed: Record<Change, Record<string, unknown>> = {
    'an engine revoke': { type: 'revoked', body: '' },
    'a delete through the API': { type: 'revoked', body: '' },
    'an edit': { body: 'edited text' },
  };

  it.each(Object.keys(changes) as Change[])(
    'writes %s held for a message whose connection dropped after its commit, once the database answers',
    async change => {
      const msg = {
        id: `L-${change.length}`,
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        timestamp: 1_700_000_000,
        fromMe: false,
      } as IncomingMessage;
      const realWait = sharedConnection.awaitNoOpenTransaction;
      let waits = 0;
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(async dataSource => {
        // Only this test's database: work an earlier test left running waits on its own.
        if (dataSource === ds && ++waits === 2) {
          changes[change](msg.id);
          // The change's own write runs while the database still answers: what is kept is the change held for the commit.
          const chains = (projector as unknown as { messageMutations: { size: number } }).messageMutations;
          await waitFor(() => chains.size === 0);
        }
        return realWait(dataSource);
      });
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        await realTransaction(...args);
        outage = 'on';
        throw new Error('Connection terminated unexpectedly');
      });
      const ticket = projector.admitInbound(sessionId, engine, {
        id: msg.id,
        chatId: CHAT,
        needsRoom: false,
        status: false,
        fromMe: false,
      });

      void projector.handleInboundMessage(sessionId, engine, msg, ticket);
      await waitFor(() => parked(msg.id, true));
      await recover();

      expect(await rowOf(msg.id)).toMatchObject(changed[change]);
      await reconciler.sweep(
        { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
        new Date(Date.now() + 1000),
      );
      await settle();
      const swept = mockFetch.mock.calls.map(
        ([, init]) => (JSON.parse((init as { body: string }).body) as { data: { body?: string } }).data.body,
      );
      expect(swept).not.toContain('first text');
    },
  );

  it.each(Object.keys(changes) as Change[])(
    "never writes %s to another chat's row it could not read, then or once it can",
    async change => {
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: 'DF-1',
        chatId: '628999@c.us',
        from: '628999@c.us',
        to: '628222@c.us',
        body: 'another chat keeps this',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      outage = 'reads';

      changes[change]('DF-1');
      await waitFor(() => parked('DF-1'));
      await recover();

      expect(await rowOf('DF-1')).toMatchObject({ type: 'text', body: 'another chat keeps this' });
    },
  );

  it.each(Object.keys(changes) as Change[])(
    'writes %s held for a message whose first attempt lost to a row a history sync stored meanwhile',
    async change => {
      const msg = {
        id: `FD-${change.length}`,
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        timestamp: 1_700_000_000,
        fromMe: false,
      } as IncomingMessage;
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      let reached = false;
      hookManager.register('gate', 'message:received', async () => {
        reached = true;
        await gate;
        return { continue: true };
      });
      const internals = projector as unknown as {
        messageMutations: { size: number };
        inboundInFlight: Map<string, { revoked?: boolean; editedBody?: string }>;
      };
      const ticket = projector.admitInbound(sessionId, engine, {
        id: msg.id,
        chatId: CHAT,
        needsRoom: false,
        status: false,
        fromMe: false,
      });

      projector.handleInboundMessage(sessionId, engine, msg, ticket);
      await waitFor(() => reached);
      changes[change](msg.id);
      // The change found no row and is held for the message (an engine revoke writes once it is announced).
      await waitFor(
        () =>
          internals.messageMutations.size === 0 &&
          (change !== 'an engine revoke' || (gateway.emitMessageRevoked?.mock.calls.length ?? 0) > 0) &&
          [...internals.inboundInFlight.values()].some(e => e.revoked === true || e.editedBody !== undefined),
      );
      await projector.persistHistoryMessages(sessionId, engine, [{ ...msg }]);
      release();
      await waitFor(() => internals.inboundInFlight.size === 0 && internals.messageMutations.size === 0);

      expect(await rowOf(msg.id)).toMatchObject(changed[change]);
    },
  );
});
