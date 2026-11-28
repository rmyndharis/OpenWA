import 'reflect-metadata';
import type { WASocket } from '@whiskeysockets/baileys';
import { DataSource } from 'typeorm';
import { waitUntil } from '../../../test/helpers/wait-until';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { ChatScopeService } from '../../modules/auth/chat-scope.service';
import { Message, MessageDirection, MessageStatus } from '../../modules/message/entities/message.entity';
import { MessageService } from '../../modules/message/message.service';
import { Session } from '../../modules/session/entities/session.entity';
import { LidMappingStoreService } from '../identity/lid-mapping-store.service';
import { LidMapping } from '../identity/lid-mapping.entity';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { BaileysSessionStore } from './baileys-session-store';

/**
 * A send addressed to `<phone>@c.us` goes out to the contact's lid when Baileys knows one, while its row is stored
 * under the phone id the caller wrote. The chat list keys that contact by the lid, so the lid thread shows the row
 * only once the phone and the lid are aliases, and that takes a reported pair. What Baileys' own mapping answers is
 * display data, and a send that went through says nothing about the pair: WhatsApp has to name that lid for that
 * phone. Real SQLite, the real mapping store, session store, message service and Baileys messaging code, on a
 * stand-in socket.
 */
const S = 'sess-lid-send';
const PHONE = '6281111111';
const LID = '111222333444';
const OTHER_PHONE = '6282222222';
const OTHER_LID = '555666777888';
/** How long a test waits for the query a send should have made, so a send that makes none fails fast. */
const WAIT_MS = 1000;

type Answer = { list: Array<{ id: string; lid?: string }> } | undefined;

class User {
  id = '';
  withId(id: string): this {
    this.id = id;
    return this;
  }
}
class Query {
  users: User[] = [];
  withLIDProtocol(): this {
    return this;
  }
  withContext(): this {
    return this;
  }
  withUser(user: User): this {
    this.users.push(user);
    return this;
  }
}

/** A socket whose own mapping holds `known` (phone digits to lid digits) while WhatsApp answers from `server`. */
const makeSock = (known: Record<string, string>, server: Record<string, string>) => {
  let sent = 0;
  return {
    onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
    sendMessage: jest.fn((jid: string) =>
      Promise.resolve({ key: { id: `OUT-${++sent}`, remoteJid: jid, fromMe: true }, messageTimestamp: 1_700_000_000 }),
    ),
    waUploadToServer: jest.fn(),
    signalRepository: {
      lidMapping: {
        getLIDForPN: jest.fn((pn: string) => {
          const lid = known[pn.split('@')[0]];
          return Promise.resolve(lid ? `${lid}@lid` : null);
        }),
      },
    },
    executeUSyncQuery: jest.fn((query: Query): Promise<Answer> =>
      Promise.resolve({
        list: query.users.map(({ id }) => {
          const lid = server[id.split('@')[0]];
          return lid ? { id, lid: `${lid}@lid` } : { id };
        }),
      }),
    ),
  };
};
type FakeSock = ReturnType<typeof makeSock>;

