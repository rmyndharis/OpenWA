import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { type IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager, type HookContext } from '../../core/hooks';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection } from './entities/message.entity';
import { MessageSendService } from './message-send.service';
import { SEND_PACING_LIMITED, SendPacingService } from './send-pacing.service';
import { computeSendPacingConfig } from './send-pacing.config';
import { closeSessionWrites } from '../../common/utils/session-write-scope';

const NOW = new Date('2026-06-01T12:00:00Z');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => (resolve = res));
  return { promise, resolve };
};

describe('MessageSendService preparation pacing', () => {
  let ds: DataSource;
  let messages: Repository<Message>;
  let sender: MessageSendService;
  let hooks: HookManager;
  let engines: EngineRegistry;
  let engine: Record<string, jest.Mock>;
  let pacingConfig: ReturnType<typeof computeSendPacingConfig>;
  let pacing: SendPacingService;

  const send = () => sender.sendText('s1', { chatId: 'first@c.us', text: 'hello' });
  const replaceSession = async () => {
    const deletion = closeSessionWrites(ds, 's1');
    await deletion.drain();
    engines.delete('s1');
    await ds.transaction(async manager => {
      await manager.delete(Message, { sessionId: 's1' });
      await manager.delete(Session, { id: 's1' });
    });
    deletion.release();
    await ds.getRepository(Session).save({ id: 's1', name: 'replacement', createdAt: new Date() });
    engines.set('s1', engine as unknown as IWhatsAppEngine);
  };
  const expectLimited = async () => {
    try {
      await sender.sendText('s1', { chatId: 'second@c.us', text: 'second' });
      throw new Error('Expected the send to be paced');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const response = (error as HttpException).getResponse() as { code: string; retryAfterSeconds: number };
      expect(response.code).toBe(SEND_PACING_LIMITED);
      expect(Number.isFinite(response.retryAfterSeconds)).toBe(true);
      expect(response.retryAfterSeconds).toBeGreaterThan(0);
    }
  };

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(NOW);
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    await sessions.save({ id: 's1', name: 'sender', createdAt: NOW });
    messages = ds.getRepository(Message);
    pacingConfig = { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [1], coldSchedule: [] };
    const config = { get: (key: string) => (key === 'sendPacing' ? pacingConfig : undefined) } as ConfigService;
    pacing = new SendPacingService(messages, sessions, config);
    hooks = new HookManager();
    engines = new EngineRegistry();
    engine = {};
    let sent = 0;
    for (const method of [
      'sendTextMessage',
      'sendImageMessage',
      'sendVideoMessage',
      'sendAudioMessage',
      'sendDocumentMessage',
      'sendStickerMessage',
      'sendLocationMessage',
      'sendContactMessage',
      'sendPollMessage',
      'replyToMessage',
      'clickButton',
      'forwardMessage',
    ])
      engine[method] = jest
        .fn()
        .mockImplementation(() => Promise.resolve({ id: `sent-${++sent}`, timestamp: Date.now() / 1000 }));
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneByOrFail({ id }) } as never,
      engines,
      hooks,
      {} as never,
      pacing,
      config,
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    delete process.env.SIMULATE_TYPING;
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it.each(['daily', 'cold'])('holds the %s allowance while a hook takes more than five minutes', async cap => {
    if (cap === 'cold') {
      pacingConfig.warmupSchedule = [100];
      pacingConfig.coldSchedule = [1];
    }
    const entered = deferred();
    const finish = deferred();
    let calls = 0;
    hooks.register('moderation', 'message:sending', async context => {
      if (++calls === 1) {
        entered.resolve();
        await finish.promise;
      }
      return { continue: true, data: context.data };
    });
    const pending = send();
    await entered.promise;
    expect(await messages.count()).toBe(0);
    jest.setSystemTime(NOW.getTime() + 5 * 60_000 + 1);
    try {
      await expectLimited();
      expect(calls).toBe(1);
    } finally {
      finish.resolve();
      await pending;
    }
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(await messages.count()).toBe(1);
    await expectLimited();
  });

  it.each(['reply', 'clickButton', 'save'])('holds the allowance through delayed %s preparation', async stage => {
    const entered = deferred();
    const finish = deferred();
    if (stage === 'save') {
      const save = messages.save.bind(messages);
      jest.spyOn(messages, 'save').mockImplementationOnce(async message => {
        entered.resolve();
        await finish.promise;
        return save(message);
      });
    } else {
      jest
        .spyOn(sender as unknown as { resolveQuotedBody: () => Promise<string> }, 'resolveQuotedBody')
        .mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          return 'prompt';
        });
    }
    const pending =
      stage === 'reply'
        ? sender.reply('s1', { chatId: 'first@c.us', quotedMessageId: 'prompt', text: 'reply' })
        : stage === 'clickButton'
          ? sender.clickButton('s1', { chatId: 'first@c.us', messageId: 'prompt', buttonId: 'yes' })
          : send();
    await entered.promise;
    jest.setSystemTime(NOW.getTime() + 5 * 60_000 + 1);
    try {
      await expectLimited();
    } finally {
      finish.resolve();
      await pending;
    }
    expect(await messages.count()).toBe(1);
  });

  it.each(['veto', 'missing engine', 'invalid media', 'quote lookup', 'initial save'])(
    'refunds a no-row send after %s',
    async reason => {
      if (reason === 'veto')
        hooks.register('moderation', 'message:sending', () => Promise.resolve({ continue: false }));
      if (reason === 'missing engine') engines.delete('s1');
      if (reason === 'initial save') jest.spyOn(messages, 'save').mockRejectedValueOnce(new Error('write failed'));
      if (reason === 'quote lookup') {
        jest
          .spyOn(sender as unknown as { resolveQuotedBody: () => Promise<string> }, 'resolveQuotedBody')
          .mockRejectedValueOnce(new Error('quote lookup failed'));
      }

      const pending =
        reason === 'invalid media'
          ? sender.sendImage('s1', { chatId: 'first@c.us' })
          : reason === 'quote lookup'
            ? sender.reply('s1', { chatId: 'first@c.us', quotedMessageId: 'prompt', text: 'reply' })
            : send();
      await expect(pending).rejects.toThrow();

      expect(await messages.count()).toBe(0);
      expect(engine.sendTextMessage).not.toHaveBeenCalled();
      hooks.unregisterPlugin('moderation');
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      await expect(send()).resolves.toMatchObject({ messageId: 'sent-1' });
      expect(await messages.count()).toBe(1);
    },
  );

  it('counts the durable row once after handing off its admission', async () => {
    pacingConfig.warmupSchedule = [2];

    await send();
    await send();

    expect(await messages.count()).toBe(2);
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(2);
    await expectLimited();
  });

  it('keeps pacing optional', async () => {
    pacingConfig.enabled = false;

    await send();
    await send();

    expect(await messages.count()).toBe(2);
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it.each(['daily', 'cold'])('carries a preparing %s admission across UTC midnight', async cap => {
    if (cap === 'cold') {
      pacingConfig.warmupSchedule = [100];
      pacingConfig.coldSchedule = [1];
    }
    const entered = deferred();
    const finish = deferred();
    let calls = 0;
    hooks.register('moderation', 'message:sending', async context => {
      if (++calls === 1) {
        entered.resolve();
        await finish.promise;
      }
      return { continue: true, data: context.data };
    });
    const pending = send();
    await entered.promise;
    jest.setSystemTime(new Date('2026-06-02T00:00:01Z'));
    try {
      await expectLimited();
    } finally {
      finish.resolve();
      await pending;
    }
    expect(await messages.count()).toBe(1);
  });

  it.each(['daily', 'cold'])('includes current-day rows when carrying a preparing %s admission', async cap => {
    pacingConfig.warmupSchedule = cap === 'daily' ? [2] : [100];
    pacingConfig.coldSchedule = cap === 'cold' ? [2] : [];
    const entered = deferred();
    const finish = deferred();
    let calls = 0;
    hooks.register('moderation', 'message:sending', async context => {
      if (++calls === 1) {
        entered.resolve();
        await finish.promise;
      }
      return { continue: true, data: context.data };
    });
    const pending = send();
    await entered.promise;
    jest.setSystemTime(new Date('2026-06-02T00:00:01Z'));
    await messages.save({
      sessionId: 's1',
      chatId: 'existing@c.us',
      from: 'a',
      to: 'b',
      type: 'text',
      direction: MessageDirection.OUTGOING,
    });
    try {
      await expectLimited();
    } finally {
      finish.resolve();
      await pending;
    }
    expect(await messages.count()).toBe(2);
  });

  it('keeps the current-day admission when an older preparation is refunded', async () => {
    pacingConfig.warmupSchedule = [2];
    const older = await pacing.assertSendAllowed('s1', 'old@c.us', { whilePreparing: true });
    jest.setSystemTime(new Date('2026-06-02T00:00:01Z'));
    const current = await pacing.assertSendAllowed('s1', 'current@c.us', { whilePreparing: true });

    older?.();
    pacingConfig.warmupSchedule = [1];
    await expectLimited();
    current?.();

    await expect(send()).resolves.toMatchObject({ messageId: 'sent-1' });
  });

  it('refunds a retired preparation before its sending hook completes', async () => {
    const entered = deferred();
    const finish = deferred();
    hooks.register('moderation', 'message:sending', async context => {
      entered.resolve();
      await finish.promise;
      return { continue: true, data: context.data };
    });
    const old = send().catch((error: unknown) => error);
    await entered.promise;
    await replaceSession();
    hooks.unregisterPlugin('moderation');
    expect(await messages.count()).toBe(0);

    try {
      await expect(send()).resolves.toMatchObject({ messageId: 'sent-1' });
      expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await old;
    }
    expect(await old).toMatchObject({ status: 404 });
    expect(await messages.count()).toBe(1);
    await expectLimited();
  });

  it('refunds an admission whose lifetime retires during the pacing lookup', async () => {
    const entered = deferred();
    const finish = deferred();
    const count = messages.count.bind(messages);
    jest.spyOn(messages, 'count').mockImplementationOnce(async options => {
      entered.resolve();
      await finish.promise;
      return count(options);
    });
    const hook = jest.fn((context: HookContext) => Promise.resolve({ continue: true, data: context.data }));
    hooks.register('moderation', 'message:sending', hook);
    const old = send().catch((error: unknown) => error);
    await entered.promise;
    await replaceSession();

    finish.resolve();
    expect(await old).toMatchObject({ status: 404 });
    expect(hook).not.toHaveBeenCalled();
    expect(await messages.count()).toBe(0);
    await expect(send()).resolves.toMatchObject({ messageId: 'sent-1' });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  // The delete transaction must not start while the insert of a pending row is in flight: the row would
  // land after the delete, for a session that no longer exists and with nothing left to settle it.
  it('drains its pending insert before the session content is deleted', async () => {
    const entered = deferred();
    const finish = deferred();
    const save = messages.save.bind(messages);
    jest.spyOn(messages, 'save').mockImplementationOnce(async message => {
      entered.resolve();
      await finish.promise;
      return save(message);
    });
    const old = send().catch((error: unknown) => error);
    await entered.promise;
    let deleted = false;
    const deletion = replaceSession().then(() => {
      deleted = true;
    });
    await new Promise<void>(setImmediate);
    const deletedBeforeInsert = deleted;
    finish.resolve();
    await Promise.all([deletion, old]);

    expect(deletedBeforeInsert).toBe(false);
    expect(await old).toMatchObject({ status: 404 });
    expect(await messages.count()).toBe(0);
  });

  // Told apart by the status the caller gets: a deleted session is a 404, where continuing to the engine
  // lookup would answer a 400 telling them to start a session that is gone.
  it('answers 404, not a missing engine, when its session is deleted during the sending hook', async () => {
    const entered = deferred();
    const finish = deferred();
    hooks.register('moderation', 'message:sending', async context => {
      entered.resolve();
      await finish.promise;
      return { continue: true, data: context.data };
    });
    const old = send().catch((error: unknown) => error);
    await entered.promise;
    const deletion = closeSessionWrites(ds, 's1');
    engines.delete('s1');
    await deletion.drain();
    deletion.release();
    finish.resolve();

    expect(await old).toMatchObject({ status: 404 });
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });

  it('cannot dispatch or settle successfully after its pending write lifetime retires', async () => {
    const entered = deferred();
    const finish = deferred();
    const save = sender.saveOutgoingMessage.bind(sender);
    jest.spyOn(sender, 'saveOutgoingMessage').mockImplementationOnce(async (sessionId, data, lifetime) => {
      const message = await save(sessionId, data, lifetime);
      entered.resolve();
      await finish.promise;
      return message;
    });
    const old = send().catch((error: unknown) => error);
    await entered.promise;
    expect(await messages.count()).toBe(1);
    await replaceSession();

    try {
      await expect(send()).resolves.toMatchObject({ messageId: 'sent-1' });
    } finally {
      finish.resolve();
      await old;
    }
    expect(await old).toMatchObject({ status: 404 });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(await messages.count()).toBe(1);
  });
});
