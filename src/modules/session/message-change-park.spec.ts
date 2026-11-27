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
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookReconcilerService } from '../webhook/webhook-reconciler.service';
import { MessageProjector, PARKED_CHANGE_MAX_AGE_MS, PARKED_VARIANTS_MAX } from './message-projector.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { RECOVERY_MAX_BYTES } from '../../common/utils/recovery-queue';
import { SessionOwnershipService } from './session-ownership.service';
import * as sharedConnection from '../../common/utils/shared-connection';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '628111@c.us';
const REFUSED = 'REFUSED text';
const LID = '999555@lid';
const OTHER_CHAT = '628999@c.us';

/**
 * A change the database refuses (its write fails, or the read that judges it does) is kept and written once the database
 * answers, judged then as it would have been: never written to a row nobody could read, never dropped for that.
 */
describe('Changes the database refused, kept until it answers (SQLite)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let reconciler: WebhookReconcilerService;
  let hookManager: HookManager;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;
  let webhookId: string;
  let owns: boolean;
  // 'on': every statement fails; 'reads': only the reads that judge a change against the row fail.
  // 'refuse': the database answers, but refuses a write of a message row that carries REFUSED, as for a bad value.
  let outage: 'off' | 'on' | 'reads' | 'refuse';
  // With 'refuse', a write of the row with this key is refused too.
  let refusedRow: string;
  const ioerr = (): Error => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- a jest spy, read for its calls
  const lost = (): jest.Mock => LoggerService.prototype.error as jest.Mock;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    outage = 'off';
    refusedRow = '\u0000';
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
        .save(ds.getRepository(Session).create({ name: 'parked', status: SessionStatus.READY, config: {} }))
    ).id;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const realQuery = BetterSqlite3QueryRunner.prototype.query;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      ...args: Parameters<BetterSqlite3QueryRunner['query']>
    ) {
      const sql = String(args[0]);
      const judging = /^\s*SELECT/i.test(sql) && sql.includes('"messages"') && sql.includes('"engineRef"');
      if (outage === 'on' || (outage === 'reads' && judging)) return Promise.reject(ioerr());
      const refused = JSON.stringify(args[1]);
      if (
        outage === 'refuse' &&
        /^\s*UPDATE "messages"/i.test(sql) &&
        (refused.includes(REFUSED) || refused.includes(refusedRow))
      ) {
        return Promise.reject(Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' }));
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
      new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
      undefined,
      undefined,
      // The chat's phone is reported with LID.
      {
        findPhoneForLid: (jid: string) => Promise.resolve(jid === LID ? '628111' : null),
        findLidsForPhone: (phone: string) => Promise.resolve(phone === '628111' ? ['999555'] : []),
      } as unknown as LidMappingStoreService,
      { owns: () => owns } as unknown as SessionOwnershipService,
    );
    webhookId = (
      await ds.getRepository(Webhook).save(
        ds.getRepository(Webhook).create({
          sessionId,
          url: 'https://receiver.example/hook',
          events: ['message.received', 'message.sent'],
          secret: null,
          headers: {},
          filters: null,
          active: true,
          retryCount: 1,
        }),
      )
    ).id;
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
  /** The database is back: the kept changes run now rather than on their timer. */
  const recover = async (): Promise<void> => {
    outage = 'off';
    await projector.retryParkedChanges();
    await settle();
  };
  const rowOf = (id: string): Promise<Message | null> =>
    ds.getRepository(Message).findOneBy({ sessionId, waMessageId: id });
  const outboxOf = async (id: string): Promise<Array<{ state: string | null; body?: unknown }>> =>
    (await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } }))
      .filter(r => r.idempotencyKey.includes(`_${id}_`))
      .map(r => ({ state: r.state, body: (r.payload as { body?: unknown } | null)?.body }));
  const sweptBodies = async (): Promise<unknown[]> => {
    await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    await settle();
    return mockFetch.mock.calls.map(
      ([, init]) => (JSON.parse((init as { body: string }).body) as { data: { body?: string } }).data.body,
    );
  };

  const changesLost = (): unknown[] =>
    lost()
      .mock.calls.map(([, , meta]) => meta as { action?: string } | undefined)
      .filter(meta => meta?.action === 'message_change_lost');
  const keptFor = (id: string): boolean =>
    (LoggerService.prototype.warn as jest.Mock).mock.calls.some(
      ([, meta]) =>
        (meta as { action?: string; messageId?: string } | undefined)?.action === 'message_change_parked' &&
        (meta as { messageId?: string }).messageId === id,
    );
  const heldOnThisNode = (id: string): boolean =>
    delivery.isMessageHeld(`msg_${sessionId}_${id}_${webhookId}`, webhookId);
  const storeRow = async (id: string, chatId = CHAT, fromMe = false): Promise<void> => {
    await ds.getRepository(Message).insert({
      sessionId,
      waMessageId: id,
      chatId,
      from: fromMe ? '628222@c.us' : chatId,
      to: fromMe ? chatId : '628222@c.us',
      body: 'first text',
      type: 'text',
      direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      timestamp: 1_700_000_000,
    });
    await outbox.open({
      webhookId,
      sessionId,
      event: fromMe ? 'message.sent' : 'message.received',
      idempotencyKey: `msg_${sessionId}_${id}_${webhookId}`,
      deliveryId: `delivery-${id}`,
      payload: { id, chatId, fromMe, type: 'text', body: 'first text' },
    });
  };
  const message = (id: string, fromMe = false): IncomingMessage =>
    ({
      id,
      chatId: CHAT,
      from: fromMe ? '628222@c.us' : CHAT,
      to: fromMe ? CHAT : '628222@c.us',
      body: 'first text',
      type: 'text',
      timestamp: 1_700_000_000,
      fromMe,
    }) as IncomingMessage;
  const hand = (msg: IncomingMessage): void => {
    if (msg.fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
    else void projector.handleInboundMessage(sessionId, engine, msg);
  };

  const changes = {
    'an engine revoke': (id: string, fromMe = false) =>
      projector.handleMessageRevoked(
        sessionId,
        engine,
        { id, revokedId: id, chatId: CHAT, timestamp: 1_700_000_001 } as never,
        { fromMe },
      ),
    'a delete through the API': (id: string) =>
      void projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT }),
    'an edit': (id: string, fromMe = false) =>
      projector.applyMessageEditQueued(sessionId, {
        messageId: id,
        chatId: CHAT,
        body: 'edited text',
        fromMe,
      } as never),
  } as const;
  type Change = keyof typeof changes;
  const changed: Record<Change, { row: Record<string, unknown>; outbox: Record<string, unknown> }> = {
    'an engine revoke': { row: { type: 'revoked', body: '' }, outbox: { state: 'dispatched', body: undefined } },
    'a delete through the API': { row: { type: 'revoked', body: '' }, outbox: { state: 'pending', body: '' } },
    'an edit': { row: { body: 'edited text' }, outbox: { state: 'pending', body: 'edited text' } },
  };
  const each = Object.keys(changes) as Change[];
  /** What a kept announcement of the message carries once the change reached it: nothing once taken back. */
  const announcedAs: Record<Change, unknown[]> = {
    'an engine revoke': [],
    'a delete through the API': [''],
    'an edit': ['edited text'],
  };

  describe.each([
    ['an inbound message', false],
    ['an own-send echo', true],
  ] as const)('%s', (_label, fromMe) => {
    // The change reaches the message as its insert waits for the shared connection, before the commit.
    const justBeforeTheCommit = (change: () => void): void => {
      const realWait = sharedConnection.awaitNoOpenTransaction;
      let waits = 0;
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(async dataSource => {
        // Only this test's database: work an earlier test left running waits on its own.
        if (dataSource === ds && ++waits === 2) {
          change();
          await settle(5);
        }
        return realWait(dataSource);
      });
    };
    /** The commit lands, then the database goes away and the transaction reports `failure`. */
    const outageAfterTheCommit = (failure: () => Error): void => {
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        await realTransaction(...args);
        outage = 'on';
        throw failure();
      });
    };

    it.each(each)('writes %s held for it once the database answers again after its commit landed', async change => {
      const msg = message(`L-${fromMe}`, fromMe);
      justBeforeTheCommit(() => changes[change](msg.id, fromMe));
      outageAfterTheCommit(ioerr);

      hand(msg);
      await settle();
      outage = 'off';
      expect(await rowOf(msg.id)).toMatchObject({ body: 'first text' });
      await recover();

      expect(await rowOf(msg.id)).toMatchObject(changed[change].row);
      // Its announcement, kept while the database was away, went out as the change left it.
      expect(await outboxOf(msg.id)).toEqual([expect.objectContaining({ state: 'dispatched' })]);
      expect(await sweptBodies()).toEqual(announcedAs[change]);
    });

    it.each(each)('writes %s held for it whose write failed after a commit that reported success', async change => {
      const msg = message(`Y-${fromMe}`, fromMe);
      justBeforeTheCommit(() => changes[change](msg.id, fromMe));
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        const result = await realTransaction(...args);
        outage = 'on';
        return result;
      });

      hand(msg);
      await settle();
      await recover();

      expect(await rowOf(msg.id)).toMatchObject(changed[change].row);
    });
  });

  describe('a change of a stored message', () => {
    it.each(each)('writes %s that reached it while the database was away, once it answers', async change => {
      await storeRow('P-1');
      outage = 'on';

      changes[change]('P-1');
      await settle();
      await recover();

      expect(await rowOf('P-1')).toMatchObject(changed[change].row);
      expect(await outboxOf('P-1')).toEqual([expect.objectContaining(changed[change].outbox)]);
      expect(await sweptBodies()).not.toContain('first text');
    });

    it.each(each)("never writes %s to another chat's row it could not read, then or once it can", async change => {
      await storeRow('DF-1', OTHER_CHAT);
      outage = 'reads';

      changes[change]('DF-1');
      await settle();
      expect(await rowOf('DF-1')).toMatchObject({ chatId: OTHER_CHAT, type: 'text', body: 'first text' });
      await recover();

      expect(await rowOf('DF-1')).toMatchObject({ chatId: OTHER_CHAT, type: 'text', body: 'first text' });
    });

    it('lets a newer edit that lands replace a kept one, and keeps a later revoke over a kept edit', async () => {
      await storeRow('O-1');
      await storeRow('O-2');
      outage = 'on';
      projector.applyMessageEditQueued(sessionId, {
        messageId: 'O-1',
        chatId: CHAT,
        body: 'first fix',
        fromMe: false,
      } as never);
      projector.applyMessageEditQueued(sessionId, {
        messageId: 'O-2',
        chatId: CHAT,
        body: 'first fix',
        fromMe: false,
      } as never);
      await settle();
      outage = 'off';
      projector.applyMessageEditQueued(sessionId, {
        messageId: 'O-1',
        chatId: CHAT,
        body: 'second fix',
        fromMe: false,
      } as never);
      changes['an engine revoke']('O-2');
      await settle();
      await recover();

      expect(await rowOf('O-1')).toMatchObject({ body: 'second fix' });
      expect(await rowOf('O-2')).toMatchObject({ type: 'revoked', body: '' });
    });

    it('keeps a revoke over an edit that comes after it, and a change of another chat neither applies nor cancels it', async () => {
      await storeRow('O-3');
      outage = 'on';
      changes['an engine revoke']('O-3');
      await settle();
      changes['an edit']('O-3');
      projector.applyMessageEditQueued(sessionId, {
        messageId: 'O-3',
        chatId: OTHER_CHAT,
        body: 'forged',
        fromMe: false,
      } as never);
      await settle();
      await recover();

      expect(await rowOf('O-3')).toMatchObject({ type: 'revoked', body: '' });
    });

    it('writes a kept revoke and drops a kept edit once this node no longer owns the session', async () => {
      await storeRow('T-1');
      await storeRow('T-2');
      outage = 'on';
      changes['an engine revoke']('T-1');
      changes['an edit']('T-2');
      await settle();
      owns = false;
      await recover();

      expect(await rowOf('T-1')).toMatchObject({ type: 'revoked' });
      expect(await rowOf('T-2')).toMatchObject({ body: 'first text' });
      expect(lost()).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ messageId: 'T-2', reason: 'ownership', action: 'message_change_lost' }),
      );
    });

    it('writes a kept change after its engine retired, and hands nothing to message:persisted', async () => {
      const persisted: unknown[] = [];
      hookManager.register('test', 'message:persisted', ctx => {
        persisted.push(ctx.data);
        return Promise.resolve({ continue: true });
      });
      await storeRow('R-1');
      outage = 'on';
      changes['a delete through the API']('R-1');
      await settle();
      engines.delete(sessionId);
      await recover();

      expect(await rowOf('R-1')).toMatchObject({ type: 'revoked' });
      expect(persisted).toEqual([]);
    });

    it('keeps the sweep off the deliveries of a message whose change is kept, and lets it replay the others', async () => {
      await storeRow('H-1');
      await storeRow('H-2');
      outage = 'on';
      changes['an edit']('H-1');
      await settle();
      // The database answers again before the kept change's next try.
      outage = 'off';

      expect(await sweptBodies()).toEqual(['first text']);
      expect(await outboxOf('H-1')).toEqual([expect.objectContaining({ state: 'pending', body: 'first text' })]);
      await recover();
      mockFetch.mockClear();

      expect(await sweptBodies()).toEqual(['edited text']);
    });

    it('holds no delivery of a message whose kept change leaves its copies as they are (a reaction)', async () => {
      await storeRow('RH-1');
      outage = 'on';
      projector.applyReactionQueued(sessionId, { messageId: 'RH-1', chatId: CHAT, senderId: CHAT, reaction: 'x' });
      await settle();
      expect(keptFor('RH-1')).toBe(true);
      outage = 'off';

      expect(heldOnThisNode('RH-1')).toBe(false);
      expect(await sweptBodies()).toEqual(['first text']);
    });

    it('lets the deliveries go once the kept change that touches them is written, though a reaction stays kept', async () => {
      await storeRow('RH-2');
      outage = 'on';
      changes['an edit']('RH-2');
      projector.applyReactionQueued(sessionId, { messageId: 'RH-2', chatId: CHAT, senderId: CHAT, reaction: 'x' });
      await settle();
      expect(heldOnThisNode('RH-2')).toBe(true);
      outage = 'off';
      // The reaction's write is refused once more: the record stays, with the reaction alone.
      const repository = ds.getRepository(Message);
      const update = repository.update.bind(repository);
      jest
        .spyOn(repository, 'update')
        .mockImplementation((where, patch) =>
          (patch as { metadata?: { reactions?: unknown } }).metadata?.reactions
            ? Promise.reject(ioerr())
            : update(where, patch),
        );
      await projector.retryParkedChanges();
      await settle();

      expect(await rowOf('RH-2')).toMatchObject({ body: 'edited text' });
      expect(heldOnThisNode('RH-2')).toBe(false);
    });

    // The budget is shared with the announcements the database refused: each edit keeps its message.edited event too,
    // kept once its webhook lookup failed, after every change was kept.
    it('gives up on the oldest kept records once their shared byte budget is spent, and logs each as lost', async () => {
      const body = 'x'.repeat(1024 * 1024);
      const count = Math.ceil(RECOVERY_MAX_BYTES / body.length) + 1;
      const ids = Array.from({ length: count }, (_, i) => `BB-${i}`);
      for (const id of ids) await storeRow(id);
      outage = 'on';
      for (const id of ids) {
        projector.applyMessageEditQueued(sessionId, { messageId: id, chatId: CHAT, body, fromMe: false } as never);
      }
      await settle(count * 4);
      await recover();

      const losses = lost()
        .mock.calls.map(([, , meta]) => meta as { reason?: string; messageId?: string; event?: string } | undefined)
        .filter(meta => meta?.reason === 'bytes');
      const lostIds = losses.filter(meta => meta?.messageId).map(meta => meta!.messageId);
      expect(lostIds.length).toBeGreaterThan(0);
      expect(lostIds).toEqual(ids.slice(0, lostIds.length));
      expect(losses.slice(lostIds.length).map(meta => meta?.event)).toEqual(
        losses.slice(lostIds.length).map(() => 'message.edited'),
      );
      expect(await rowOf(ids[0])).toMatchObject({ body: 'first text' });
    });

    it('gives up after three tries on a change the database refuses, without holding back the others', async () => {
      await storeRow('N-1');
      await storeRow('N-2');
      outage = 'on';
      changes['an edit']('N-2');
      await settle();
      outage = 'refuse';
      projector.applyMessageEditQueued(sessionId, {
        messageId: 'N-1',
        chatId: CHAT,
        body: REFUSED,
        fromMe: false,
      } as never);
      await settle();
      const pass = async (): Promise<void> => {
        await projector.retryParkedChanges();
        await settle();
      };
      const lostN1 = (): boolean =>
        lost().mock.calls.some(([, , meta]) => (meta as { messageId?: string } | undefined)?.messageId === 'N-1');

      await pass();
      expect(await rowOf('N-2')).toMatchObject({ body: 'edited text' });
      await pass();
      expect(lostN1()).toBe(false);
      await pass();

      expect(lost()).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ messageId: 'N-1', reason: 'failures', action: 'message_change_lost' }),
      );
      expect(await rowOf('N-1')).toMatchObject({ body: 'first text' });
    });

    it('keeps a revoke past the age cap of kept content, and gives up on an edit kept as long', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'], now: Date.now() });
      try {
        await storeRow('A-1');
        await storeRow('A-2');
        outage = 'on';
        changes['an engine revoke']('A-1');
        changes['an edit']('A-2');
        await settle();
        jest.setSystemTime(Date.now() + PARKED_CHANGE_MAX_AGE_MS + 1);
        await recover();

        expect(await rowOf('A-1')).toMatchObject({ type: 'revoked', body: '' });
        expect(await rowOf('A-2')).toMatchObject({ body: 'first text' });
        expect(lost()).toHaveBeenCalledWith(
          expect.any(String),
          undefined,
          expect.objectContaining({ messageId: 'A-2', reason: 'age', action: 'message_change_lost' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    describe('a revoke kept beside content', () => {
      const later = async (ms: number, run: () => Promise<void>): Promise<void> => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'], now: Date.now() });
        try {
          await run();
          jest.setSystemTime(Date.now() + ms);
          await recover();
        } finally {
          jest.useRealTimers();
        }
      };

      it('outlives the content age cap when it follows an edit of the message', async () => {
        await storeRow('A-3');
        await later(PARKED_CHANGE_MAX_AGE_MS + 1, async () => {
          outage = 'on';
          changes['an edit']('A-3');
          await settle();
          changes['an engine revoke']('A-3');
          await settle();
        });

        expect(await rowOf('A-3')).toMatchObject({ type: 'revoked', body: '' });
        const swept = await sweptBodies();
        expect(swept).not.toContain('first text');
        expect(swept).not.toContain('edited text');
      });

      it("holds the message's edit events while it is kept after an edit it superseded", async () => {
        await storeRow('A-6');
        outage = 'on';
        changes['an edit']('A-6');
        await settle();
        const hold = jest.spyOn(delivery, 'holdMessage');
        changes['an engine revoke']('A-6');
        await settle();

        // Never let go while the revoke is parked, though the edit it superseded leaves before the revoke is listed.
        const held = hold.mock.calls.filter(([, id]) => id === 'A-6').map(([, , as]) => as);
        expect(held.length).toBeGreaterThan(0);
        expect(new Set(held)).toEqual(new Set(['revoke']));
        const editEvent = { sessionId, event: 'message.edited', data: { messageId: 'A-6' } };
        expect(outbox.isMessageHeld(`edit_${sessionId}_A-6_o1_${webhookId}`, webhookId, editEvent)).toBe(true);
        await recover();
        expect(outbox.isMessageHeld(`edit_${sessionId}_A-6_o1_${webhookId}`, webhookId, editEvent)).toBe(false);
      });

      it('outlives the content age cap beside an edit of another chat, which alone is lost', async () => {
        await storeRow('A-4');
        await later(PARKED_CHANGE_MAX_AGE_MS + 1, async () => {
          outage = 'on';
          projector.applyMessageEditQueued(sessionId, {
            messageId: 'A-4',
            chatId: OTHER_CHAT,
            body: 'forged',
            fromMe: false,
          } as never);
          await settle();
          changes['an engine revoke']('A-4');
          await settle();
        });

        expect(await rowOf('A-4')).toMatchObject({ type: 'revoked', body: '' });
        expect(changesLost()).toEqual([expect.objectContaining({ messageId: 'A-4', slots: ['edit'], reason: 'age' })]);
      });

      it('outlives the byte budget when it follows an edit of the message', async () => {
        await storeRow('A-5');
        outage = 'on';
        projector.applyMessageEditQueued(sessionId, {
          messageId: 'A-5',
          chatId: CHAT,
          body: 'x'.repeat(1024 * 1024),
          fromMe: false,
        } as never);
        await settle();
        changes['an engine revoke']('A-5');
        await settle();
        const big = 'y'.repeat(1024 * 1024);
        for (let i = 0; i < 66; i++) {
          await (
            projector as unknown as { webhookService: { dispatch: (...a: unknown[]) => Promise<void> } }
          ).webhookService.dispatch(sessionId, 'group.update', { sessionId, i, big });
        }

        await recover();

        expect(await rowOf('A-5')).toMatchObject({ type: 'revoked', body: '' });
        expect(changesLost().filter(meta => (meta as { messageId?: string }).messageId === 'A-5')).toEqual([]);
      });
    });

    it("closes the delivery of a kept edit whose text its webhook's filters no longer take", async () => {
      await ds.getRepository(Webhook).update(webhookId, {
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'first' }] },
      });
      await storeRow('W-1');
      outage = 'on';
      changes['an edit']('W-1');
      await settle();
      await recover();

      expect(await rowOf('W-1')).toMatchObject({ body: 'edited text' });
      expect(await outboxOf('W-1')).toEqual([{ state: 'dispatched', body: undefined }]);
      expect(await sweptBodies()).toEqual([]);
    });

    describe('changes of one message whose claims disagree', () => {
      const GROUP = '120363000000000001@g.us';
      const AUTHOR = '628111@c.us';
      const MEMBER = '628777@c.us';
      const memberRevoke = (id: string, participant: string): void =>
        projector.handleMessageRevoked(
          sessionId,
          engine,
          { id, revokedId: id, chatId: GROUP, timestamp: 1_700_000_001 } as never,
          { fromMe: false, participant, admin: false },
        );
      const storeGroupRow = async (id: string): Promise<string> => {
        const { identifiers } = await ds.getRepository(Message).insert({
          sessionId,
          waMessageId: id,
          chatId: GROUP,
          author: AUTHOR,
          from: GROUP,
          to: '628222@c.us',
          body: 'first text',
          type: 'text',
          direction: MessageDirection.INCOMING,
          timestamp: 1_700_000_000,
        });
        await outbox.open({
          webhookId,
          sessionId,
          event: 'message.received',
          idempotencyKey: `msg_${sessionId}_${id}_${webhookId}`,
          deliveryId: `delivery-${id}`,
          payload: { id, chatId: GROUP, fromMe: false, author: AUTHOR, type: 'text', body: 'first text' },
        });
        return identifiers[0].id as string;
      };

      it.each([
        ['alone', [AUTHOR]],
        ["kept after another member's revoke of it", [MEMBER, AUTHOR]],
        ["kept before another member's revoke of it", [AUTHOR, MEMBER]],
      ])("lands the author's revoke %s, and the sweep delivers nothing of the message", async (_label, order) => {
        await storeGroupRow('G-1');
        outage = 'on';
        for (const participant of order) {
          memberRevoke('G-1', participant);
          await settle();
        }
        await recover();

        expect(await rowOf('G-1')).toMatchObject({ type: 'revoked', body: '' });
        expect(await sweptBodies()).not.toContain('first text');
        expect(changesLost()).toEqual([]);
      });

      it("keeps the message's deliveries held while one of its kept changes still waits", async () => {
        refusedRow = await storeGroupRow('G-2');
        outage = 'on';
        memberRevoke('G-2', AUTHOR);
        await settle();
        memberRevoke('G-2', MEMBER);
        await settle();
        // The author's revoke is refused once more; the member's is judged foreign and let go.
        outage = 'refuse';
        await projector.retryParkedChanges();
        await settle();

        expect(await rowOf('G-2')).toMatchObject({ type: 'text' });
        expect(heldOnThisNode('G-2')).toBe(true);
      });

      it.each([
        ['kept as well', true],
        ['written while the older one is kept', false],
      ])('lands a newer edit claimed by the lid paired with the phone of a kept one, %s', async (_label, kept) => {
        await storeRow('E-1');
        outage = 'on';
        projector.applyMessageEditQueued(sessionId, {
          messageId: 'E-1',
          chatId: CHAT,
          body: 'first fix',
          fromMe: false,
        } as never);
        await settle();
        if (!kept) outage = 'off';
        projector.applyMessageEditQueued(sessionId, {
          messageId: 'E-1',
          chatId: LID,
          body: 'second fix',
          fromMe: false,
        } as never);
        await settle();
        await recover();

        expect(await rowOf('E-1')).toMatchObject({ body: 'second fix' });
      });

      it('gives up on the oldest of too many kept changes of one kind whose claims disagree, and logs it as lost', async () => {
        await storeGroupRow('G-3');
        outage = 'on';
        const members = Array.from({ length: PARKED_VARIANTS_MAX + 1 }, (_, i) => `62877700${i}@c.us`);
        for (const participant of members) {
          memberRevoke('G-3', participant);
          await settle();
        }

        expect(changesLost()).toHaveLength(1);
        expect(lost()).toHaveBeenCalledWith(
          expect.any(String),
          undefined,
          expect.objectContaining({
            messageId: 'G-3',
            slots: ['revoke'],
            reason: 'conflict',
            action: 'message_change_lost',
          }),
        );
      });
    });

    it('drops what a removed session kept', async () => {
      await storeRow('F-1');
      outage = 'on';
      changes['an edit']('F-1');
      await settle();
      expect(heldOnThisNode('F-1')).toBe(true);
      projector.forgetSession(sessionId);
      await recover();

      expect(await rowOf('F-1')).toMatchObject({ body: 'first text' });
      expect(heldOnThisNode('F-1')).toBe(false);
    });

    it('stores in its pass at shutdown a received message whose row was kept', async () => {
      outage = 'on';
      hand(message('S-3'));
      await settle(200);
      outage = 'off';

      await projector.settleParkedChanges(1000);

      expect(await rowOf('S-3')).toMatchObject({ body: 'first text' });
    });

    it('makes one pass at shutdown, and logs as lost what the database still refuses', async () => {
      await storeRow('S-1');
      await storeRow('S-2');
      outage = 'on';
      changes['an edit']('S-1');
      await settle();
      outage = 'off';
      await projector.settleParkedChanges(1000);
      expect(await rowOf('S-1')).toMatchObject({ body: 'edited text' });

      outage = 'on';
      changes['an edit']('S-2');
      await settle();
      await projector.settleParkedChanges(1000);
      expect(lost()).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ messageId: 'S-2', reason: 'shutdown', action: 'message_change_lost' }),
      );
      expect(heldOnThisNode('S-2')).toBe(false);
    });
  });

  describe('an ack the database refused', () => {
    // The change records the queue keeps for a message, under its key and the index of its claim.
    const keptChangesOf = (id: string) =>
      [...projector.recoveryQueue().records('change')].filter(record =>
        ((record as { key?: string }).key ?? '').startsWith(`${sessionId}:${id}#`),
      );
    const statusOf = async (id: string): Promise<string | undefined> => (await rowOf(id))?.status;

    it.each([
      ['naming no chat', undefined],
      ['naming its chat', CHAT],
    ] as const)('is kept and advances the row once the database answers (%s)', async (_l, chatId) => {
      await storeRow('K-1', CHAT, true);
      outage = 'on';
      projector.handleMessageAck(sessionId, engine, 'K-1', 'read', chatId);
      await settle();
      outage = 'off';

      await recover();

      expect(await statusOf('K-1')).toBe('read');
    });

    it('lets go on the first pass once the database answers of an ack whose message has no row, holding nothing', async () => {
      outage = 'on';
      projector.handleMessageAck(sessionId, engine, 'K-3', 'read', CHAT);
      await settle();
      expect(keptChangesOf('K-3')).toHaveLength(1);
      outage = 'off';

      await recover();

      expect(keptChangesOf('K-3')).toEqual([]);
    });

    it.each([
      ['its write', 'update', undefined],
      ['the read that judges it', 'findOne', CHAT],
    ] as const)('keeps nothing of an ack when %s fails for a reason of its own', async (_l, method, chatId) => {
      await storeRow('K-6', CHAT, true);
      jest
        .spyOn(ds.getRepository(Message), method)
        .mockRejectedValueOnce(
          Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' }),
        );
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        projector.handleMessageAck(sessionId, engine, 'K-6', 'read', chatId);
        await settle();
        // The retry a moment later, which a row read as absent gets, runs before the test ends.
        await jest.advanceTimersByTimeAsync(1000);
        await settle();
      } finally {
        jest.useRealTimers();
      }

      // Never kept, rather than kept and settled by a pass meanwhile.
      expect(keptFor('K-6')).toBe(false);
    });

    it('sends its receipt once, at once, though its status is kept', async () => {
      await storeRow('K-4', CHAT, true);
      const dispatch = jest.spyOn(WebhookService.prototype, 'dispatch');
      const acks = (): number => dispatch.mock.calls.filter(([, event]) => event === 'message.ack').length;
      outage = 'on';
      projector.handleMessageAck(sessionId, engine, 'K-4', 'read', CHAT);
      await settle();
      expect(acks()).toBe(1);
      outage = 'off';

      await recover();
      await recover();

      expect(acks()).toBe(1);
    });

    it('is kept, as a change of its message whose lane it never fills ahead of a revoke, an ack alone', async () => {
      outage = 'on';
      projector.handleMessageAck(sessionId, engine, 'K-5', 'read');
      await settle();

      expect(keptChangesOf('K-5').map(record => record.expendable?.())).toEqual([true]);
    });

    it('is kept when its retry, a moment after a first try that found no row, meets the database away', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        projector.handleMessageAck(sessionId, engine, 'K-2', 'read');
        await settle();
        await storeRow('K-2', CHAT, true);
        outage = 'on';
        await jest.advanceTimersByTimeAsync(1000);
        await settle();
        outage = 'off';

        await recover();

        expect(await statusOf('K-2')).toBe('read');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('retries a kept change on its own timer, backing off while the database stays away', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      await storeRow('B-1');
      outage = 'on';
      changes['an edit']('B-1');
      await settle();
      await jest.advanceTimersByTimeAsync(1000);
      await settle();
      outage = 'off';
      await jest.advanceTimersByTimeAsync(2000);
      await settle();

      expect(await rowOf('B-1')).toMatchObject({ body: 'edited text' });
    } finally {
      jest.useRealTimers();
    }
  });
});