describe('a Baileys send to a phone id that goes out to the lid of the contact', () => {
  let ds: DataSource;
  let store: LidMappingStoreService;
  let service: MessageService;
  let known: Record<string, string>;
  let server: Record<string, string>;
  let sock: FakeSock;
  let current: FakeSock | null;
  let warn: jest.Mock;
  let messaging: BaileysMessaging;
  let writes: Set<Promise<unknown>>;
  /** The host's read of the phone a lid is reported with; a test can stand in for it. */
  let lookup: (lid: string) => Promise<string | null>;

  const makeMessaging = (queryBudgetMs?: number): BaileysMessaging => {
    const sessionStore = new BaileysSessionStore(store, S);
    const host: BaileysMessagingHost = {
      sessionProxyUrl: () => undefined,
      ensureReady: () => {
        if (!current) throw new EngineNotReadyError();
      },
      getSocket: () => {
        if (!current) throw new EngineNotReadyError();
        return current as unknown as WASocket;
      },
      getSocketOrNull: () => current as unknown as WASocket | null,
      logger: { log: jest.fn(), warn, error: jest.fn(), debug: jest.fn() } as never,
      toNeutralJid: jid => sessionStore.toNeutralJid(jid),
      toEngineJid: jid => sessionStore.toEngineJid(jid),
      // The two lines below are the adapter's own wiring of the session store and the mapping table.
      findPersistedLidPhone: lid => lookup(lid),
      recordLidMapping: (lid, pn, isReported = true) => sessionStore.addLidMappings([{ lid, pn }], isReported),
      normalizedSelfJid: () => '628000000000@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: ts => (typeof ts === 'number' ? ts : 0),
      loadLib: () => Promise.resolve({ USyncQuery: Query, USyncUser: User } as never),
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      recordMessageEdit: () => undefined,
      rememberOwnSend: () => undefined,
      getStoredMessage: () => undefined,
      updateStoredMessage: () => undefined,
      wasDeletedForEveryone: () => false,
      markDeletedForEveryone: () => undefined,
      pendingEditOf: () => undefined,
      getOnMessageCreate: () => undefined,
      mapMessage: jest.fn(),
    };
    return new BaileysMessaging(host, queryBudgetMs);
  };

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LidMapping, Session, Message],
      synchronize: true,
    }).initialize();
    await ds.getRepository(Session).insert({ id: S, name: S });
    store = new LidMappingStoreService(ds.getRepository(LidMapping));
    await store.onModuleInit();
    // The session store writes a pair through without awaiting it, so the tests await those writes themselves.
    writes = new Set();
    for (const method of ['remember', 'rememberIfUnknown'] as const) {
      const real = store[method].bind(store);
      jest.spyOn(store, method).mockImplementation((...args: Parameters<typeof store.remember>) => {
        const write = real(...(args as [string, string, string]));
        writes.add(write);
        return write;
      });
    }
    service = new MessageService(
      ds.getRepository(Message),
      {} as never,
      {} as never,
      {} as never,
      store,
      {} as never,
      {} as never,
    );
    lookup = lid => store.findPhoneForLid(lid);
    known = { [PHONE]: LID };
    server = { [PHONE]: LID };
    sock = makeSock(known, server);
    current = sock;
    warn = jest.fn();
    messaging = makeMessaging();
  });

  afterEach(async () => {
    await idle();
    jest.restoreAllMocks();
    store.onModuleDestroy();
    await ds.destroy();
  });

  /** Let a confirmation that has its answer run to its end, mapping write included. */
  const idle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await new Promise(resolve => setImmediate(resolve));
      await Promise.allSettled([...writes]);
    }
  };
  const pair = (lid = LID) => ds.getRepository(LidMapping).findOneBy({ lid });
  const reported = async (lid = LID): Promise<boolean> => (await pair(lid))?.isReported === true;
  const thread = async (chatId: string): Promise<Array<string | null>> =>
    (await service.getMessages(S, { chatId })).messages.map(message => message.waMessageId).sort();
  /** A row as the REST send path stores it: under the chat id the caller wrote. */
  const storeRow = (waMessageId: string, chatId: string, direction = MessageDirection.OUTGOING) =>
    ds.getRepository(Message).insert({
      sessionId: S,
      waMessageId,
      chatId,
      from: direction === MessageDirection.OUTGOING ? '628000000000@c.us' : chatId,
      to: direction === MessageDirection.OUTGOING ? chatId : '628000000000@c.us',
      body: 'hello',
      type: 'text',
      direction,
      timestamp: 1_700_000_000,
      status: MessageStatus.SENT,
    });
  const send = (phone = PHONE) => messaging.sendTextMessage(`${phone}@c.us`, 'hello');
  /** One of a run of contacts Baileys holds a lid for and WhatsApp names none for, so each stays unconfirmed. */
  const coldPhone = (contact: number): string => {
    const phone = `62850000${String(contact).padStart(4, '0')}`;
    known[phone] = `9990000${String(contact).padStart(4, '0')}`;
    return phone;
  };
  /** The phone jids WhatsApp was asked about, in order. */
  const asked = (on = sock): string[] =>
    on.executeUSyncQuery.mock.calls.flatMap(([query]) => query.users.map(user => user.id));
  const naming = (lid: string, phone = PHONE): Answer => ({
    list: [{ id: `${phone}@s.whatsapp.net`, lid: `${lid}@lid` }],
  });
  /** What a query WhatsApp rate-limits rejects with. */
  const throttled = (): Promise<Answer> => Promise.reject(Object.assign(new Error('rate-overlimit'), { data: 429 }));
  /** Hold the next query until the test answers it, with an answer or with a rejection. */
  const holdQuery = (): ((answer: Answer | Promise<Answer>) => void) => {
    let resolveQuery!: (answer: Answer | Promise<Answer>) => void;
    sock.executeUSyncQuery.mockImplementationOnce(
      () =>
        new Promise<Answer>(resolve => {
          resolveQuery = resolve;
        }),
    );
    return answer => resolveQuery(answer);
  };

  it('shows the sent row in the lid thread once WhatsApp confirms the pair, without holding the send', async () => {
    const answer = holdQuery();

    const sent = await send();
    await storeRow(sent.id, `${PHONE}@c.us`);

    expect(sock.sendMessage).toHaveBeenCalledWith(`${LID}@lid`, expect.anything(), expect.anything());
    await waitUntil(() => asked().length === 1, WAIT_MS);
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    await idle();
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: false });
    expect(await thread(`${LID}@lid`)).toEqual([]);
    expect(await thread(`${PHONE}@c.us`)).toEqual([sent.id]);

    answer(naming(LID));
    await waitUntil(() => reported(), WAIT_MS);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: true });
    expect(await thread(`${LID}@lid`)).toEqual([sent.id]);
    expect(await thread(`${PHONE}@c.us`)).toEqual([sent.id]);
  });

  it.each([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `${PHONE}:7@s.whatsapp.net`, `${PHONE}@C.US`])(
    'confirms the pair of a send addressed to %s',
    async chatId => {
      await messaging.sendTextMessage(chatId, 'hello');

      await waitUntil(() => reported(), WAIT_MS);
      expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
      expect(await pair()).toMatchObject({ phone: PHONE, isReported: true });
    },
  );

  it('confirms the pair after a send that is not a text', async () => {
    await messaging.sendLocationMessage(`${PHONE}@c.us`, { latitude: 1, longitude: 2 });

    await waitUntil(() => reported(), WAIT_MS);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: true });
  });

  it.each<[string, Answer]>([
    ['names another lid for the phone', naming(OTHER_LID)],
    ['names no lid for the phone', { list: [{ id: `${PHONE}@s.whatsapp.net` }] }],
    ['gives no answer', undefined],
  ])('leaves the pair display-only when WhatsApp %s', async (_label, answer) => {
    sock.executeUSyncQuery.mockResolvedValueOnce(answer);

    const sent = await send();
    await storeRow(sent.id, `${PHONE}@c.us`);

    await waitUntil(() => asked().length === 1, WAIT_MS);
    await idle();
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: false });
    expect(await thread(`${LID}@lid`)).toEqual([]);
  });

  it.each<[string, () => Promise<Answer>]>([
    ['refuses the query', () => Promise.reject(Object.assign(new Error('forbidden'), { data: 403 }))],
    ['throttles the query', () => Promise.reject(Object.assign(new Error('rate-overlimit'), { data: 429 }))],
    ['never answers the query', () => new Promise<Answer>(() => undefined)],
  ])('still resolves the send and leaves the pair display-only when WhatsApp %s', async (_label, respond) => {
    messaging = makeMessaging(20);
    sock.executeUSyncQuery.mockImplementationOnce(respond);

    await expect(send()).resolves.toMatchObject({ id: 'OUT-1' });

    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    await idle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: false });
  });

  it('asks only about a phone id that went out to a lid, and not about a pair already reported', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    await store.remember(LID, PHONE, S);

    await send();
    await messaging.sendTextMessage(`${LID}@lid`, 'addressed to the lid itself');
    await messaging.sendTextMessage('6283333333@c.us', 'no lid known');
    await messaging.sendTextMessage('120363000000000001@g.us', 'a group');
    await send(OTHER_PHONE);

    await waitUntil(() => reported(OTHER_LID), WAIT_MS);
    await idle();
    expect(asked()).toEqual([`${OTHER_PHONE}@s.whatsapp.net`]);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: true });
    expect(await pair(OTHER_LID)).toMatchObject({ phone: OTHER_PHONE, isReported: true });
  });

  it.each(['6281111111_1', '+6281111111'])(
    'asks nothing about the phone id %s@c.us, which is not a number',
    async user => {
      // The library strips what is not the number and finds the lid of the contact all the same.
      known[user] = LID;
      known[OTHER_PHONE] = OTHER_LID;
      server[OTHER_PHONE] = OTHER_LID;

      await messaging.sendTextMessage(`${user}@c.us`, 'hello');
      await send(OTHER_PHONE);

      await waitUntil(() => reported(OTHER_LID), WAIT_MS);
      await idle();
      expect(sock.sendMessage).toHaveBeenNthCalledWith(1, `${LID}@lid`, expect.anything(), expect.anything());
      expect(asked()).toEqual([`${OTHER_PHONE}@s.whatsapp.net`]);
    },
  );

  it('gives up on a read of the reported phone that never answers, and goes on to the next contact', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    messaging = makeMessaging(20);
    const read = lookup;
    lookup = jest.fn(read).mockImplementationOnce(() => new Promise<string | null>(() => undefined));

    await send();
    await send(OTHER_PHONE);

    await waitUntil(() => reported(OTHER_LID), WAIT_MS);
    await idle();
    expect(asked()).toEqual([`${OTHER_PHONE}@s.whatsapp.net`]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await reported()).toBe(false);
  });

  it('asks all the same when the lid is reported with another phone', async () => {
    lookup = () => Promise.resolve(OTHER_PHONE);

    await send();

    await waitUntil(() => reported(), WAIT_MS);
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: true });
  });

  it('asks nothing when the socket is replaced while the reported phone is read', async () => {
    const replacement = makeSock(known, server);
    let answerRead!: () => void;
    const read = jest.fn(lookup).mockImplementationOnce(
      () =>
        new Promise<string | null>(resolve => {
          answerRead = () => resolve(null);
        }),
    );
    lookup = read;

    await send();
    await waitUntil(() => read.mock.calls.length === 1, WAIT_MS);
    current = replacement;
    answerRead();

    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    await idle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(asked()).toEqual([]);
    expect(asked(replacement)).toEqual([]);
    expect(await reported()).toBe(false);
  });

  it.each<[string, (chatId: string) => Promise<unknown>]>([
    ['a text', chatId => messaging.sendTextMessage(chatId, 'hello')],
    ['a location', chatId => messaging.sendLocationMessage(chatId, { latitude: 1, longitude: 2 })],
  ])(
    'confirms the lid of the number the number check answered for %s, when it is not the number the caller wrote',
    async (_kind, sendTo) => {
      const typed = '5511987654321';
      sock.onWhatsApp.mockImplementation(() => Promise.resolve([{ jid: `${PHONE}@s.whatsapp.net`, exists: true }]));

      const sent = await sendTo(`${typed}@c.us`);

      await waitUntil(() => reported(), WAIT_MS);
      expect(sock.sendMessage).toHaveBeenCalledWith(`${LID}@lid`, expect.anything(), expect.anything());
      expect(sent).toEqual({
        id: 'OUT-1',
        timestamp: expect.any(Number) as unknown,
        resolvedChatId: `${PHONE}@c.us`,
        engineChatId: `${LID}@lid`,
      });
      expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
      expect(await pair()).toMatchObject({ phone: PHONE, isReported: true });
      expect(await ds.getRepository(LidMapping).countBy({ phone: typed })).toBe(0);
    },
  );

  it('names no number, and asks about none, when the number check answers with a lid', async () => {
    // Baileys' own mapping holds no lid for the number, so the number check runs, and answers with one.
    delete known[PHONE];
    sock.onWhatsApp.mockImplementation(() => Promise.resolve([{ jid: `${LID}@lid`, exists: true }]));

    const sent = await send();
    await idle();

    expect(sock.sendMessage).toHaveBeenCalledWith(`${LID}@lid`, expect.anything(), expect.anything());
    expect(sent).not.toHaveProperty('resolvedChatId');
    expect(sent).toHaveProperty('engineChatId', `${LID}@lid`);
    expect(asked()).toEqual([]);
  });

  it.each<[string, string, string | undefined]>([
    ['a phone id it sent to the lid of', `${PHONE}@c.us`, `${LID}@lid`],
    ['a lid it sent to', `${LID}@lid`, undefined],
    ['a phone id with no lid known', '6289999999@c.us', undefined],
    ['a group', '120363000000000001@g.us', undefined],
  ])('names the chat a send went to only when it is not the one the caller named: %s', async (_case, chatId, to) => {
    const sent = await messaging.sendTextMessage(chatId, 'hello');
    const located = await messaging.sendLocationMessage(chatId, { latitude: 1, longitude: 2 });

    for (const result of [sent, located]) {
      if (to) expect(result).toHaveProperty('engineChatId', to);
      else expect(result).not.toHaveProperty('engineChatId');
    }
  });

  it('asks once for several sends to the same contact', async () => {
    const answer = holdQuery();

    await Promise.all([send(), send()]);
    await send();
    await waitUntil(() => asked().length === 1, WAIT_MS);
    await idle();
    expect(asked()).toHaveLength(1);

    answer(naming(LID));
    await waitUntil(() => reported(), WAIT_MS);
    await send();
    await idle();
    expect(asked()).toHaveLength(1);
    expect(sock.sendMessage).toHaveBeenCalledTimes(4);
  });

  it('asks again about an unconfirmed pair only 15 minutes later, or on a new connection', async () => {
    delete server[PHONE];
    const start = 2_000_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);

    await send();
    await waitUntil(() => asked().length === 1, WAIT_MS);
    await idle();
    now.mockReturnValue(start + 15 * 60_000 - 1);
    await send();
    await idle();
    expect(asked()).toHaveLength(1);

    now.mockReturnValue(start + 15 * 60_000);
    await send();
    await waitUntil(() => asked().length === 2, WAIT_MS);
    await idle();
    expect(asked()).toHaveLength(2);

    // The lifecycle calls this when a socket is replaced or torn down.
    messaging.clearNumberIdCache();
    await send();
    await waitUntil(() => asked().length === 3, WAIT_MS);
    expect(asked()).toHaveLength(3);
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: false });
  });

  it('asks about no contact for 15 minutes after WhatsApp throttles a query, then asks about those it skipped', async () => {
    const start = 2_000_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    sock.executeUSyncQuery.mockImplementationOnce(throttled);

    await send();
    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    for (let contact = 0; contact < 50; contact++) await send(coldPhone(contact));
    await idle();
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    expect(warn).toHaveBeenCalledTimes(1);

    // A contact skipped late in the pause was not asked about, so it is not remembered as asked either.
    now.mockReturnValue(start + 15 * 60_000 - 1);
    await send(coldPhone(50));
    await idle();
    expect(asked()).toHaveLength(1);

    now.mockReturnValue(start + 15 * 60_000);
    await send(coldPhone(50));
    await send(coldPhone(0));
    await waitUntil(() => asked().length === 3, WAIT_MS);
    await idle();
    expect(asked().slice(1)).toEqual([`${coldPhone(50)}@s.whatsapp.net`, `${coldPhone(0)}@s.whatsapp.net`]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('goes on asking about other contacts after a query WhatsApp refused without rate-limiting it', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    sock.executeUSyncQuery.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('forbidden'), { data: 403 })),
    );

    await send();
    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    await send(OTHER_PHONE);

    await waitUntil(() => reported(OTHER_LID), WAIT_MS);
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`, `${OTHER_PHONE}@s.whatsapp.net`]);
  });

  it('keeps that pause when the socket is replaced: the limit is on the account, not on the connection', async () => {
    sock.executeUSyncQuery.mockImplementationOnce(throttled);

    await send();
    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    // What the lifecycle does when it replaces a socket.
    messaging.clearNumberIdCache();
    await send(coldPhone(0));
    await send();
    await idle();

    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops the confirmations waiting their turn when WhatsApp throttles the one in flight', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    const start = 2_000_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    const answer = holdQuery();

    await send();
    await send(OTHER_PHONE);
    await send(coldPhone(0));
    await waitUntil(() => asked().length === 1, WAIT_MS);
    answer(throttled());

    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    await idle();
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);
    expect(warn).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 15 * 60_000);
    await send(OTHER_PHONE);
    await waitUntil(() => reported(OTHER_LID), WAIT_MS);
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`, `${OTHER_PHONE}@s.whatsapp.net`]);
  });

  it('asks about one contact at a time during a run to cold contacts', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    const answer = holdQuery();

    await send();
    await send(OTHER_PHONE);
    await waitUntil(() => asked().length === 1, WAIT_MS);
    await idle();
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`]);

    answer(naming(LID));
    await waitUntil(() => reported(OTHER_LID), WAIT_MS);
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`, `${OTHER_PHONE}@s.whatsapp.net`]);
    expect(await reported()).toBe(true);
    expect(await reported(OTHER_LID)).toBe(true);
  });

  it('remembers the 5000 pairs it asked about last, by the time each was last asked about', async () => {
    delete server[PHONE];
    const start = 2_000_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    await send();
    await waitUntil(() => asked().length === 1, WAIT_MS);

    // Asked about again 15 minutes later, after another pair: of the two it is now the one asked about last.
    now.mockReturnValue(start + 15 * 60_000);
    await send(coldPhone(0));
    await send();
    for (let contact = 1; contact < 5000; contact++) {
      await send(coldPhone(contact));
      // The sends of this loop outrun the confirmations, which wait their turn 1000 at most.
      if (contact % 500 === 0) await waitUntil(() => asked().length === contact + 3, 30_000);
    }
    await waitUntil(() => asked().length === 5002, 30_000);
    expect(asked()).toHaveLength(5002);

    now.mockReturnValue(start + 15 * 60_000 + 1000);
    await send();
    await send(coldPhone(0));
    await waitUntil(() => asked().length === 5003, WAIT_MS);
    await idle();
    expect(asked()).toHaveLength(5003);
    expect(asked().at(-1)).toBe(`${coldPhone(0)}@s.whatsapp.net`);
  }, 60_000);

  it('lets at most 1000 confirmations wait while a query is out', async () => {
    const answer = holdQuery();

    await send();
    for (let contact = 0; contact <= 1000; contact++) await send(coldPhone(contact));

    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(asked()).toHaveLength(1);
    answer(naming(LID));
    await waitUntil(() => asked().length === 1001, 10_000);
    await idle();
    expect(asked()).toHaveLength(1001);
    expect(asked()).not.toContain(`${coldPhone(1000)}@s.whatsapp.net`);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1002);
  }, 30_000);

  it.each(['replaced', 'stopped'])('records nothing when the socket was %s before WhatsApp answered', async state => {
    const answer = holdQuery();
    const replacement = makeSock(known, server);

    await send();
    await waitUntil(() => asked().length === 1, WAIT_MS);
    expect(asked()).toHaveLength(1);
    current = state === 'replaced' ? replacement : null;
    answer(naming(LID));

    await waitUntil(() => warn.mock.calls.length === 1, WAIT_MS);
    await idle();
    expect(await pair()).toMatchObject({ phone: PHONE, isReported: false });
    expect(asked(replacement)).toEqual([]);
  });

  it('asks once about a pair whose confirmation waited its turn for more than 15 minutes', async () => {
    const start = 2_000_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    const answer = holdQuery();

    await send();
    await send(coldPhone(0));
    await waitUntil(() => asked().length === 1, WAIT_MS);
    now.mockReturnValue(start + 15 * 60_000);
    await send(coldPhone(0));
    answer(naming(LID));

    await waitUntil(() => asked().length >= 2, WAIT_MS);
    await idle();
    expect(asked()).toEqual([`${PHONE}@s.whatsapp.net`, `${coldPhone(0)}@s.whatsapp.net`]);
  });

  it('forgets the confirmations waiting their turn with their socket, without a line for each', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    const answer = holdQuery();
    const replacement = makeSock(known, server);

    await send();
    await send(OTHER_PHONE);
    await send(coldPhone(0));
    await waitUntil(() => asked().length === 1, WAIT_MS);
    // What the lifecycle does when it replaces a socket.
    current = replacement;
    messaging.clearNumberIdCache();
    answer(naming(LID));

    await waitUntil(() => warn.mock.calls.length >= 1, WAIT_MS);
    await idle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(asked()).toHaveLength(1);
    expect(asked(replacement)).toEqual([]);
    expect(await reported()).toBe(false);
    expect(await reported(OTHER_LID)).toBe(false);
  });

  it('drops a confirmation still waiting its turn when the socket is replaced', async () => {
    known[OTHER_PHONE] = OTHER_LID;
    server[OTHER_PHONE] = OTHER_LID;
    const answer = holdQuery();
    const replacement = makeSock(known, server);

    await send();
    await send(OTHER_PHONE);
    await waitUntil(() => asked().length === 1, WAIT_MS);
    expect(asked()).toHaveLength(1);
    current = replacement;
    answer(naming(LID));

    await waitUntil(() => warn.mock.calls.length === 2, WAIT_MS);
    await idle();
    expect(asked()).toHaveLength(1);
    expect(asked(replacement)).toEqual([]);
    expect(await reported()).toBe(false);
    expect(await reported(OTHER_LID)).toBe(false);
  });

  describe('a send that went through is not evidence of the pair', () => {
    // Each prior state of the lid's row, and the phone that row holds once the send's own lookup has written.
    const pairs: Array<[string, () => Promise<unknown>, string]> = [
      ['only a lookup produced', () => store.rememberIfUnknown(LID, PHONE, S), PHONE],
      [
        'a conflicting lookup revoked',
        async () => {
          await store.remember(LID, PHONE, S);
          await store.rememberIfUnknown(LID, OTHER_PHONE, S);
        },
        PHONE,
      ],
      ['an engine reported with another phone', () => store.remember(LID, OTHER_PHONE, S), OTHER_PHONE],
    ];
    const answers: Array<[string, () => Promise<Answer>]> = [
      ['throttles the query', () => Promise.reject(Object.assign(new Error('rate-overlimit'), { data: 429 }))],
      ['names another lid for the phone', () => Promise.resolve(naming(OTHER_LID))],
    ];

    it.each(
      pairs.flatMap(([held, seed, phone]) =>
        answers.map(([answer, respond]) => [held, answer, seed, respond, phone] as const),
      ),
    )('keeps a pair %s out of the aliases when WhatsApp %s', async (_held, _answer, seed, respond, phone) => {
      await seed();
      await storeRow('IN-LID', `${LID}@lid`, MessageDirection.INCOMING);
      sock.executeUSyncQuery.mockImplementation(respond);

      await send();
      await send();

      await waitUntil(() => asked().length === 1, WAIT_MS);
      await idle();
      expect(asked()).toHaveLength(1);
      expect(sock.sendMessage).toHaveBeenCalledTimes(2);
      expect(await pair()).toMatchObject({ phone, isReported: false });
      expect(await store.findPhoneForLid(`${LID}@lid`)).toBeNull();
      expect(await store.findLidsForPhone(PHONE)).toEqual([]);
      expect(await thread(`${PHONE}@c.us`)).toEqual([]);
      expect(await new ChatScopeService(store).allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(false);
    });
  });
});
