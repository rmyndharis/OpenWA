import { DataSource, Repository } from 'typeorm';
import { MessageProjector } from './message-projector.service';
import { SessionEngineControls, SessionEngineControlsHost, StopMarks } from './session-engine-controls';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine, IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { captureSessionWrites } from '../../common/utils/session-write-scope';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => (resolve = done));
  return { promise, resolve };
};
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
type Entry = 'inbound' | 'own-send' | 'history';
const entries: Entry[] = ['inbound', 'own-send', 'history'];

// The repository delays dispatch to SQLite to model an asynchronous driver operation. Projection,
// write scopes, the database rows and every child/parent deletion use their actual implementations.
describe('Message projection during session deletion', () => {
  let source: DataSource;
  let messages: Repository<Message>;
  let projector: MessageProjector;
  let controls: SessionEngineControls;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let id: string;
  let otherId: string;
  let beforeWrite: jest.Mock<Promise<void>, []>;
  let hook: jest.Mock;
  let retired: ReturnType<typeof deferred>;

  beforeEach(async () => {
    source = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        Session,
        Message,
        MessageBatch,
        SendIdempotencyKey,
        Webhook,
        WebhookOutboxEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
        Template,
        BaileysStoredMessage,
        ChatState,
        StatusUpdate,
      ],
    });
    await source.initialize();
    const sessions = source.getRepository(Session);
    id = (await sessions.save({ name: 'projected', config: {} })).id;
    otherId = (await sessions.save({ name: 'other', config: {} })).id;
    messages = source.getRepository(Message);
    await messages.insert({
      sessionId: otherId,
      waMessageId: 'other',
      chatId: '200@c.us',
      from: '200@c.us',
      to: '300@c.us',
      body: 'other payload',
    });
    beforeWrite = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const guarded: Repository<Message> = Object.create(messages) as Repository<Message>;
    guarded.insert = async entity => {
      await beforeWrite();
      return messages.insert(entity);
    };
    guarded.createQueryBuilder = (...args) => {
      const query = messages.createQueryBuilder(...args);
      const insert = query.insert.bind(query);
      query.insert = () => {
        const writing = insert();
        const execute = writing.execute.bind(writing);
        writing.execute = async () => {
          await beforeWrite();
          return execute();
        };
        return writing;
      };
      return query;
    };
    engines = new EngineRegistry();
    engine = { forceDestroy: jest.fn().mockResolvedValue(undefined) } as unknown as IWhatsAppEngine;
    engines.set(id, engine);
    retired = deferred();
    engines.onRetire(() => retired.resolve());
    hook = jest.fn((_name: string, data: unknown) => Promise.resolve({ continue: true, data }));
    const hooks = { execute: hook } as unknown as HookManager;
    projector = new MessageProjector(
      guarded,
      sessions,
      engines,
      { emitMessage: jest.fn(), emitMessageSent: jest.fn() } as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      hooks,
      {} as StatusStoreService,
      {} as SessionLidResolver,
    );
    const store = { clear: jest.fn(), attachTo: (row: Session) => row };
    controls = new SessionEngineControls({
      sessionRepository: sessions,
      engineFactory: { purgeSessionData: jest.fn().mockResolvedValue(undefined) },
      engines,
      sessionErrors: store,
      sessionRestrictions: store,
      presence: store,
      hookManager: hooks,
      logger: { log() {}, warn() {}, error() {}, debug() {} },
      dataSource: () => source,
      fences: {
        awaitPendingTeardown: async () => {},
        awaitInitialStatus: async () => {},
        teardownEngineSafely: async (
          _id: string,
          current: IWhatsAppEngine,
          destroy: (current: IWhatsAppEngine) => Promise<void>,
        ) => {
          await destroy(current);
          return true;
        },
      },
      broadcaster: store,
      cancelReconnect() {},
      stoppingSessions: new StopMarks(),
      operatorTeardowns: new Map(),
      reconnectStates: new Map(),
      stuckAuthRecoveryUsed: new Set(),
      initializingSessions: new Set(),
    } as unknown as SessionEngineControlsHost);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await source.destroy();
  });

  const write = async (entry: Entry): Promise<void> => {
    const message: IncomingMessage = {
      id: 'projected-message',
      chatId: '100@c.us',
      from: '100@c.us',
      to: '300@c.us',
      body: 'payload',
      type: 'text',
      timestamp: Math.floor(Date.now() / 1000),
      fromMe: entry === 'own-send',
    } as IncomingMessage;
    if (entry === 'history') {
      await projector.persistHistoryMessages(id, engine, [message]);
      return;
    }
    const ticket = projector.admitInbound(id, engine, {
      id: message.id,
      chatId: message.chatId,
      needsRoom: false,
      status: false,
      fromMe: message.fromMe,
    });
    if (entry === 'inbound') {
      await projector.handleInboundMessage(id, engine, message, ticket)?.settled;
      return;
    }
    projector.handleOwnSendEcho(id, engine, message, ticket);
    const queues = projector as unknown as { chatCommits: { size: number } };
    const end = Date.now() + 3000;
    while (queues.chatCommits.size) {
      if (Date.now() > end) throw new Error('Own-send commit did not settle');
      await settle();
    }
  };

  const expectDeleted = async () => {
    expect(await source.getRepository(Session).existsBy({ id })).toBe(false);
    expect(await messages.countBy({ sessionId: id })).toBe(0);
    expect(await source.getRepository(Session).existsBy({ id: otherId })).toBe(true);
    expect(await messages.countBy({ sessionId: otherId })).toBe(1);
  };

  describe.each(entries)('%s', entry => {
    it.each([false, true])('drains a pending insert before deletion, rejecting=%s', async reject => {
      const entered = deferred(),
        release = deferred();
      beforeWrite.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        if (reject) throw new Error('Insert unavailable');
      });
      const projection = write(entry).catch(error => error as Error);
      await entered.promise;
      const removing = jest.fn();
      const deletion = controls.delete(id, { onRemoving: removing });
      try {
        await retired.promise;
        await settle();
        expect(removing).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.all([projection, deletion]);
      }
      expect(removing).toHaveBeenCalledTimes(1);
      if (reject && entry === 'history') expect(await projection).toEqual(new Error('Insert unavailable'));
      await expectDeleted();
    });

    it('preserves completed persistence and lets an outer write scope drain', async () => {
      const outer = captureSessionWrites(source, id);
      try {
        await outer.write(() => write(entry));
        expect(await messages.countBy({ sessionId: id })).toBe(1);
        await controls.delete(id);
        await expectDeleted();
      } finally {
        outer.close();
      }
    });
  });

  describe.each(['inbound', 'own-send'] as const)('%s retries', entry => {
    it('drains the retry insert before deleting its row', async () => {
      const entered = deferred(),
        release = deferred();
      beforeWrite.mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
      beforeWrite.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const projection = write(entry);
      await entered.promise;
      const removing = jest.fn();
      const deletion = controls.delete(id, { onRemoving: removing });
      try {
        await retired.promise;
        await settle();
        expect(removing).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.all([projection, deletion]);
      }
      expect(beforeWrite).toHaveBeenCalledTimes(2);
      await expectDeleted();
    });

    it('does not hold deletion across retry backoff or retry a retired engine', async () => {
      const failed = deferred();
      beforeWrite.mockImplementation(() => {
        failed.resolve();
        return Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
      });
      const projection = write(entry);
      await failed.promise;
      await controls.delete(id);
      await projection;
      expect(beforeWrite).toHaveBeenCalledTimes(1);
      await expectDeleted();
    });

    it('does not hold deletion across a pending hook', async () => {
      const entered = deferred(),
        release = deferred();
      hook.mockImplementation(async (name: string, data: unknown) => {
        if (name === (entry === 'inbound' ? 'message:received' : 'message:sent')) {
          entered.resolve();
          await release.promise;
        }
        return { continue: true, data };
      });
      const projection = write(entry);
      await entered.promise;
      try {
        await controls.delete(id);
      } finally {
        release.resolve();
        await projection;
      }
      expect(beforeWrite).not.toHaveBeenCalled();
      await expectDeleted();
    });
  });
});
