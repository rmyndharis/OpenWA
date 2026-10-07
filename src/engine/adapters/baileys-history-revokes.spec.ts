import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { DataSource, Repository } from 'typeorm';
import { BaileysHistory, BaileysHistoryHost } from './baileys-history';
import { BaileysEvents, BaileysEventsHost } from './baileys-events';
import { BaileysMessaging } from './baileys-messaging';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysSessionStore } from './baileys-session-store';
import { Message, MessageDirection } from '../../modules/message/entities/message.entity';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import { persistHistoryMessages } from '../../modules/session/message-history-projector';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

const CHAT = '628111@s.whatsapp.net';
const SELF = '628222@s.whatsapp.net';
const target = (over: Partial<WAMessage> = {}): WAMessage => ({
  key: { id: 'M1', remoteJid: CHAT, fromMe: false },
  message: { conversation: 'withdrawn secret' },
  messageTimestamp: 1_700_000_000,
  ...over,
});
const revoke = (key: WAMessage['key'] = target().key, envelope: Partial<WAMessage['key']> = {}): WAMessage => ({
  key: { id: 'R1', remoteJid: key.remoteJid, fromMe: false, ...envelope },
  message: { protocolMessage: { type: 0, key } },
  messageTimestamp: 1_700_000_100,
});

