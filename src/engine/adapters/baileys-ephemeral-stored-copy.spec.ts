import { createCipheriv, createHmac } from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { DataSource } from 'typeorm';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

type Lib = Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

/**
 * STORE_EPHEMERAL_MESSAGES=false opts out of keeping the messages of a disappearing-messages chat: the session neither
 * stores nor announces one it receives. The adapter keeps its own copy of messages in `baileys_stored_messages`, which
 * has no age limit and is part of a backup, so that copy is skipped for the same messages. The real events handler
 * runs over the real message store on in-memory SQLite.
 */
type Wrapped = { message?: unknown } | null | undefined;
const unwrap = (content: unknown): unknown => {
  let current = content;
  for (let i = 0; i < 5; i++) {
    const inner = (current as { ephemeralMessage?: Wrapped } | null | undefined)?.ephemeralMessage;
    if (!inner) break;
    current = inner.message;
  }
  return current;
};
const lib = {
  normalizeMessageContent: unwrap,
  extractMessageContent: unwrap,
  getContentType: (c: Record<string, unknown> | undefined) =>
    Object.keys(c ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
  BufferJSON,
  proto: {
    Message: {
      SecretEncryptedMessage: { SecretEncType: { UNKNOWN: 0, EVENT_EDIT: 1, MESSAGE_EDIT: 2 } },
      ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } },
      decode: (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString()),
    },
  },
  downloadMediaMessage: jest.fn(),
} as unknown as Lib;

const group = '120363000000000001@g.us';
const author = '39900313301142@lid';
const secret = Buffer.alloc(32, 0x42);
const DAY = 86_400;

/** Waits for `condition` between event-loop turns and fails at the deadline instead of hanging. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

const received = (id: string, inner: Record<string, unknown>, key: Record<string, unknown> = {}): WAMessage => ({
  key: { id, remoteJid: group, participant: author, fromMe: false, ...key },
  messageTimestamp: 1_786_000_000,
  message: inner,
});

/** A message of a chat with a disappearing-messages timer, as it arrives: wrapped, with its secret. */
const disappearing = (id = 'VANISH1', key: Record<string, unknown> = {}): WAMessage =>
  received(
    id,
    {
      ephemeralMessage: {
        message: {
          extendedTextMessage: { text: 'this should vanish', contextInfo: { expiration: DAY } },
          messageContextInfo: { messageSecret: secret.toString('base64') },
        },
      },
    },
    key,
  );

const ordinary = (id = 'KEPT1'): WAMessage => received(id, { extendedTextMessage: { text: 'an ordinary message' } });

/** Seals an edit as the library derives its key (HKDF-SHA256, zero salt, AES-256-GCM, no AAD). */
function sealedEdit(envelopeId: string, targetId: string, text: string): WAMessage {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
  const info = Buffer.from(`${targetId}${author}${author}Message Edit`);
  const key = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  const iv = Buffer.alloc(12, 5);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = {
    protocolMessage: { type: 14, key: { id: targetId }, editedMessage: { conversation: text }, timestampMs: 1 },
  };
  const encPayload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plain))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return received(envelopeId, {
    secretEncryptedMessage: {
      targetMessageKey: { id: targetId, remoteJid: group, fromMe: false },
      encPayload,
      encIv: iv,
      secretEncType: 2,
    },
  });
}

