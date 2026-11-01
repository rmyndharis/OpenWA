import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { DataSource } from 'typeorm';
import { BaileysEvents, BaileysEventsHost } from './baileys-events';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysSessionStore } from './baileys-session-store';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

const PHONE_JID = '628111@s.whatsapp.net';
const LID_JID = '111@lid';
const SELF = '628222@s.whatsapp.net';

const lidMessage = (over: Partial<WAMessage> = {}): WAMessage => ({
  key: { id: 'M1', remoteJid: LID_JID, fromMe: false },
  message: { conversation: 'withdrawn secret' },
  messageTimestamp: 1_700_000_000,
  ...over,
});

const waitForCondition = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for condition');
};

describe('Baileys live edit and revoke previews across LID and phone chat keys', () => {
  let ds: DataSource;
  let raw: BaileysMessageStoreService;
  let previews: BaileysSessionStore;
  let events: BaileysEvents;
  let mappedPhone: string | null;
  let releaseMedia!: () => void;
  let onMessage: jest.Mock;
  let onRevoked: jest.Mock;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, BaileysStoredMessage],
      synchronize: true,
    }).initialize();
    raw = new BaileysMessageStoreService(ds.getRepository(BaileysStoredMessage));
    await ds.getRepository(Session).save({ id: 's1', name: 's1', status: SessionStatus.READY, config: {} });
    previews = new BaileysSessionStore(undefined, 's1');
    previews.upsertChats([{ id: PHONE_JID }, { id: LID_JID }]);
    mappedPhone = '628111';
    onMessage = jest.fn();
    onRevoked = jest.fn();
    const resolveLid = (jid: string): Promise<string | null> =>
      Promise.resolve(jid === LID_JID || jid === '111' ? mappedPhone : null);
    const socket = {
      sendMessage: jest.fn(),
      onWhatsApp: (jid: string) => Promise.resolve([{ jid, exists: true }]),
    };
    const host = {
      getSocket: () => socket as unknown as WASocket,
      getSocketOrNull: () => socket as unknown as WASocket,
      logger: createLogger('baileys-live-cross-form-preview.spec'),
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (m: unknown) => m,
          getContentType: (m: object) => Object.keys(m ?? {})[0],
          extractMessageContent: (m: unknown) => m,
          BufferJSON: {
            replacer: (_k: string, v: unknown) => v,
            reviver: (_k: string, v: unknown) => v,
          },
          proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
          downloadMediaMessage: () =>
            new Promise(resolve => {
              releaseMedia = () =>
                resolve({
                  // eslint-disable-next-line @typescript-eslint/require-await
                  async *[Symbol.asyncIterator]() {
                    yield Buffer.from('photo-bytes');
                  },
                });
            }),
        } as never),
      normalizedSelfJid: () => SELF,
      toNeutralJid: (jid: string) => previews.toNeutralJid(jid),
      toEngineJid: (jid: string) => previews.toEngineJid(jid),
      recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1], order?: number) =>
        previews.recordMessage(msg, type, order),
      recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
        previews.recordMessageEdit(...args),
      findPersistedLidPhone: resolveLid,
      getOnMessageRevoked: () => onRevoked,
      getOnMessageEdited: () => undefined,
      getOnMessage: () => onMessage,
      getOnMessageCreate: () => undefined,
      getFetchDispatcher: () => undefined,
      inboundLimiter: new ConcurrencyLimiter(4),
      recordKeyLidMappings: () => undefined,
      consumeOwnSend: () => false,
      putStoredMessage: (msg: WAMessage) => raw.put('s1', msg),
      getStoredMessage: (id: string) => raw.getMessage('s1', id),
      updateStoredMessage: (id: string, change: (stored: WAMessage) => WAMessage | null) =>
        raw.update('s1', id, change),
    };
    events = new BaileysEvents(host as unknown as BaileysEventsHost);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('updates a LID chat preview when a live edit arrives under the phone JID', async () => {
    const original = lidMessage();
    await raw.put('s1', original);
    previews.recordMessage(original, 'text');

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'E1', remoteJid: PHONE_JID, fromMe: false },
          message: {
            protocolMessage: {
              type: 14,
              key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
              editedMessage: { conversation: 'updated body' },
            },
          },
          messageTimestamp: 1_700_000_050,
        },
      ],
    });
    await waitForCondition(async () => (await raw.getMessage('s1', 'M1'))?.message?.conversation === 'updated body');

    expect((await raw.getMessage('s1', 'M1'))?.message).toEqual({ conversation: 'updated body' });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: 'updated body',
      lastMessageType: 'text',
    });
  });

  it('clears a LID chat preview when a live revoke arrives under the phone JID', async () => {
    const original = lidMessage();
    await raw.put('s1', original);
    previews.recordMessage(original, 'text');

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'R1', remoteJid: PHONE_JID, fromMe: false },
          message: {
            protocolMessage: {
              type: 0,
              key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
            },
          },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
    await waitForCondition(async () => (await raw.getMessage('s1', 'M1'))?.message === null);

    expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('rejects a phone-addressed live revoke when the persisted LID mapping belongs to another phone', async () => {
    mappedPhone = '628999';
    const original = lidMessage();
    await raw.put('s1', original);
    previews.recordMessage(original, 'text');

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'R1', remoteJid: PHONE_JID, fromMe: false },
          message: {
            protocolMessage: {
              type: 0,
              key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
            },
          },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
    await waitForCondition(
      () => (events as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size === 0,
    );

    expect((await raw.getMessage('s1', 'M1'))?.message).toEqual({ conversation: 'withdrawn secret' });
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: 'withdrawn secret',
      lastMessageType: 'text',
    });
  });

  it('clears the LID preview and suppresses live emit when a phone-addressed revoke arrives while a LID media message is in flight', async () => {
    const lidMedia = lidMessage({
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'withdrawn secret' } },
    });
    events.handleMessagesUpsert({ type: 'notify', messages: [lidMedia] });
    await waitForCondition(() => typeof releaseMedia === 'function');

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'R1', remoteJid: PHONE_JID, fromMe: false },
          message: {
            protocolMessage: {
              type: 0,
              key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
            },
          },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    releaseMedia();
    await waitForCondition(
      () => (events as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size === 0,
    );
    await waitForCondition(async () => (await raw.getMessage('s1', 'M1'))?.message === null);

    expect(onMessage).not.toHaveBeenCalled();
    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });

  it('updates the LID preview when a phone-addressed edit arrives while a LID media message is in flight', async () => {
    const lidMedia = lidMessage({
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'withdrawn secret' } },
    });
    events.handleMessagesUpsert({ type: 'notify', messages: [lidMedia] });
    await waitForCondition(() => typeof releaseMedia === 'function');

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'E1', remoteJid: PHONE_JID, fromMe: false },
          message: {
            protocolMessage: {
              type: 14,
              key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
              editedMessage: { imageMessage: { caption: 'updated caption' } },
            },
          },
          messageTimestamp: 1_700_000_050,
        },
      ],
    });
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    releaseMedia();
    await waitForCondition(
      () => (events as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size === 0,
    );
    await waitForCondition(
      async () => (await raw.getMessage('s1', 'M1'))?.message?.imageMessage?.caption === 'updated caption',
    );

    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: 'updated caption',
      lastMessageType: 'image',
    });
  });

  it('clears a history-seeded LID preview (not in baileys_stored_messages) when a live revoke arrives under the phone JID', async () => {
    previews.recordMessage(lidMessage(), 'text', 0);

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'R1', remoteJid: PHONE_JID, fromMe: false },
          message: {
            protocolMessage: {
              type: 0,
              key: { id: 'M1', remoteJid: PHONE_JID, fromMe: false },
            },
          },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
    await waitForCondition(() => onRevoked.mock.calls.length === 1);

    expect(previews.listChats().find(chat => chat.id === LID_JID)).toMatchObject({
      lastMessage: '',
      lastMessageType: 'revoked',
    });
  });
});