describe('Baileys history revokes', () => {
  let ds: DataSource;
  let repo: Repository<Message>;
  let raw: BaileysMessageStoreService;
  let history: BaileysHistory;
  let messaging: BaileysMessaging;
  let previews: BaileysSessionStore;
  let pending: Promise<IncomingMessage[]>[];
  let onHistory: jest.Mock;
  let liveFanout: jest.Mock;
  let persisted: jest.Mock;
  let isLive: boolean;
  let sendMessage: jest.Mock;
  let events: BaileysEvents;
  let releaseMedia: () => void;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session, BaileysStoredMessage],
      synchronize: true,
    }).initialize();
    repo = ds.getRepository(Message);
    raw = new BaileysMessageStoreService(ds.getRepository(BaileysStoredMessage));
    await ds.getRepository(Session).save({ id: 's1', name: 's1', status: SessionStatus.READY, config: {} });
    previews = new BaileysSessionStore(undefined, 's1');
    previews.upsertChats([{ id: CHAT }, { id: '1@g.us' }]);
    pending = [];
    isLive = true;
    liveFanout = jest.fn();
    persisted = jest.fn();
    onHistory = jest.fn((messages: IncomingMessage[]) => {
      const saving = persistHistoryMessages(
        repo,
        undefined,
        's1',
        messages,
        { log: jest.fn() } as never,
        () => isLive,
        persisted,
      );
      pending.push(saving);
      return saving;
    });
    sendMessage = jest.fn().mockResolvedValue({ key: { id: 'S1', remoteJid: CHAT, fromMe: true } });
    const socket = { sendMessage, onWhatsApp: (jid: string) => Promise.resolve([{ jid, exists: true }]) };
    const host = {
      getSocket: () => socket as unknown as WASocket,
      getSocketOrNull: () => socket as unknown as WASocket,
      logger: createLogger('baileys-history-revokes.spec'),
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (m: unknown) => m,
          getContentType: (m: object) => Object.keys(m)[0],
          extractMessageContent: (m: unknown) => m,
          proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0 } } } },
          downloadMediaMessage: () =>
            new Promise(resolve => {
              releaseMedia = () =>
                resolve({
                  // eslint-disable-next-line @typescript-eslint/require-await
                  async *[Symbol.asyncIterator]() {
                    yield Buffer.from('private photo');
                  },
                });
            }),
        } as never),
      normalizedSelfJid: () => SELF,
      toNeutralJid: (jid: string) => previews.toNeutralJid(jid),
      toEngineJid: (jid: string) => jid,
      extractEphemeralDuration: (msg: WAMessage) => previews.extractEphemeralDuration(msg),
      recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1]) =>
        previews.recordMessage(msg, type),
      recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
        previews.recordMessageEdit(...args),
      upsertContacts: () => undefined,
      getOnHistoryMessages: () => onHistory,
      getOnMessageRevoked: () => liveFanout,
      getOnMessage: () => liveFanout,
      getOnMessageCreate: () => liveFanout,
      getFetchDispatcher: () => undefined,
      inboundLimiter: new ConcurrencyLimiter(4),
      recordKeyLidMappings: () => undefined,
      consumeOwnSend: () => false,
      putStoredMessage: (msg: WAMessage) => raw.put('s1', msg),
      getStoredMessage: (id: string) => raw.getMessage('s1', id),
      updateStoredMessage: (id: string, change: (stored: WAMessage) => WAMessage | null) =>
        raw.update('s1', id, change),
      ensureReady: () => undefined,
    };
    events = new BaileysEvents(host as unknown as BaileysEventsHost);
    const shared = {
      ...host,
      applyHistoryRevoke: (...args: Parameters<BaileysEvents['applyHistoryRevoke']>) =>
        events.applyHistoryRevoke(...args),
      wasDeletedForEveryone: (id: string) => events.wasDeletedForEveryone(id),
      pendingEditOf: (id: string, key: WAMessage['key']) => events.pendingEditOf(id, key),
    };
    history = new BaileysHistory(shared as unknown as BaileysHistoryHost);
    messaging = new BaileysMessaging(shared as never);
  });

  afterEach(async () => {
    await Promise.all(pending);
    await ds.destroy();
  });

  const capture = async (messages: WAMessage[]): Promise<void> => {
    await history.captureHistoryMessages(messages);
    await Promise.all(pending);
  };
  const cleared = async (): Promise<Message> => {
    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ body: '', type: 'revoked', metadata: null, mediaPath: null, mediaMimetype: null });
    expect(liveFanout).not.toHaveBeenCalled();
    return row;
  };

  it.each([false, true])('persists a cleared target in either batch order (reversed=%s)', async reversed => {
    const batch = [target(), revoke()];
    await capture(reversed ? batch.reverse() : batch);
    await cleared();
    expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('clears stored poll, archive, quote and reaction data in a revoke-only chunk', async () => {
    const poll = target({
      message: {
        pollCreationMessageV3: {
          name: 'Private question',
          options: [{ optionName: 'Secret' }],
          selectableOptionsCount: 1,
        },
      },
    });
    await capture([poll]);
    const row = await repo.findOneByOrFail({ waMessageId: 'M1' });
    expect(row.metadata.poll).toBeDefined();
    await repo.update(row.id, {
      metadata: {
        ...row.metadata,
        media: { data: 'secret' },
        quotedMessage: { body: 'secret' },
        reactions: { sender: 'yes' },
      },
      mediaPath: 's1/secret.jpg',
      mediaMimetype: 'image/jpeg',
    });
    await raw.put('s1', poll);
    await capture([revoke()]);
    await cleared();
    expect(onHistory).toHaveBeenCalledTimes(2);
    expect(persisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id, body: '', type: 'revoked', metadata: null }),
    );
    expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
    await expect(messaging.replyToMessage(CHAT, 'M1', 'reply')).rejects.toBeInstanceOf(MessageNotFoundError);
    await expect(messaging.forwardMessage(CHAT, SELF, 'M1')).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps a tombstone when the target arrives in a later history chunk', async () => {
    await capture([revoke()]);
    await cleared();
    await capture([target()]);
    expect(await cleared()).toMatchObject({ timestamp: 1_700_000_000, createdAt: new Date(1_700_000_000_000) });
    expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('keeps the preview cleared after the bounded raw-cache marker has been evicted', async () => {
    await raw.put('s1', target());
    await capture([revoke()]);
    for (let i = 0; i <= BaileysEvents.DELETED_FOR_EVERYONE_LIMIT; i++) events.markDeletedForEveryone(`other-${i}`);
    expect(events.wasDeletedForEveryone('M1')).toBe(false);
    await capture([target()]);
    await cleared();
    expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('keeps the tombstone when a concurrent content chunk finishes its dedup query later', async () => {
    const find = repo.find.bind(repo);
    let releaseFind!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseFind = resolve;
    });
    const spy = jest
      .spyOn(repo, 'find')
      .mockImplementationOnce(async () => {
        await gate;
        return [];
      })
      .mockImplementation(find);
    const m: IncomingMessage = {
      id: 'M1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628222@c.us',
      fromMe: false,
      isGroup: false,
      kind: 'individual',
      body: 'withdrawn secret',
      type: 'text',
      timestamp: 1_700_000_000,
    };
    const content = persistHistoryMessages(repo, undefined, 's1', [m], { log: jest.fn() } as never, () => true);
    await capture([revoke()]);
    releaseFind();
    await content;
    spy.mockRestore();
    expect(await cleared()).toMatchObject({ timestamp: 1_700_000_000, createdAt: new Date(1_700_000_000_000) });
  });

  it('clears an original still downloading its media without live fanout', async () => {
    const photo = target({ message: { imageMessage: { mimetype: 'image/jpeg', caption: 'withdrawn secret' } } });
    events.handleMessagesUpsert({ messages: [photo], type: 'notify' });
    for (let i = 0; i < 20 && !releaseMedia; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(releaseMedia).toBeDefined();
    await capture([revoke()]);
    releaseMedia();
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    await cleared();
    expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
  });

  it.each([
    ['another chat', { remoteJid: SELF }],
    ['another author', { fromMe: true }],
  ])('rejects a revoke from %s in the same batch and raw cache', async (_label, envelope) => {
    await raw.put('s1', target());
    await capture([target(), revoke(target().key, envelope)]);
    expect(await repo.findOneByOrFail({ waMessageId: 'M1' })).toMatchObject({ body: 'withdrawn secret', type: 'text' });
    expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(target().message);
  });

  it.each([
    ['another chat', { remoteJid: SELF }],
    ['another author', { fromMe: true }],
  ])('preserves a prior SQL row when a revoke targets %s without a raw copy', async (_label, key) => {
    await capture([target()]);
    const other = { ...target().key, ...key };
    await capture([revoke(other, { fromMe: other.fromMe })]);
    await capture([target()]);
    expect(await repo.findOneByOrFail({ waMessageId: 'M1' })).toMatchObject({ body: 'withdrawn secret', type: 'text' });
    expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
      lastMessage: 'withdrawn secret',
      lastMessageType: 'text',
    });
  });

  it('accepts a group admin revoke and preserves the original outgoing direction', async () => {
    const own = target({ key: { id: 'M1', remoteJid: '1@g.us', fromMe: true } });
    await raw.put('s1', own);
    await capture([own, revoke(own.key, { fromMe: false, participant: CHAT })]);
    expect(await cleared()).toMatchObject({ direction: MessageDirection.OUTGOING, from: '628222@c.us', author: null });
    expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
  });

  it('does not write history tombstones after the session is retired', async () => {
    isLive = false;
    await capture([revoke()]);
    expect(await repo.count()).toBe(0);
  });

  it('does not apply a history revoke whose raw lookup outlives unlinking', async () => {
    await raw.put('s1', target());
    let release!: (message: WAMessage) => void;
    const spy = jest.spyOn(raw, 'getMessage').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const applying = events.applyHistoryRevoke(target().key, revoke().key);
    events.fenceStoredWrites();
    release(target());
    expect(await applying).toBeUndefined();
    spy.mockRestore();
    expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(target().message);
  });

  it('clears old content with retention enabled without inserting old content again', async () => {
    await capture([target()]);
    const previous = process.env.MESSAGE_RETENTION_DAYS;
    process.env.MESSAGE_RETENTION_DAYS = '1';
    try {
      await capture([target(), revoke()]);
      await cleared();
      previews = new BaileysSessionStore(undefined, 's1');
      previews.upsertChats([{ id: CHAT }]);
      await capture([target()]);
      expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
        lastMessage: '',
        lastMessageType: 'revoked',
      });
    } finally {
      if (previous === undefined) delete process.env.MESSAGE_RETENTION_DAYS;
      else process.env.MESSAGE_RETENTION_DAYS = previous;
    }
  });
});