describe('a disappearing message received while STORE_EPHEMERAL_MESSAGES is off', () => {
  let ds: DataSource;
  let service: BaileysMessageStoreService;
  const saved = process.env.STORE_EPHEMERAL_MESSAGES;
  const delivered: string[] = [];
  const typed: string[] = [];
  const edited: string[] = [];
  const reacted: string[] = [];
  let debug: jest.SpyInstance;

  const countRows = (): Promise<number> => ds.getRepository(BaileysStoredMessage).count();
  /** The copy the store holds, after every write of the id it has already been handed has landed. */
  const copyOf = (id: string): Promise<WAMessage | null> => service.getMessage('s1', id);

  /** `previews`, when given, is the session store the adapter keeps the chat list in; otherwise nothing is recorded. */
  function newEvents(previews?: BaileysSessionStore): BaileysEvents {
    const noop = (): void => undefined;
    const logger = createLogger('BaileysEphemeralStoredCopySpec');
    debug = jest.spyOn(logger, 'debug');
    return new BaileysEvents({
      getSocket: () => ({}) as WASocket,
      getSocketOrNull: () => null,
      logger,
      loadLib: () => Promise.resolve(lib),
      getFetchDispatcher: () => undefined,
      toNeutralJid: (jid: string) => jid,
      normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
      inboundLimiter: new ConcurrencyLimiter(4),
      recordKeyLidMappings: noop,
      recordMessage: previews
        ? (
            msg: WAMessage,
            type: Parameters<BaileysSessionStore['recordMessage']>[1],
            order?: number,
            withhold?: boolean,
          ) => previews.recordMessage(msg, type, order, withhold)
        : noop,
      recordMessageEdit: previews
        ? (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) => previews.recordMessageEdit(...args)
        : noop,
      nextMessageOrder: previews ? () => previews.nextMessageOrder() : undefined,
      consumeOwnSend: () => false,
      getStoredMessage: (id: string) => service.getMessage('s1', id),
      putStoredMessage: (m: WAMessage) => service.put('s1', m),
      updateStoredMessage: (id: string, change: (m: WAMessage) => WAMessage | null) => service.update('s1', id, change),
      removeStoredMessage: (id: string, keep: (m: WAMessage) => boolean) => service.remove('s1', id, keep),
      getOnMessage: () => (m: { id: string }) => void delivered.push(m.id),
      getOnMessageCreate: () => (m: { id: string }) => void typed.push(m.id),
      getOnMessageRevoked: () => noop,
      getOnMessageEdited: () => (e: { body: string }) => void edited.push(e.body),
      getOnMessageReaction: () => (r: { reaction: string }) => void reacted.push(r.reaction),
      getOnMessageAck: () => undefined,
      getOnMessageReceipt: () => undefined,
      getOnGroupEvent: () => undefined,
      getOnEventResponse: () => undefined,
      getOnPollVote: () => undefined,
      findContact: () => null,
      getOnCall: () => undefined,
      getOnPresenceUpdate: () => undefined,
      getOnCallOutcome: () => undefined,
    });
  }

  const deliver = (events: BaileysEvents, ...messages: WAMessage[]): void =>
    events.handleMessagesUpsert({ type: 'notify', messages });

  beforeEach(async () => {
    delivered.length = 0;
    typed.length = 0;
    edited.length = 0;
    reacted.length = 0;
    process.env.STORE_EPHEMERAL_MESSAGES = 'false';
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [BaileysStoredMessage, Session],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id: 's1',
        name: 's1',
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );
    service = new BaileysMessageStoreService(ds.getRepository(BaileysStoredMessage));
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.STORE_EPHEMERAL_MESSAGES;
    else process.env.STORE_EPHEMERAL_MESSAGES = saved;
    await ds.destroy();
  });

  it('leaves no copy of its content in the message store, and is still handed to the session', async () => {
    const events = newEvents();

    deliver(events, disappearing());
    await until(() => delivered.length === 1, 'the message to be handed on');

    expect(await copyOf('VANISH1')).toBeNull();
    expect(await countRows()).toBe(0);
  });

  it('is handed to the session again when it is delivered twice, and still stored nowhere', async () => {
    const events = newEvents();

    deliver(events, disappearing());
    await until(() => delivered.length === 1, 'the first delivery');
    deliver(events, disappearing());
    await until(() => delivered.length === 2, 'the second delivery');

    expect(delivered).toEqual(['VANISH1', 'VANISH1']);
    expect(await countRows()).toBe(0);
  });

  it.each([
    ['is on', 'true'],
    ['is not set', undefined],
  ])('keeps its copy when the flag %s', async (_when, value) => {
    if (value === undefined) delete process.env.STORE_EPHEMERAL_MESSAGES;
    else process.env.STORE_EPHEMERAL_MESSAGES = value;
    const events = newEvents();

    deliver(events, disappearing());
    await until(() => delivered.length === 1, 'the message to be handed on');

    expect((await copyOf('VANISH1'))?.key.id).toBe('VANISH1');
    expect(await countRows()).toBe(1);
  });

  it('keeps the copy of a message of a chat with no disappearing timer', async () => {
    const events = newEvents();

    deliver(events, ordinary());
    await until(() => delivered.length === 1, 'the message to be handed on');

    expect((await copyOf('KEPT1'))?.key.id).toBe('KEPT1');
  });

  it('keeps the copy of a message the account typed on its phone, which is announced and can be changed', async () => {
    const events = newEvents();

    deliver(events, disappearing('TYPED1', { participant: undefined, fromMe: true }));
    await until(() => typed.length === 1, 'the message to be handed on');

    expect((await copyOf('TYPED1'))?.key.id).toBe('TYPED1');
  });

  it('keeps the copy of a status, which the status store holds', async () => {
    const events = newEvents();

    deliver(
      events,
      received(
        'STORY1',
        { extendedTextMessage: { text: 'a story', contextInfo: { expiration: DAY } } },
        { remoteJid: 'status@broadcast' },
      ),
    );
    await until(() => delivered.length === 1, 'the status to be handed on');

    expect((await copyOf('STORY1'))?.key.id).toBe('STORY1');
  });

  describe('a change to it that arrives after it was processed', () => {
    const unreadable = (): boolean =>
      debug.mock.calls.some(
        ([message, fields]) =>
          message === 'Cannot read an encrypted edit or reaction: the message it targets is not stored' &&
          (fields as { msgId?: string } | undefined)?.msgId === 'ENC-EDIT1',
      );

    it('is read when the message was kept (the flag on)', async () => {
      process.env.STORE_EPHEMERAL_MESSAGES = 'true';
      const events = newEvents();
      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the message to be handed on');
      await copyOf('VANISH1'); // written

      deliver(events, sealedEdit('ENC-EDIT1', 'VANISH1', 'edited text'));
      await until(() => edited.length === 1, 'the encrypted edit to be announced');

      expect(edited).toEqual(['edited text']);
    });

    it('cannot be read when it is encrypted, as nothing holds the secret of the message any more', async () => {
      const events = newEvents();
      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the message to be handed on');
      await copyOf('VANISH1');

      deliver(events, sealedEdit('ENC-EDIT1', 'VANISH1', 'edited text'));
      await until(unreadable, 'the encrypted edit to be dropped as unreadable');

      expect(edited).toEqual([]);
    });

    it('is still announced when it is a plain edit or a reaction', async () => {
      const events = newEvents();
      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the message to be handed on');
      await copyOf('VANISH1');

      deliver(
        events,
        received('EDIT1', {
          protocolMessage: { type: 14, key: { id: 'VANISH1' }, editedMessage: { conversation: 'plain edit' } },
        }),
        received('REACT1', { reactionMessage: { key: { id: 'VANISH1', remoteJid: group }, text: 'thumbs up' } }),
      );
      await until(() => edited.length === 1 && reacted.length === 1, 'the plain edit and the reaction');

      expect(edited).toEqual(['plain edit']);
      expect(reacted).toEqual(['thumbs up']);
    });
  });

  describe('its text in the chat list', () => {
    const chatRow = (previews: BaileysSessionStore) => previews.listChats().find(chat => chat.id === group);

    it('is not kept as the preview, though the message still counts as the newest', async () => {
      const previews = new BaileysSessionStore(undefined, 's1');
      const events = newEvents(previews);

      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the message to be handed on');

      expect(chatRow(previews)).toMatchObject({ lastMessage: '', timestamp: 1_786_000_000 });
      expect(previews.lastInboundMessage(group)?.key.id).toBe('VANISH1');
    });

    it('is not put back by a plain edit of the message', async () => {
      const previews = new BaileysSessionStore(undefined, 's1');
      const events = newEvents(previews);
      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the message to be handed on');

      deliver(
        events,
        received('EDIT1', {
          protocolMessage: { type: 14, key: { id: 'VANISH1' }, editedMessage: { conversation: 'plain edit' } },
        }),
      );
      await until(() => edited.length === 1, 'the plain edit to be announced');

      expect(chatRow(previews)?.lastMessage).toBe('');
    });

    it('gives way to the text of a newer message', async () => {
      const previews = new BaileysSessionStore(undefined, 's1');
      const events = newEvents(previews);
      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the first message to be handed on');

      deliver(events, { ...ordinary(), messageTimestamp: 1_786_000_100 });
      await until(() => delivered.length === 2, 'the newer message to be handed on');

      expect(chatRow(previews)?.lastMessage).toBe('an ordinary message');
    });

    it('is the preview while the flag is on', async () => {
      process.env.STORE_EPHEMERAL_MESSAGES = 'true';
      const previews = new BaileysSessionStore(undefined, 's1');
      const events = newEvents(previews);

      deliver(events, disappearing());
      await until(() => delivered.length === 1, 'the message to be handed on');

      expect(chatRow(previews)?.lastMessage).toBe('this should vanish');
    });

    it('is the preview when it is the account that typed it on its phone', async () => {
      const previews = new BaileysSessionStore(undefined, 's1');
      const events = newEvents(previews);

      deliver(events, disappearing('TYPED1', { participant: undefined, fromMe: true }));
      await until(() => typed.length === 1, 'the message to be handed on');

      expect(chatRow(previews)?.lastMessage).toBe('this should vanish');
    });

    it.each([
      ['off', 'false', ''],
      ['on', 'true', 'this should vanish'],
    ])('is the preview %s when history carries it', async (_flag, value, preview) => {
      process.env.STORE_EPHEMERAL_MESSAGES = value;
      const previews = new BaileysSessionStore(undefined, 's1');
      const host = {
        getSocket: () => ({}) as WASocket,
        logger: createLogger('BaileysEphemeralStoredCopySpec'),
        loadLib: () => Promise.resolve(lib),
        normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
        toNeutralJid: (jid: string) => previews.toNeutralJid(jid),
        toEngineJid: (jid: string) => previews.toEngineJid(jid),
        extractEphemeralDuration: (msg: WAMessage) => previews.extractEphemeralDuration(msg),
        recordMessage: (
          msg: WAMessage,
          type: Parameters<BaileysSessionStore['recordMessage']>[1],
          order?: number,
          withhold?: boolean,
        ) => previews.recordMessage(msg, type, order, withhold),
        recordMessageEdit: () => undefined,
        upsertContacts: () => undefined,
        getOnHistoryMessages: () => () => Promise.resolve([]),
        getStoredWriteGeneration: () => 0,
      } as unknown as BaileysHistoryHost;

      await new BaileysHistory(host).captureHistoryMessages([disappearing()]);

      expect(chatRow(previews)?.lastMessage).toBe(preview);
    });
  });
});
