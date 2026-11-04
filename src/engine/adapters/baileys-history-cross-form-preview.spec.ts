import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { DataSource, Repository } from 'typeorm';
import { BaileysHistory, BaileysHistoryHost } from './baileys-history';
import { BaileysEvents, BaileysEventsHost } from './baileys-events';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysSessionStore } from './baileys-session-store';
import { Message, MessageDirection, MessageStatus } from '../../modules/message/entities/message.entity';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import { persistHistoryMessages } from '../../modules/session/message-history-projector';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

const PHONE_JID = '628111@s.whatsapp.net';
const PHONE_CHAT = '628111@c.us';
const LID_JID = '111@lid';
const SELF = '628222@s.whatsapp.net';

const target = (over: Partial<WAMessage> = {}): WAMessage => ({
  key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
  message: { conversation: 'withdrawn secret' },
  messageTimestamp: 1_700_000_000,
  ...over,
});

const revoke = (key: WAMessage['key'] = target().key, envelope: Partial<WAMessage['key']> = {}): WAMessage => ({
  key: { id: 'R1', remoteJid: key.remoteJid, fromMe: key.fromMe ?? false, ...envelope },
  message: { protocolMessage: { type: 0, key } },
  messageTimestamp: 1_700_000_100,
});

describe('Baileys history revokes across LID and phone chat keys', () => {
  let ds: DataSource;
  let repo: Repository<Message>;
  let raw: BaileysMessageStoreService;
  let history: BaileysHistory;
  let historyHost: BaileysHistoryHost;
  let previews: BaileysSessionStore;
  let pending: Promise<IncomingMessage[]>[];
  let events: BaileysEvents;
  let mappedPhone: string | null;

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
    previews.upsertChats([{ id: PHONE_JID }, { id: LID_JID }]);
    pending = [];
    mappedPhone = '628111';
    const resolveLid = (jid: string): Promise<string | null> =>
      Promise.resolve(jid === LID_JID || jid === '111' ? mappedPhone : null);
    const onHistory = jest.fn((messages: IncomingMessage[]) => {
      const saving = persistHistoryMessages(
        repo,
        undefined,
        's1',
        messages,
        { log: jest.fn() } as never,
        () => true,
        undefined,
        resolveLid,
      );
      pending.push(saving);
      return saving;
    });
    const socket = {
      sendMessage: jest.fn(),
      onWhatsApp: (jid: string) => Promise.resolve([{ jid, exists: true }]),
    };
    const host = {
      getSocket: () => socket as unknown as WASocket,
      getSocketOrNull: () => socket as unknown as WASocket,
      logger: createLogger('baileys-history-cross-form-preview.spec'),
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (m: unknown) => m,
          getContentType: (m: object) => Object.keys(m ?? {})[0],
          extractMessageContent: (m: unknown) => m,
          proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
        } as never),
      normalizedSelfJid: () => SELF,
      toNeutralJid: (jid: string) => previews.toNeutralJid(jid),
      toEngineJid: (jid: string) => previews.toEngineJid(jid),
      extractEphemeralDuration: (msg: WAMessage) => previews.extractEphemeralDuration(msg),
      recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1], order?: number) =>
        previews.recordMessage(msg, type, order),
      recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
        previews.recordMessageEdit(...args),
      findPersistedLidPhone: resolveLid,
      upsertContacts: () => undefined,
      getOnHistoryMessages: () => onHistory,
      getOnMessageRevoked: () => undefined,
      getOnMessageEdited: () => undefined,
      getOnMessage: () => undefined,
      getOnMessageCreate: () => undefined,
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
    historyHost = shared as unknown as BaileysHistoryHost;
    history = new BaileysHistory(historyHost);
  });

  afterEach(async () => {
    await Promise.all(pending);
    await ds.destroy();
  });

  const capture = async (messages: WAMessage[]): Promise<void> => {
    await history.captureHistoryMessages(messages);
    await Promise.all(pending);
  };

  it('clears both the stored LID row and the LID chat preview when a later history chunk revokes by phone', async () => {
    const lidOriginal = target({ key: { id: 'M1', remoteJid: LID_JID, fromMe: false } });
    await capture([lidOriginal]);
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: 'withdrawn secret',
      lastMessageType: 'text',
    });

    await capture([revoke({ id: 'M1', remoteJid: PHONE_JID, fromMe: false }, { remoteJid: PHONE_JID })]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ chatId: LID_JID, body: '', type: 'revoked' });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('keeps the LID preview cleared when history delivers the message and its revoke under LID for a phone-stored raw message', async () => {
    const phoneOriginal = target({ key: { id: 'M1', remoteJid: PHONE_JID, fromMe: true } });
    await raw.put('s1', phoneOriginal);
    previews.recordMessage(phoneOriginal, 'text');

    const lidOriginal = target({ key: { id: 'M1', remoteJid: LID_JID, fromMe: true } });
    const lidRevoke = revoke(lidOriginal.key, { remoteJid: LID_JID, fromMe: true });
    await capture([lidOriginal, lidRevoke]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ body: '', type: 'revoked' });
    expect(previews.listChats().find(chat => chat.id === PHONE_CHAT)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('clears the LID preview when history delivers the LID message and LID revoke across separate chunks for a phone-stored raw message', async () => {
    const phoneOriginal = target({ key: { id: 'M1', remoteJid: PHONE_JID, fromMe: true } });
    await raw.put('s1', phoneOriginal);
    previews.recordMessage(phoneOriginal, 'text');

    const lidOriginal = target({ key: { id: 'M1', remoteJid: LID_JID, fromMe: true } });
    const lidRevoke = revoke(lidOriginal.key, { remoteJid: LID_JID, fromMe: true });
    await capture([lidOriginal]);
    await capture([lidRevoke]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ body: '', type: 'revoked' });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('clears the LID preview across separate chunks when an initial REST send pre-seeded both the SQL row and raw copy under phone', async () => {
    const phoneOriginal = target({ key: { id: 'M1', remoteJid: PHONE_JID, fromMe: true } });
    await raw.put('s1', phoneOriginal);
    await repo.insert({
      sessionId: 's1',
      waMessageId: 'M1',
      chatId: PHONE_CHAT,
      from: '628222@c.us',
      to: PHONE_CHAT,
      body: 'withdrawn secret',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: 1_700_000_000,
    });
    previews.recordMessage(phoneOriginal, 'text');

    const lidOriginal = target({ key: { id: 'M1', remoteJid: LID_JID, fromMe: true } });
    const lidRevoke = revoke(lidOriginal.key, { remoteJid: LID_JID, fromMe: true });
    await capture([lidOriginal]);
    await capture([lidRevoke]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ chatId: PHONE_CHAT, body: '', type: 'revoked' });
    expect(previews.listChats().find(chat => chat.id === PHONE_CHAT)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('leaves the LID preview untouched when a phone-addressed history revoke has no matching persisted LID-to-phone mapping', async () => {
    mappedPhone = '628999';
    const lidOriginal = target({ key: { id: 'M1', remoteJid: LID_JID, fromMe: false } });
    await capture([lidOriginal]);

    await capture([revoke({ id: 'M1', remoteJid: PHONE_JID, fromMe: false }, { remoteJid: PHONE_JID })]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ chatId: LID_JID, body: 'withdrawn secret', type: 'text' });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: 'withdrawn secret',
      lastMessageType: 'text',
    });
  });

  it('clears the LID preview when a phone-addressed history revoke clears a live-persisted LID row not seen by captureHistoryMessages', async () => {
    const lidOriginal = target({ key: { id: 'M1', remoteJid: LID_JID, fromMe: false } });
    await repo.insert({
      sessionId: 's1',
      waMessageId: 'M1',
      chatId: LID_JID,
      from: LID_JID,
      to: '628222@c.us',
      body: 'withdrawn secret',
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: 1_700_000_000,
    });
    previews.recordMessage(lidOriginal, 'text');

    await capture([revoke({ id: 'M1', remoteJid: PHONE_JID, fromMe: false }, { remoteJid: PHONE_JID })]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    expect(row).toMatchObject({ chatId: LID_JID, body: '', type: 'revoked' });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('does not clear a foreign chat preview when a revoke of a stored message carries a forged target.remoteJid', async () => {
    const foreignLid = '999@lid';
    previews.upsertChats([{ id: foreignLid }]);
    const ownChatMsg = target({ key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false } });
    await raw.put('s1', ownChatMsg);
    previews.recordMessage(ownChatMsg, 'text');

    const foreignPreviewMsg = target({
      key: { id: 'M1', remoteJid: foreignLid, fromMe: false },
      message: { conversation: 'foreign chat secret' },
    });
    previews.recordMessage(foreignPreviewMsg, 'text');

    await capture([revoke({ id: 'M1', remoteJid: foreignLid, fromMe: false }, { remoteJid: PHONE_JID })]);

    expect(previews.listChats().find(chat => chat.id === PHONE_CHAT)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
    expect(previews.listChats().find(chat => chat.id === foreignLid)).toMatchObject({
      lastMessage: 'foreign chat secret',
      lastMessageType: 'text',
    });
  });

  it('keeps a history message when a revoke from another chat names its id in the same batch', async () => {
    const OTHER_CHAT_JID = '628333@s.whatsapp.net';
    const bobs = target({
      key: { id: 'X2', remoteJid: PHONE_JID, fromMe: false },
      message: { conversation: 'bob history text' },
    });

    await capture([
      bobs,
      revoke({ id: 'X2', remoteJid: OTHER_CHAT_JID, fromMe: false }, { remoteJid: OTHER_CHAT_JID }),
    ]);

    const rows = await repo.find({ where: { sessionId: 's1', waMessageId: 'X2' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chatId: PHONE_CHAT, type: 'text', body: 'bob history text' });
  });

  it('dates the tombstone of a history message from the message when its raw copy is stored', async () => {
    const own = target({ key: { id: 'X5', remoteJid: PHONE_JID, fromMe: true } });
    await raw.put('s1', own);

    await capture([own, revoke(own.key, { fromMe: true })]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'X5' });
    expect(row).toMatchObject({ type: 'revoked', timestamp: 1_700_000_000 });
  });

  it('leaves a lid twin preview of the other direction alone when a history revoke names the phone chat', async () => {
    previews.recordMessage(
      target({ key: { id: 'X4', remoteJid: LID_JID, fromMe: false }, message: { conversation: 'bob text' } }),
      'text',
    );
    const ours = target({ key: { id: 'X4', remoteJid: PHONE_JID, fromMe: true } });
    const withTwins = new BaileysHistory({ ...historyHost, chatTwins: () => [LID_JID] });

    await withTwins.captureHistoryMessages([ours, revoke(ours.key, { fromMe: true })]);
    await Promise.all(pending);

    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: 'bob text',
      lastMessageType: 'text',
    });
  });
});
