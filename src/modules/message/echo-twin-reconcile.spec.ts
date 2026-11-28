import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { MessageSendService } from './message-send.service';
import { MessageService } from './message.service';
import { SendPacingService } from './send-pacing.service';
import { computeSendPacingConfig } from './send-pacing.config';
import { PendingMessageReaperService } from './pending-message-reaper.service';

/**
 * The own-send echo can store an API send's row first. The send's own row then holds what the echo does not (the media
 * bytes, a quote, a poll), and is merged onto the echo row and dropped. That merge can fail, a statement error or three
 * lost races to another metadata writer, and so can the drop. The send's row is first kept as the echo row's twin, SENT
 * and naming the echo row (`echoOf`), so whatever stops the merge leaves a row the pending reaper's sweep finishes a
 * minute later: never a second row for good, never a FAILED one stripped of the only copy of the media.
 *
 * Real SQLite, both message services and the reaper; the engine stores the echo row before it answers.
 */
const ID = '3EB0C0FFEE000001';
const BYTES = 'QkFTRTY0UEFZTE9BRA==';
const PHONE = '628111@c.us';
const LID = '484848484848@lid';

describe('a sent row the own-send echo row took the id from, kept as its twin until merged', () => {
  let ds: DataSource;
  let messages: Repository<Message>;
  let sender: MessageSendService;
  let service: MessageService;
  let reaper: PendingMessageReaperService;
  let announced: jest.SpyInstance;
  /** Merge attempts onto the echo row that fail: with a statement error, or by losing three races. */
  let mergeFails: number;
  let mergeFailure: 'error' | 'races';
  let deleteFails: number;
  let echoChat: string;
  let engineChatId: string | undefined;

  const echo = () =>
    messages.insert({
      sessionId: 's1',
      waMessageId: ID,
      chatId: echoChat,
      from: '628999@c.us',
      to: echoChat,
      type: 'image',
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      metadata: { media: { mimetype: 'image/jpeg', omitted: true } },
    });
  const rows = async () =>
    (await messages.find({ where: { sessionId: 's1' }, order: { createdAt: 'ASC' } })).map(row => ({
      waMessageId: row.waMessageId ?? null,
      chatId: row.chatId,
      status: row.status,
      bytes: (row.metadata as { media?: { data?: string } } | null)?.media?.data === BYTES,
      quote: (row.metadata as { quotedMessage?: unknown } | null)?.quotedMessage ?? null,
      poll: Boolean((row.metadata as { poll?: unknown } | null)?.poll),
    }));
  const twins = async () =>
    (await messages.find({ where: { sessionId: 's1' }, select: { id: true, echoOf: true } }))
      .map(row => row.echoOf)
      .filter(Boolean);
  const deleted = () => announced.mock.calls.filter(([event]) => event === 'message:deleted').length;
  /** A sweep at `minutes` past now, with a grace of 0 for PENDING rows. */
  const sweep = (minutes = 0) =>
    reaper.sweep({ intervalMs: 600_000, graceMs: 0, batchSize: 50 }, new Date(Date.now() + minutes * 60_000));

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    mergeFails = 0;
    mergeFailure = 'error';
    deleteFails = 0;
    echoChat = PHONE;
    engineChatId = undefined;
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    await sessions.save({ id: 's1', name: 'sender', createdAt: new Date() });
    messages = ds.getRepository(Message);
    const config = {
      get: (key: string) => (key === 'sendPacing' ? { ...computeSendPacingConfig({}), enabled: false } : undefined),
    } as ConfigService;
    const hooks = new HookManager();
    announced = jest.spyOn(hooks, 'execute');
    const engines = new EngineRegistry();
    const answer = async (): Promise<MessageResult> => {
      await echo();
      return { id: ID, timestamp: 1_786_000_000, ...(engineChatId ? { engineChatId } : {}) };
    };
    engines.set('s1', {
      sendImageMessage: jest.fn(answer),
      sendTextMessage: jest.fn(answer),
      sendPollMessage: jest.fn(answer),
    } as unknown as IWhatsAppEngine);
    const pacing = new SendPacingService(messages, sessions, config);
    sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneBy({ id }) } as never,
      engines,
      hooks,
      {} as never,
      pacing,
      config,
    );
    const lids = { findPhoneForLid: () => Promise.resolve(null), findLidsForPhone: () => Promise.resolve([]) };
    service = new MessageService(messages, engines, {} as never, hooks, lids as never, pacing, sender);
    reaper = new PendingMessageReaperService(messages, hooks, sender);
    const update = messages.update.bind(messages);
    jest.spyOn(messages, 'update').mockImplementation(async (where, patch) => {
      if (mergeFails > 0 && where && typeof where === 'object' && 'metadata' in where) {
        if (mergeFailure === 'error') {
          mergeFails--;
          throw new Error('database is locked');
        }
        // Another metadata writer (a reaction) lands between the read and this write, three times over.
        const row = await messages.findOneBy({ sessionId: 's1', waMessageId: ID });
        const metadata = { ...(row?.metadata ?? {}), reactions: { [`628${mergeFails--}@c.us`]: '+' } };
        await ds.query(`UPDATE messages SET metadata = ? WHERE "waMessageId" = ?`, [JSON.stringify(metadata), ID]);
      }
      return update(where, patch);
    });
    const remove = messages.delete.bind(messages);
    jest.spyOn(messages, 'delete').mockImplementation(async criteria => {
      if (deleteFails > 0) {
        deleteFails--;
        throw new Error('database is locked');
      }
      return remove(criteria);
    });
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    jest.restoreAllMocks();
    await reaper.onModuleDestroy();
    await ds.destroy();
  });

  const sends: Array<[string, () => Promise<unknown>, Partial<Awaited<ReturnType<typeof rows>>[number]>]> = [
    [
      'an image with its bytes',
      () => sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' }),
      { bytes: true },
    ],
    [
      'a quoted text',
      () => sender.sendText('s1', { chatId: PHONE, text: 'answer', quotedMessageId: 'Q1' }),
      { quote: { id: 'Q1', body: '' } },
    ],
    ['a poll', () => sender.sendPoll('s1', { chatId: PHONE, name: 'Q', options: ['a', 'b'] }), { poll: true }],
  ];

  it.each(sends)(
    'keeps %s whose merge failed as the twin, and a sweep a minute later merges it',
    async (_k, send, held) => {
      mergeFails = 1;

      await send();
      expect(await rows()).toEqual([
        expect.objectContaining({ waMessageId: null, status: 'sent', ...held }),
        expect.objectContaining({ waMessageId: ID, status: 'sent' }),
      ]);
      expect(await twins()).toEqual([ID]);
      expect(deleted()).toBe(0);

      // The send itself has a minute to merge it, and the sweep fails no SENT row.
      await sweep();
      expect(await rows()).toHaveLength(2);

      await sweep(2);
      expect(await rows()).toEqual([
        expect.objectContaining({ waMessageId: ID, chatId: PHONE, status: 'sent', ...held }),
      ]);
      expect(await twins()).toEqual([]);
      expect(deleted()).toBe(1);
    },
  );

  it('serves the media of an image by its message id once the sweep merged it', async () => {
    mergeFails = 1;
    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    await expect(service.getChatMedia('s1', PHONE, ID)).rejects.toThrow('No media stored for this message');

    await sweep(2);

    await expect(service.getChatMedia('s1', PHONE, ID)).resolves.toMatchObject({ size: 13, mimetype: 'image/jpeg' });
  });

  it('keeps the twin of a merge that lost three races to another writer, and merges it on the sweep', async () => {
    mergeFails = 3;
    mergeFailure = 'races';

    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    expect(await twins()).toEqual([ID]);
    await sweep(2);

    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, bytes: true })]);
  });

  it('announces the drop of the twin only once it is gone, and never fails it while the drop is refused', async () => {
    deleteFails = 1;

    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    expect(await rows()).toEqual([
      expect.objectContaining({ waMessageId: null, status: 'sent', bytes: true }),
      expect.objectContaining({ waMessageId: ID, status: 'sent', bytes: true }),
    ]);
    expect(deleted()).toBe(0);

    await sweep();
    expect(await rows()).toHaveLength(2);
    await sweep(2);

    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, status: 'sent', bytes: true })]);
    expect(deleted()).toBe(1);
  });

  it('gives the twin the message id when the echo row is gone by the sweep', async () => {
    mergeFails = 1;
    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    await messages.query(`DELETE FROM messages WHERE "waMessageId" = ?`, [ID]);

    await sweep(2);

    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, status: 'sent', bytes: true })]);
    expect(await twins()).toEqual([]);
    await expect(service.getChatMedia('s1', PHONE, ID)).resolves.toMatchObject({ size: 13 });
  });

  it('drops the twin with the media it holds when the echo row was revoked since', async () => {
    mergeFails = 1;
    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    await messages.query(`UPDATE messages SET type = 'revoked', body = '', metadata = NULL WHERE "waMessageId" = ?`, [
      ID,
    ]);

    await sweep(2);

    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, bytes: false })]);
    expect((await messages.findOneByOrFail({ waMessageId: ID })).type).toBe('revoked');
  });

  it('keeps a bulk item whose merge failed as the twin, and merges it on the sweep', async () => {
    await echo();
    mergeFails = 1;

    const saved = await sender.saveOutgoingMessage('s1', {
      waMessageId: ID,
      chatId: PHONE,
      type: 'image',
      status: MessageStatus.SENT,
      timestamp: 1_786_000_000,
      metadata: { media: { mimetype: 'image/jpeg', data: BYTES } },
    });
    expect(saved.waMessageId).toBeFalsy();
    expect(await twins()).toEqual([ID]);

    await sweep(2);

    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, status: 'sent', bytes: true })]);
  });

  it('merges a bulk item onto the echo row at once when nothing fails', async () => {
    await echo();

    const saved = await sender.saveOutgoingMessage('s1', {
      waMessageId: ID,
      chatId: PHONE,
      type: 'image',
      status: MessageStatus.SENT,
      timestamp: 1_786_000_000,
      metadata: { media: { mimetype: 'image/jpeg', data: BYTES } },
    });

    expect(saved.waMessageId).toBe(ID);
    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, bytes: true })]);
    expect(await twins()).toEqual([]);
  });

  it('stops a sweep at the next twin when the module is destroyed during it, and is awaited', async () => {
    for (const id of ['E1', 'E2']) {
      const row = {
        sessionId: 's1',
        chatId: PHONE,
        from: '628999@c.us',
        to: PHONE,
        direction: MessageDirection.OUTGOING,
      };
      await messages.insert({ ...row, waMessageId: id, status: MessageStatus.SENT });
      await messages.insert({ ...row, status: MessageStatus.SENT, echoOf: id, metadata: { poll: { name: id } } });
    }
    let reached!: () => void;
    let release!: () => void;
    const inHand = new Promise<void>(resolve => (reached = resolve));
    const held = new Promise<void>(resolve => (release = resolve));
    const findOne = messages.findOne.bind(messages);
    jest.spyOn(messages, 'findOne').mockImplementation(async options => {
      if ((options.where as { waMessageId?: string }).waMessageId === 'E1' && options.select) {
        reached();
        await held;
      }
      return findOne(options);
    });

    const sweeping = sweep(2);
    await inHand;
    let destroyed = false;
    const destroying = reaper.onModuleDestroy().then(() => (destroyed = true));
    await new Promise(resolve => setImmediate(resolve));
    expect(destroyed).toBe(false);
    release();
    await destroying;
    await sweeping;

    expect((await twins()).sort()).toEqual(['E2']);
  });

  it('moves an echo row under the lid the send went to under the chat its caller addressed on the sweep', async () => {
    echoChat = LID;
    engineChatId = LID;
    mergeFails = 1;
    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    expect((await rows()).map(row => row.chatId)).toEqual([PHONE, LID]);

    await sweep(2);

    expect(await rows()).toEqual([expect.objectContaining({ waMessageId: ID, chatId: PHONE, bytes: true })]);
    expect(await messages.findOne({ where: { waMessageId: ID }, select: { to: true, engineRef: true } })).toEqual({
      to: PHONE,
      engineRef: { chatId: LID, direction: 'outgoing', addressed: true },
    });
  });
});
