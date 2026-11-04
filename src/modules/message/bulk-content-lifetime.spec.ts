import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { captureSessionWrites, closeSessionWrites, SessionWriteScope } from '../../common/utils/session-write-scope';
import { HookManager } from '../../core/hooks';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session } from '../session/entities/session.entity';
import type { SessionService } from '../session/session.service';
import type { TemplateService } from '../template/template.service';
import { BulkMessageService } from './bulk-message.service';
import { MessageSendService } from './message-send.service';
import type { MessageService } from './message.service';
import { MessageBatch, BatchStatus } from './entities/message-batch.entity';
import { Message } from './entities/message.entity';
import { SendPacingService } from './send-pacing.service';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('Bulk content lifetimes', () => {
  let db: DataSource;
  let engines: EngineRegistry;
  let bulk: BulkMessageService;
  let hooks: HookManager;
  let pacing: SendPacingService;

  beforeEach(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, MessageBatch],
      synchronize: true,
    });
    await db.initialize();
    engines = new EngineRegistry();
    hooks = new HookManager();
    pacing = new SendPacingService(db.getRepository(Message), db.getRepository(Session), new ConfigService({}));
    const sender = new MessageSendService(
      db.getRepository(Message),
      { findOne: (id: string) => db.getRepository(Session).findOneByOrFail({ id }) } as unknown as SessionService,
      engines,
      hooks,
      {} as TemplateService,
      pacing,
    );
    bulk = new BulkMessageService(
      db.getRepository(MessageBatch),
      engines,
      sender as unknown as MessageService,
      hooks,
      pacing,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });

  async function removeSession(id: string): Promise<void> {
    const writes = closeSessionWrites(db, id);
    engines.delete(id);
    try {
      await writes.drain();
      await db.transaction(async manager => {
        await manager.delete(Message, { sessionId: id });
        await manager.delete(MessageBatch, { sessionId: id });
        await manager.delete(Session, { id });
      });
    } finally {
      writes.release();
    }
  }

  for (const [recreate, restoreBatch] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    it(`does not persist an old accepted item after deletion with replacement=${recreate}, restored batch=${restoreBatch}`, async () => {
      const session = await db.getRepository(Session).save({ name: 'original', config: {} });
      const id = session.id;
      const started = deferred();
      const result = deferred<MessageResult>();
      engines.set(id, {
        sendTextMessage: () => {
          started.resolve();
          return result.promise;
        },
      } as unknown as IWhatsAppEngine);
      const batch = await db.getRepository(MessageBatch).save({
        batchId: 'original-batch',
        sessionId: id,
        status: BatchStatus.PENDING,
        messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'old item' } }],
        options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
        progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
        results: [],
        currentIndex: 0,
      });
      const run = (
        bulk as unknown as { processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void> }
      ).processBatch(batch.id, false, captureSessionWrites(db, id));
      const settled = run.catch(() => undefined);
      await started.promise;
      await removeSession(id);
      if (recreate) await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
      if (restoreBatch) await db.getRepository(MessageBatch).save({ ...batch, status: BatchStatus.PROCESSING });
      result.resolve({ id: 'old-result', timestamp: 1700000000 });
      await settled;
      expect(await db.getRepository(Message).count()).toBe(0);
      expect(await db.getRepository(MessageBatch).count()).toBe(restoreBatch ? 1 : 0);
      if (restoreBatch) {
        const current = await db.getRepository(MessageBatch).findOneByOrFail({ id: batch.id });
        expect(current.status).toBe(BatchStatus.PROCESSING);
        expect(current.progress.sent).toBe(0);
        expect(current.currentIndex).toBe(0);
      }
    });
  }

  it('does not create a batch when its session is deleted during duplicate lookup', async () => {
    const session = await db.getRepository(Session).save({ name: 'original', config: {} });
    const id = session.id;
    engines.set(id, {} as IWhatsAppEngine);
    const repo = db.getRepository(MessageBatch);
    const find = repo.findOne.bind(repo);
    const started = deferred();
    const lookup = deferred();
    jest.spyOn(repo, 'findOne').mockImplementationOnce(async options => {
      const existing = await find(options);
      started.resolve();
      await lookup.promise;
      return existing;
    });
    const creating = bulk.createBatch(id, {
      messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'old item' } }],
    });
    const rejected = expect(creating).rejects.toThrow('no longer available');
    await started.promise;
    await removeSession(id);
    await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
    lookup.resolve();
    await rejected;
    expect(await repo.count()).toBe(0);
  });
  it('does not dispatch through a replacement session after a delayed sending hook', async () => {
    const session = await db.getRepository(Session).save({ name: 'original', config: {} });
    const id = session.id;
    const started = deferred();
    const gate = deferred();
    hooks.register('moderation', 'message:sending', async () => {
      started.resolve();
      await gate.promise;
      return { continue: true };
    });
    let sends = 0;
    const engine = {
      sendTextMessage: () => {
        sends++;
        return Promise.resolve({ id: 'replacement-result', timestamp: 1700000000 });
      },
    };
    engines.set(id, engine as unknown as IWhatsAppEngine);
    const batch = await db.getRepository(MessageBatch).save({
      batchId: 'original-batch',
      sessionId: id,
      status: BatchStatus.PENDING,
      messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'old item' } }],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
      results: [],
      currentIndex: 0,
    });
    const run = (
      bulk as unknown as { processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void> }
    ).processBatch(batch.id, false, captureSessionWrites(db, id));
    const settled = run.catch(() => undefined);
    await started.promise;
    await removeSession(id);
    await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
    engines.set(id, engine as unknown as IWhatsAppEngine);
    gate.resolve();
    await settled;
    expect(sends).toBe(0);
    expect(await db.getRepository(Message).count()).toBe(0);
  });

  // The engine was never asked, so the item is neither a delivery failure for plugins to hear about nor
  // a failed count on a batch that is going away with its session; a single send aborted the same way
  // fires no message:failed either.
  it.each([false, true])(
    'reports no failed item when its session is deleted during the sending hook (stopOnError=%s)',
    async stopOnError => {
      const session = await db.getRepository(Session).save({ name: 'original', config: {} });
      const id = session.id;
      const started = deferred();
      const gate = deferred();
      hooks.register('moderation', 'message:sending', async () => {
        started.resolve();
        await gate.promise;
        return { continue: true };
      });
      const failures: unknown[] = [];
      hooks.register('alerting', 'message:failed', context => {
        failures.push(context.data);
        return Promise.resolve({ continue: true });
      });
      const settle = jest.fn();
      jest.spyOn(pacing, 'assertSendAllowed').mockResolvedValue(settle);
      const send = jest.fn();
      engines.set(id, { sendTextMessage: send } as unknown as IWhatsAppEngine);
      const batch = await db.getRepository(MessageBatch).save({
        batchId: 'deleted-in-hook',
        sessionId: id,
        status: BatchStatus.PENDING,
        messages: [
          { chatId: '10000000001@c.us', type: 'text', content: { text: 'first item' } },
          { chatId: '10000000002@c.us', type: 'text', content: { text: 'second item' } },
        ],
        options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError },
        progress: { total: 2, sent: 0, failed: 0, pending: 2, cancelled: 0 },
        results: [],
        currentIndex: 0,
      });
      const run = (
        bulk as unknown as { processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void> }
      ).processBatch(batch.id, false, captureSessionWrites(db, id));
      const settled = run.catch((error: unknown) => error);
      await started.promise;
      await removeSession(id);
      gate.resolve();
      expect(await settled).toMatchObject({ status: 404 });
      expect(failures).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      // The admission still goes back: nothing registers it with the retired scope.
      expect(settle).toHaveBeenCalledTimes(1);
    },
  );

  it('still reports an item the engine refused while its session was being deleted', async () => {
    const session = await db.getRepository(Session).save({ name: 'original', config: {} });
    const id = session.id;
    const started = deferred();
    const refusal = deferred();
    const failures: unknown[] = [];
    hooks.register('alerting', 'message:failed', context => {
      failures.push(context.data);
      return Promise.resolve({ continue: true });
    });
    engines.set(id, {
      sendTextMessage: async () => {
        started.resolve();
        await refusal.promise;
        throw new Error('socket closed');
      },
    } as unknown as IWhatsAppEngine);
    const batch = await db.getRepository(MessageBatch).save({
      batchId: 'deleted-in-engine',
      sessionId: id,
      status: BatchStatus.PENDING,
      messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'asked item' } }],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
      results: [],
      currentIndex: 0,
    });
    const run = (
      bulk as unknown as { processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void> }
    ).processBatch(batch.id, false, captureSessionWrites(db, id));
    const settled = run.catch((error: unknown) => error);
    await started.promise;
    await removeSession(id);
    refusal.resolve();
    expect(await settled).toMatchObject({ status: 404 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ sessionId: id, type: 'text' });
  });

  it('drains an admitted initial batch save before deleting session content', async () => {
    const session = await db.getRepository(Session).save({ name: 'original', config: {} });
    const id = session.id;
    engines.set(id, {} as IWhatsAppEngine);
    const repo = db.getRepository(MessageBatch);
    const save = repo.save.bind(repo);
    const started = deferred();
    const saving = deferred();
    jest.spyOn(repo, 'save').mockImplementationOnce(async (value, options) => {
      started.resolve();
      await saving.promise;
      return save(value, options);
    });
    const creating = bulk.createBatch(id, {
      messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'old item' } }],
    });
    const created = creating.catch(() => undefined);
    await started.promise;
    let deleted = false;
    const deletion = removeSession(id).then(() => {
      deleted = true;
    });
    await new Promise<void>(setImmediate);
    const deletedBeforeSave = deleted;
    saving.resolve();
    await Promise.all([deletion, created]);
    await new Promise<void>(setImmediate);
    expect(deletedBeforeSave).toBe(false);
    expect(await repo.count()).toBe(0);
  });
  it('does not resume the next item through a replacement session after the batch delay', async () => {
    const session = await db.getRepository(Session).save({ name: 'original', config: {} });
    const id = session.id;
    let originalSends = 0;
    let replacementSends = 0;
    engines.set(id, {
      sendTextMessage: () => {
        originalSends++;
        return Promise.resolve({ id: 'first-result', timestamp: 1700000000 });
      },
    } as unknown as IWhatsAppEngine);
    const repo = db.getRepository(MessageBatch);
    const update = repo.update.bind(repo);
    const firstProgress = deferred();
    jest.spyOn(repo, 'update').mockImplementation(async (where, changes) => {
      const updated = await update(where, changes);
      if (changes.currentIndex === 1) firstProgress.resolve();
      return updated;
    });
    const batch = await repo.save({
      batchId: 'delayed-batch',
      sessionId: id,
      status: BatchStatus.PENDING,
      messages: [
        { chatId: '10000000001@c.us', type: 'text', content: { text: 'first item' } },
        { chatId: '10000000002@c.us', type: 'text', content: { text: 'second item' } },
      ],
      options: { delayBetweenMessages: 500, randomizeDelay: false, stopOnError: false },
      progress: { total: 2, sent: 0, failed: 0, pending: 2, cancelled: 0 },
      results: [],
      currentIndex: 0,
    });
    const run = (
      bulk as unknown as { processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void> }
    ).processBatch(batch.id, false, captureSessionWrites(db, id));
    const settled = run.catch(() => undefined);
    await firstProgress.promise;
    await new Promise<void>(setImmediate);
    await removeSession(id);
    await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
    engines.set(id, {
      sendTextMessage: () => {
        replacementSends++;
        return Promise.resolve({ id: 'second-result', timestamp: 1700000001 });
      },
    } as unknown as IWhatsAppEngine);
    await settled;
    expect(originalSends).toBe(1);
    expect(replacementSends).toBe(0);
    expect(await db.getRepository(Message).count()).toBe(0);
    expect(await repo.count()).toBe(0);
  });

  for (const stage of ['pickup read', 'processing transition']) {
    it(`does not adopt restored batch content after a pending ${stage}`, async () => {
      const session = await db.getRepository(Session).save({ name: 'original', config: {} });
      const id = session.id;
      let sends = 0;
      const engine = {
        sendTextMessage: () => {
          sends++;
          return Promise.resolve({ id: 'old-result', timestamp: 1700000000 });
        },
      };
      engines.set(id, engine as unknown as IWhatsAppEngine);
      const repo = db.getRepository(MessageBatch);
      const batch = await repo.save({
        batchId: 'pending-pickup',
        sessionId: id,
        status: BatchStatus.PENDING,
        messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'old item' } }],
        options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
        progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
        results: [],
        currentIndex: 0,
      });
      const find = repo.findOne.bind(repo);
      const started = deferred();
      const pickup = deferred();
      if (stage === 'pickup read') {
        jest.spyOn(repo, 'findOne').mockImplementationOnce(async options => {
          const value = await find(options);
          started.resolve();
          await pickup.promise;
          return value;
        });
      } else {
        const update = repo.update.bind(repo);
        jest.spyOn(repo, 'update').mockImplementationOnce(async (where, changes) => {
          const value = await update(where, changes);
          started.resolve();
          await pickup.promise;
          return value;
        });
      }
      const run = (
        bulk as unknown as { processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void> }
      ).processBatch(batch.id, false, captureSessionWrites(db, id));
      const settled = run.catch(() => undefined);
      await started.promise;
      let completedBeforeTransition = false;
      if (stage === 'processing transition') {
        let completed = false;
        const deletion = removeSession(id).then(() => {
          completed = true;
        });
        await new Promise<void>(setImmediate);
        completedBeforeTransition = completed;
        pickup.resolve();
        await deletion;
      } else await removeSession(id);
      await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
      await repo.save(batch);
      if (stage === 'pickup read') engines.set(id, engine as unknown as IWhatsAppEngine);
      pickup.resolve();
      await settled;
      expect(completedBeforeTransition).toBe(false);
      expect(sends).toBe(0);
      expect((await repo.findOneByOrFail({ id: batch.id })).status).toBe(BatchStatus.PENDING);
      expect(await db.getRepository(Message).count()).toBe(0);
    });
  }
  it('keeps the created batch lifetime through asynchronous pickup and accepted completion', async () => {
    const session = await db.getRepository(Session).save({ name: 'original', config: {} });
    const result = deferred<MessageResult>();
    const started = deferred();
    engines.set(session.id, {
      sendTextMessage: () => {
        started.resolve();
        return result.promise;
      },
    } as unknown as IWhatsAppEngine);
    const runner = bulk as unknown as {
      processBatch(id: string, reserved: boolean, lifetime: SessionWriteScope): Promise<void>;
    };
    const process = runner.processBatch.bind(bulk);
    let running!: Promise<void>;
    jest.spyOn(runner, 'processBatch').mockImplementation((...args) => {
      running = process(...args);
      return running;
    });
    const batch = await bulk.createBatch(session.id, {
      messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'current item' } }],
    });
    await started.promise;
    result.resolve({ id: 'accepted-result', timestamp: 1700000000 });
    await running;
    const stored = await db.getRepository(MessageBatch).findOneByOrFail({ id: batch.id });
    expect(stored.status).toBe(BatchStatus.COMPLETED);
    expect(stored.progress.sent).toBe(1);
    expect(await db.getRepository(Message).count()).toBe(1);
    expect((bulk as unknown as { inFlightBatches: number }).inFlightBatches).toBe(0);
    expect((bulk as unknown as { processingBatches: Map<string, boolean> }).processingBatches.size).toBe(0);
  });
});
