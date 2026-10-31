import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import { InfraDataService } from './infra-data.service';
import type { MigrationTables } from './migration-tables.types';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message } from '../message/entities/message.entity';
import { BatchStatus, MessageBatch } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { MessageSendService } from '../message/message-send.service';
import { BulkMessageService } from '../message/bulk-message.service';
import { SendPacingService } from '../message/send-pacing.service';
import type { MessageService } from '../message/message.service';
import type { SessionService } from '../session/session.service';
import { captureSessionWrites } from '../../common/utils/session-write-scope';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => (resolve = res));
  return { promise, resolve };
};

type ImportOptions = { force?: boolean; stopOrphans?: boolean };

// The replace removes every session the archive does not hold, rows and all, in one transaction. A send or
// batch row still being written for such a session must not land after it, as it must not after a delete,
// and an import that does not commit keeps those sessions, so it must not leave their batches unfinished.
describe('import-data and the writes of the sessions it removes', () => {
  let ds: DataSource;
  let engines: EngineRegistry;
  let hooks: HookManager;
  let sender: MessageSendService;
  let bulk: BulkMessageService;
  // An archive that holds only s2, so the replace removes s1.
  let onlyS2: Partial<MigrationTables>;
  const engine = { sendTextMessage: jest.fn(), sendImageMessage: jest.fn(), sendChatState: jest.fn() };
  const sessionService = {
    getActiveSessionIds: () => ['s1', 's2'].filter(id => engines.has(id)),
    stopOrphanEngines: (ids: string[]) => {
      for (const id of ids) engines.delete(id);
      return Promise.resolve({ stopped: ids, notRunning: [], failed: [] });
    },
  };
  const cfg = { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
  const newService = (ownership?: object) =>
    new InfraDataService(cfg as never, ds, undefined, sessionService as never, undefined, ownership as never);
  const importNow = (options: ImportOptions, tables: Partial<MigrationTables> = onlyS2, ownership?: object) =>
    newService(ownership).importData({ tables, ...options });
  // A message row without its non-null columns: the restore cannot insert it and rolls everything back.
  const withBadRow = (): Partial<MigrationTables> => ({
    ...onlyS2,
    messages: [
      { id: 'mX', sessionId: 's2', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' } as never,
    ],
  });
  const current = (id: string) => {
    const scope = captureSessionWrites(ds, id);
    try {
      scope.assertCurrent();
      return true;
    } catch {
      return false;
    } finally {
      scope.close();
    }
  };
  const batchRow = (id: string) => ds.getRepository(MessageBatch).findOneByOrFail({ id });
  // Every runner this test sees: better-sqlite3 hands out one per DataSource, so prepare it once.
  const onRunner = (prepare: (runner: QueryRunner) => void) => {
    const prepared = new WeakSet<object>();
    const realCreate = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args: Parameters<typeof realCreate>) => {
      const runner = realCreate(...args);
      if (!prepared.has(runner)) {
        prepared.add(runner);
        prepare(runner);
      }
      return runner;
    });
  };

  // A bulk batch for s1 whose first item waits in its message:sending hook until released. Its second item
  // carries a media payload, so a terminal write shows whether it stripped it.
  const parkBatch = async () => {
    const entered = deferred();
    const finish = deferred();
    hooks.register('moderation', 'message:sending', async () => {
      entered.resolve();
      await finish.promise;
      return { continue: true };
    });
    const pickup = jest.spyOn(bulk as unknown as { processBatch(): Promise<void> }, 'processBatch');
    const batch = await bulk.createBatch('s1', {
      messages: [
        { chatId: 'a@c.us', type: 'text', content: { text: 'x' } },
        { chatId: 'b@c.us', type: 'image', content: { image: { base64: 'MEDIA-PAYLOAD', mimetype: 'image/png' } } },
      ],
      options: { delayBetweenMessages: 0, randomizeDelay: false },
    } as never);
    await entered.promise;
    const run = pickup.mock.results[0].value as Promise<void>;
    return {
      id: batch.id,
      finish: async () => {
        finish.resolve();
        await run.catch(() => undefined);
      },
    };
  };

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    engine.sendTextMessage.mockReset().mockResolvedValue({ id: 'sent-1', timestamp: 1 });
    engine.sendImageMessage.mockReset().mockResolvedValue({ id: 'sent-2', timestamp: 1 });
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        ChatState,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        WebhookOutboxEvent,
        IntegrationDeliveryFailure,
        StatusUpdate,
        AutomationRule,
        SendIdempotencyKey,
      ],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    for (const id of ['s1', 's2']) {
      await sessions.save(sessions.create({ id, name: `session-${id}`, status: SessionStatus.READY, config: {} }));
    }
    engines = new EngineRegistry();
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    hooks = new HookManager();
    const messages = ds.getRepository(Message);
    const config = new ConfigService({});
    const pacing = new SendPacingService(messages, sessions, config);
    sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneByOrFail({ id }) } as unknown as SessionService,
      engines,
      hooks,
      {} as never,
      pacing,
      config,
    );
    bulk = new BulkMessageService(
      ds.getRepository(MessageBatch),
      engines,
      sender as unknown as MessageService,
      hooks,
      pacing,
    );
    const dump = await newService().exportData();
    onlyS2 = { ...dump.tables, sessions: dump.tables.sessions?.filter(row => row.id === 's2') };
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it('waits for a message insert in flight before replacing the session that owns it', async () => {
    const entered = deferred();
    const finish = deferred();
    const messages = ds.getRepository(Message);
    const save = messages.save.bind(messages);
    jest.spyOn(messages, 'save').mockImplementationOnce(async message => {
      entered.resolve();
      await finish.promise;
      return save(message);
    });
    const sending = sender.sendText('s1', { chatId: 'first@c.us', text: 'hello' }).catch((error: unknown) => error);
    await entered.promise;
    let imported = false;
    const importing = importNow({ stopOrphans: true }).then(result => {
      imported = true;
      return result;
    });
    await new Promise<void>(setImmediate);
    const importedBeforeInsert = imported;
    finish.resolve();

    expect(await importing).toMatchObject({ imported: true });
    expect(importedBeforeInsert).toBe(false);
    expect(await sending).toMatchObject({ status: 404 });
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(await ds.getRepository(Message).count({ where: { sessionId: 's1' } })).toBe(0);
  });

  it('keeps the writes of a session the archive holds open throughout', async () => {
    const kept = captureSessionWrites(ds, 's2');

    await expect(importNow({ stopOrphans: true })).resolves.toMatchObject({ imported: true });

    expect(() => kept.assertCurrent()).not.toThrow();
    kept.close();
  });

  it('writes again for a removed session id once the import has committed', async () => {
    await expect(importNow({ stopOrphans: true })).resolves.toMatchObject({ imported: true });

    expect(current('s1')).toBe(true);
  });

  it('restores the batches of a removed session that the archive carries as archived', async () => {
    const batches = ds.getRepository(MessageBatch);
    await batches.save({
      batchId: 'archived',
      sessionId: 's1',
      status: BatchStatus.PENDING,
      messages: [{ chatId: 'a@c.us', type: 'text', content: { text: 'x' } }],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
      results: [],
    });
    const dump = await newService().exportData();

    await expect(
      importNow({ stopOrphans: true }, { ...dump.tables, sessions: dump.tables.sessions?.filter(r => r.id === 's2') }),
    ).resolves.toMatchObject({ imported: true });

    expect(await batches.findOneByOrFail({ batchId: 'archived' })).toMatchObject({ status: BatchStatus.PENDING });
  });

  // The removed sessions survive an import that does not commit, but a run that captured their writes before
  // the import closed them stays stopped. Their engines are gone, so the batch could not send anyway.
  describe.each<[string, () => Promise<unknown>]>([
    ['a row the restore cannot insert', () => importNow({ stopOrphans: true }, withBadRow())],
    [
      'an archive that restores no rows',
      () => {
        let opened = false;
        onRunner(runner => {
          const begin = runner.startTransaction.bind(runner);
          runner.startTransaction = (...args) => {
            opened = true;
            return begin(...args);
          };
        });
        // The pre-flight refuses an empty archive before it closes anything; this one empties once BEGIN ran.
        const tables = new Proxy(onlyS2, {
          get: (target, key): unknown => (opened ? undefined : target[key as keyof MigrationTables]),
        });
        return importNow({ stopOrphans: true }, tables);
      },
    ],
    [
      'a statement that fails',
      () => {
        onRunner(runner => {
          const query = runner.query.bind(runner);
          runner.query = ((...args: Parameters<typeof query>) =>
            args[0] === 'DELETE FROM webhooks'
              ? Promise.reject(new Error('disk I/O error'))
              : query(...args)) as typeof runner.query;
        });
        return importNow({ stopOrphans: true });
      },
    ],
    [
      'a transaction that cannot open',
      () => {
        onRunner(runner => {
          runner.startTransaction = () => Promise.reject(new Error('BEGIN failed'));
        });
        return importNow({ stopOrphans: true });
      },
    ],
    [
      'another transaction opened while the writes drained',
      () => {
        onRunner(runner => {
          let opened = false;
          const query = runner.query.bind(runner);
          runner.query = (async (...args: Parameters<typeof query>) => {
            const rows: unknown = await query(...args);
            if (!opened && /^SELECT id FROM sessions/.test(args[0])) {
              opened = true;
              // Someone else's transaction on the one connection, rolled back once the import has refused.
              await runner.startTransaction();
              setTimeout(() => void runner.rollbackTransaction(), 20);
            }
            return rows;
          }) as typeof runner.query;
        });
        return importNow({ stopOrphans: true });
      },
    ],
  ])('an import that ends without committing: %s', (_exit, run) => {
    it('fails the unfinished batch of the session it meant to remove and reopens its writes', async () => {
      const batch = await parkBatch();

      const outcome = await run().catch((error: unknown) => error);
      await batch.finish();

      expect(outcome).not.toMatchObject({ imported: true });
      const row = await batchRow(batch.id);
      expect(row.status).toBe(BatchStatus.FAILED);
      expect(JSON.stringify(row.messages)).not.toContain('MEDIA-PAYLOAD');
      expect(engine.sendTextMessage).not.toHaveBeenCalled();
      expect(await ds.getRepository(Message).count({ where: { sessionId: 's1' } })).toBe(0);
      expect(await ds.getRepository(Session).count()).toBe(2);
      expect(current('s1')).toBe(true);
    });
  });

  // On SQLite a transaction someone else opens while the import drains is open on the import's connection
  // too. Failing the batch inside it would tie the fail to that transaction's outcome.
  it.each([['rolls back'], ['commits']])(
    'fails the batch of an import refused for a transaction opened while it drained, which then %s',
    async outcome => {
      const entered = deferred();
      const finish = deferred();
      const messages = ds.getRepository(Message);
      const save = messages.save.bind(messages);
      jest.spyOn(messages, 'save').mockImplementationOnce(async message => {
        entered.resolve();
        await finish.promise;
        return save(message);
      });
      const sending = sender.sendText('s1', { chatId: 'first@c.us', text: 'hello' }).catch((error: unknown) => error);
      await entered.promise;
      const batch = await parkBatch();
      const importing = importNow({ stopOrphans: true }).catch((error: unknown) => error);
      await new Promise<void>(setImmediate);
      const outer = ds.createQueryRunner();
      await outer.connect();
      await outer.startTransaction();
      finish.resolve();
      // The drained write has landed and the import has refused by the time a timer runs.
      await new Promise(resolve => setTimeout(resolve, 20));
      await (outcome === 'commits' ? outer.commitTransaction() : outer.rollbackTransaction());

      expect(await importing).toMatchObject({ response: { code: 'IMPORT_NESTED_TRANSACTION' } });
      await batch.finish();
      await sending;
      const row = await batchRow(batch.id);
      expect(row.status).toBe(BatchStatus.FAILED);
      expect(JSON.stringify(row.messages)).not.toContain('MEDIA-PAYLOAD');
      expect(engine.sendTextMessage).not.toHaveBeenCalled();
      expect(await ds.getRepository(Session).count()).toBe(2);
      expect(current('s1')).toBe(true);
    },
  );

  describe.each<[string, () => Promise<unknown>]>([
    ['would orphan a running engine', () => importNow({})],
    [
      'finds another transaction holding the connection',
      async () => {
        const outer = ds.createQueryRunner();
        await outer.connect();
        await outer.startTransaction();
        try {
          return await importNow({ stopOrphans: true });
        } finally {
          await outer.rollbackTransaction();
        }
      },
    ],
  ])('an import refused before it starts because it %s', (_reason, run) => {
    it('leaves the writes of every session alone', async () => {
      const before = captureSessionWrites(ds, 's1');

      await expect(run()).rejects.toMatchObject({ status: 409 });

      expect(() => before.assertCurrent()).not.toThrow();
      before.close();
    });
  });

  it('leaves a removed session whose engine force keeps running writable, and its batch running', async () => {
    const batch = await parkBatch();

    const result = await importNow({ force: true }, withBadRow());
    await batch.finish();

    expect(result.imported).toBe(false);
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect((await batchRow(batch.id)).status).toBe(BatchStatus.COMPLETED);
  });

  it('leaves the writes and batches of a removed session another node holds alone', async () => {
    engines.delete('s1');
    const batches = ds.getRepository(MessageBatch);
    const running = await batches.save({
      batchId: 'elsewhere',
      sessionId: 's1',
      status: BatchStatus.PROCESSING,
      messages: [{ chatId: 'a@c.us', type: 'text', content: { text: 'x' } }],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
      results: [],
    });
    const before = captureSessionWrites(ds, 's1');
    const ownership = {
      heldByOtherNodes: () => Promise.resolve(['s1']),
      claimableWhere: () => [{}],
      suspendLossDetection: () => () => undefined,
    };

    await expect(importNow({}, withBadRow(), ownership)).resolves.toMatchObject({ imported: false });

    expect((await batchRow(running.id)).status).toBe(BatchStatus.PROCESSING);
    expect(() => before.assertCurrent()).not.toThrow();
    before.close();
  });
});
