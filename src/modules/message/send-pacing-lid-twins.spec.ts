import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type Logger, type Repository } from 'typeorm';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { SendPacingService } from './send-pacing.service';
import { computeSendPacingConfig, type SendPacingConfig } from './send-pacing.config';

/**
 * Both engines store a one-to-one chat under the id WhatsApp delivers it with, and for a contact that moved to a
 * privacy id that is `<lid>@lid`; a client that knows the contact by phone answers to `<phone>@c.us`, and a REST
 * send stores the id it was given. When the gateway holds the reported pairing (the lid table every other chat
 * filter reads), the two are one contact, and the cold-reachout rule has to see it: a reply to someone who wrote
 * first is never counted and never refused, whichever form the history or the reply uses.
 *
 * Real tables and the real lid store. SQLite in memory; on PostgreSQL (DATABASE_TYPE=postgres, the test-postgres
 * job) a schema of its own. Rows go in through the repositories with generated ids and Date values, which both
 * dialects take.
 */
describe('cold-reachout rule for a contact stored under both its phone and its lid', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };

  const DAY_MS = 86_400_000;
  const NOW = new Date('2026-08-03T12:00:00.000Z');
  const YESTERDAY = '2026-08-02T09:00:00.000Z';
  const MORNING = '2026-08-03T07:00:00.000Z';
  const EARLY = '2026-08-03T08:00:00.000Z';
  const LATER = '2026-08-03T08:30:00.000Z';
  const NINE = '2026-08-03T09:00:00.000Z';
  const LID = '187654321098765';
  const SECOND_LID = '187654321000002';
  const PHONE = '6281234567890';
  const STRANGER = '6289900000001@c.us';
  const OTHER_STRANGER = '6289900000002@c.us';

  let ds: DataSource;
  let schema = '';
  let messages: Repository<Message>;
  let sessions: Repository<Session>;
  let lids: Repository<LidMapping>;
  let store: LidMappingStoreService;
  let sessionId: string;
  let pacing: SendPacingConfig;
  let lidsOfPhones: jest.SpiedFunction<LidMappingStoreService['lidsForPhonesPersisted']>;
  let phonesOfLids: jest.SpiedFunction<LidMappingStoreService['phonesForLidsPersisted']>;
  let singleReads: jest.SpyInstance[];
  /** The statements the connection runs while a case records them; null when none does. */
  let recorded: string[] | null = null;
  const recorder: Logger = {
    logQuery: query => void recorded?.push(query),
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };

  const onServer = async (sql: string): Promise<void> => {
    const admin = await new DataSource(server).initialize();
    await admin.query(sql).finally(() => admin.destroy());
  };

  const add = (chatId: string, at: string, direction = MessageDirection.OUTGOING): Promise<unknown> =>
    messages.insert({
      id: randomUUID(),
      sessionId,
      chatId,
      from: 'a',
      to: 'b',
      type: 'text',
      direction,
      createdAt: new Date(at),
    });

  /** The pairing the gateway holds for a contact; `isReported: false` is a display-only lookup. */
  const pair = (lid = LID, phone = PHONE, isReported = true): Promise<unknown> =>
    lids.insert({ lid, phone, sessionId: null, isReported });

  const build = async (withStore = true): Promise<SendPacingService> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SendPacingService,
        { provide: getRepositoryToken(Message, 'data'), useValue: messages },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessions },
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'sendPacing' ? pacing : undefined) } },
        ...(withStore ? [{ provide: LidMappingStoreService, useValue: store }] : []),
      ],
    }).compile();
    return moduleRef.get(SendPacingService);
  };

  const calls = (spies: jest.SpyInstance[]): number => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);

  /** The day's count of cold reachouts, as the send paths read it, and how many statements it took. */
  const countToday = async (service: SendPacingService): Promise<{ count: number; statements: number }> => {
    const counter = service as unknown as { countColdReachoutsToday(session: string, dayStart: Date): Promise<number> };
    recorded = [];
    const count = await counter.countColdReachoutsToday(sessionId, new Date('2026-08-03T00:00:00.000Z'));
    const statements = recorded.length;
    recorded = null;
    return { count, statements };
  };

  /** `n` contacts known by phone and lid, each written to under its lid at `lidAt` and replied to by phone at nine. */
  const seedRepliedContacts = async (n: number, lidAt: string, direction: MessageDirection): Promise<void> => {
    const row = (chatId: string, at: string, dir: MessageDirection) => ({
      id: randomUUID(),
      sessionId,
      chatId,
      from: 'a',
      to: 'b',
      type: 'text',
      direction: dir,
      createdAt: new Date(at),
    });
    for (let first = 0; first < n; first += 200) {
      const part = Array.from({ length: Math.min(200, n - first) }, (_, k) => first + k).map(i => ({
        phone: `62814${String(i).padStart(8, '0')}`,
        lid: `17${String(i).padStart(13, '0')}`,
      }));
      await lids.insert(part.map(({ lid, phone }) => ({ lid, phone, sessionId: null, isReported: true })));
      await messages.insert(
        part.flatMap(({ lid, phone }) => [
          row(`${lid}@lid`, lidAt, direction),
          row(`${phone}@c.us`, NINE, MessageDirection.OUTGOING),
        ]),
      );
    }
  };

  beforeEach(async () => {
    // Only the clock is faked: the PostgreSQL driver keeps its real timers.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'performance',
        'hrtime',
      ],
    });
    const entities = [Message, Session, LidMapping];
    if (pg) {
      schema = `pacing_lid_${randomUUID().replace(/-/g, '')}`;
      await onServer(`CREATE SCHEMA "${schema}"`);
    }
    ds = await new DataSource(
      pg
        ? {
            ...server,
            schema,
            extra: { options: `-c search_path=${schema},public` },
            entities,
            synchronize: true,
            logging: ['query'],
            logger: recorder,
          }
        : {
            type: 'better-sqlite3',
            database: ':memory:',
            entities,
            synchronize: true,
            logging: ['query'],
            logger: recorder,
          },
    ).initialize();
    messages = ds.getRepository(Message);
    sessions = ds.getRepository(Session);
    lids = ds.getRepository(LidMapping);
    // Old enough that only the cold rule can refuse anything.
    sessionId = (await sessions.save({ name: 'bot', createdAt: new Date(NOW.getTime() - 30 * DAY_MS) })).id;
    store = new LidMappingStoreService(lids);
    lidsOfPhones = jest.spyOn(store, 'lidsForPhonesPersisted');
    phonesOfLids = jest.spyOn(store, 'phonesForLidsPersisted');
    singleReads = [jest.spyOn(store, 'findLidsForPhone'), jest.spyOn(store, 'findPhoneForLid')];
    pacing = { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [10_000], coldSchedule: [1] };
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await ds.destroy();
    if (pg) await onServer(`DROP SCHEMA "${schema}" CASCADE`);
  });

  describe('the check of a single send', () => {
    beforeEach(async () => {
      // The day's one cold reachout is already spent on a real stranger.
      await add(STRANGER, NINE);
      await pair();
    });

    it('lets a reply addressed by phone through when the contact wrote first under its lid', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).resolves.toBeInstanceOf(Function);
    });

    it('lets a reply through when the contact wrote first earlier today', async () => {
      await add(`${LID}@lid`, EARLY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).resolves.toBeInstanceOf(Function);
    });

    it.each(['c.us', 's.whatsapp.net'])(
      'lets a send addressed by lid through when the history is stored under the phone as @%s',
      async dialect => {
        await add(`${PHONE}@${dialect}`, YESTERDAY, MessageDirection.INCOMING);
        const service = await build();

        await expect(service.assertSendAllowed(sessionId, `${LID}@lid`)).resolves.toBeInstanceOf(Function);
      },
    );

    it('lets a send through when the only history is a message we sent to the other form', async () => {
      await add(`${LID}@lid`, YESTERDAY);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@s.whatsapp.net`)).resolves.toBeInstanceOf(Function);
    });

    it('still refuses a first message to a contact with no history under any form', async () => {
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).rejects.toMatchObject({ status: 429 });
    });

    it('treats a lid with no pairing as a separate chat', async () => {
      await lids.clear();
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).rejects.toMatchObject({ status: 429 });
    });

    it('treats a pairing that was only looked up, never reported, as a separate chat', async () => {
      await lids.update({ lid: LID }, { isReported: false });
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).rejects.toMatchObject({ status: 429 });
    });

    it('does not mix up two contacts when only one of them is paired', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, '6281999999999@c.us')).rejects.toMatchObject({ status: 429 });
    });

    it('sees history under another lid of the same phone from the phone, not from the first lid', async () => {
      await pair(SECOND_LID);
      await add(`${SECOND_LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).resolves.toBeInstanceOf(Function);
      await expect(service.assertSendAllowed(sessionId, `${LID}@lid`)).rejects.toMatchObject({ status: 429 });
    });

    it('knows nothing of the lid table when none is wired', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build(false);

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@c.us`)).rejects.toMatchObject({ status: 429 });
    });

    it('does not read the lid table when the chat itself has history', async () => {
      await add(`${PHONE}@c.us`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, `${PHONE}@s.whatsapp.net`)).resolves.toBeInstanceOf(Function);

      expect(calls([lidsOfPhones, phonesOfLids, ...singleReads])).toBe(0);
    });

    it('does not read the lid table when pacing is off', async () => {
      pacing.enabled = false;
      const service = await build();

      await service.assertSendAllowed(sessionId, `${PHONE}@c.us`);

      expect(calls([lidsOfPhones, phonesOfLids, ...singleReads])).toBe(0);
    });

    it('does not read the lid table when the cold rule is off', async () => {
      pacing.coldSchedule = [];
      const service = await build();

      await service.assertSendAllowed(sessionId, `${PHONE}@c.us`);

      expect(calls([lidsOfPhones, phonesOfLids, ...singleReads])).toBe(0);
    });
  });

  describe("the day's count of cold reachouts", () => {
    beforeEach(async () => {
      await pair();
    });

    it('does not spend the budget on a reply already sent by phone to a contact who wrote first under its lid', async () => {
      pacing.coldSchedule = [2];
      await add(STRANGER, NINE);
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('does not count the chat of a contact whose other form only has our own message from before today', async () => {
      pacing.coldSchedule = [2];
      await add(STRANGER, NINE);
      await add(`${LID}@lid`, YESTERDAY);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('does not spend the budget on a reply to a contact who wrote first today', async () => {
      pacing.coldSchedule = [2];
      await add(STRANGER, MORNING);
      await add(`${LID}@lid`, EARLY, MessageDirection.INCOMING);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('counts a contact reached by lid, then answered and replied to by phone, once', async () => {
      pacing.coldSchedule = [3];
      await add(STRANGER, MORNING);
      await add(`${LID}@lid`, EARLY);
      await add(`${LID}@lid`, LATER, MessageDirection.INCOMING);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      // Two of three used: the stranger and the contact we reached first.
      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('keeps counting a contact we reached first when the answer arrives under the other form', async () => {
      pacing.coldSchedule = [2];
      await add(STRANGER, MORNING);
      await add(`${PHONE}@c.us`, EARLY);
      await add(`${LID}@lid`, LATER, MessageDirection.INCOMING);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      // The answered reachout is still ours: two of two used.
      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).rejects.toMatchObject({ status: 429 });
    });

    it('keeps counting a chat when the answer under the other form arrives at the very instant of our first message', async () => {
      pacing.coldSchedule = [2];
      await add(STRANGER, MORNING);
      await add(`${LID}@lid`, NINE, MessageDirection.INCOMING);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      // A tie stays cold: two of two used.
      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).rejects.toMatchObject({ status: 429 });
    });

    it('counts a contact reached under both forms before any answer once', async () => {
      pacing.coldSchedule = [3];
      await add(STRANGER, MORNING);
      await add(`${PHONE}@c.us`, EARLY);
      await add(`${LID}@lid`, NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('reads a send to the other form of a contact already reached as known', async () => {
      pacing.coldSchedule = [2];
      await add(STRANGER, MORNING);
      await add(`${PHONE}@c.us`, EARLY);
      const service = await build();

      // Both reachouts of the day are spent, and the second form of the same contact is not a third.
      await expect(service.assertSendAllowed(sessionId, `${LID}@lid`)).resolves.toBeInstanceOf(Function);
      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).rejects.toMatchObject({ status: 429 });
    });

    it('counts a phone with two lids once', async () => {
      pacing.coldSchedule = [3];
      await pair(SECOND_LID);
      await add(STRANGER, MORNING);
      await add(`${LID}@lid`, EARLY);
      await add(`${SECOND_LID}@lid`, NINE);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('keeps counting a lid with no pairing as its own chat', async () => {
      pacing.coldSchedule = [3];
      await lids.clear();
      await add(STRANGER, MORNING);
      await add(`${LID}@lid`, EARLY);
      await add(`${PHONE}@c.us`, NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).rejects.toMatchObject({ status: 429 });
    });

    it('reads the lid table for all the chats of the day together, not once per chat', async () => {
      pacing.coldSchedule = [10];
      for (let i = 0; i < 5; i++) await add(`62811100000${i}@c.us`, NINE);
      const service = await build();

      await service.assertSendAllowed(sessionId, OTHER_STRANGER);

      // The send's own contact is read singly; the five chats of the day in one batch.
      expect(calls(singleReads)).toBe(1);
      expect(lidsOfPhones.mock.calls).toHaveLength(1);
      expect(lidsOfPhones.mock.calls[0][0]).toHaveLength(5);
    });

    describe('statements', () => {
      it('reads replies to contacts with older history under the other form in three statements while the ids fit one chunk', async () => {
        await seedRepliedContacts(12, YESTERDAY, MessageDirection.INCOMING);
        const service = await build();

        // The chats of the day, their lids, and which of those lids have history from before today.
        await expect(countToday(service)).resolves.toEqual({ count: 0, statements: 3 });
      });

      it('splits the reads into chunks past 500 chats and still counts nothing for those replies', async () => {
        await seedRepliedContacts(501, YESTERDAY, MessageDirection.INCOMING);
        const service = await build();

        // Two chunks of lids of the phones and two chunks of the history read, around the list of the chats.
        await expect(countToday(service)).resolves.toEqual({ count: 0, statements: 5 });
      });

      it('spends one more statement on each contact that first appears today under the other form', async () => {
        await seedRepliedContacts(4, EARLY, MessageDirection.INCOMING);
        const service = await build();

        await expect(countToday(service)).resolves.toEqual({ count: 0, statements: 3 + 4 });
      });

      it('checks a contact reached under both forms once', async () => {
        await add(`${PHONE}@c.us`, EARLY);
        await add(`${LID}@lid`, NINE);
        const service = await build();

        // The chats, the lids of the phone and the phone of the lid, the history read, and one check.
        await expect(countToday(service)).resolves.toEqual({ count: 1, statements: 5 });
      });
    });

    // The cases below involve no lid at all: this count has no other run against a real PostgreSQL.
    it('counts a stranger reached under both user dialects once, and a contact known since yesterday not at all', async () => {
      pacing.coldSchedule = [3];
      await add('628555@s.whatsapp.net', YESTERDAY);
      await add('628555@c.us', NINE);
      await add('628777@c.us', NINE);
      await add('628777@s.whatsapp.net', NINE);
      await add('628999@c.us', NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('does not count a reply to someone who wrote first today, and counts a reachout that was answered', async () => {
      pacing.coldSchedule = [3];
      await add('628111@c.us', EARLY, MessageDirection.INCOMING);
      await add('628111@c.us', NINE);
      await add('628222@c.us', NINE);
      await add('628333@c.us', EARLY);
      await add('628333@c.us', LATER, MessageDirection.INCOMING);
      const service = await build();

      // Two of three used: the answered reply counts nothing, the answered reachout still counts.
      await expect(service.assertSendAllowed(sessionId, STRANGER)).resolves.toBeInstanceOf(Function);
    });

    it('refuses a stranger once the reachouts that were not replies have used the day', async () => {
      pacing.coldSchedule = [3];
      await add('628111@c.us', EARLY, MessageDirection.INCOMING);
      await add('628111@c.us', NINE);
      await add('628222@c.us', NINE);
      await add('628333@c.us', EARLY);
      await add('628333@c.us', LATER, MessageDirection.INCOMING);
      await add('628444@c.us', NINE);
      const service = await build();

      await expect(service.assertSendAllowed(sessionId, STRANGER)).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('adding participants to a group', () => {
    beforeEach(async () => {
      await add(STRANGER, NINE);
      await pair();
    });

    it('does not charge a participant addressed by phone whose history is under the lid', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertReachoutAllowed(sessionId, [`${PHONE}@c.us`])).resolves.toMatchObject({
        coldCount: 0,
      });
    });

    it('does not charge a participant addressed by lid whose history is under the phone', async () => {
      await add(`${PHONE}@s.whatsapp.net`, YESTERDAY);
      const service = await build();

      await expect(service.assertReachoutAllowed(sessionId, [`${LID}@lid`])).resolves.toMatchObject({ coldCount: 0 });
    });

    it('still charges a participant with no history under any form', async () => {
      const service = await build();

      await expect(service.assertReachoutAllowed(sessionId, [`${PHONE}@c.us`])).rejects.toMatchObject({ status: 429 });
    });

    it('charges a participant named by one lid when the history is stored only under another lid of its phone', async () => {
      pacing.coldSchedule = [10];
      await pair(SECOND_LID);
      await add(`${SECOND_LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      await expect(service.assertReachoutAllowed(sessionId, [`${PHONE}@c.us`])).resolves.toMatchObject({
        coldCount: 0,
      });
      await expect(service.assertReachoutAllowed(sessionId, [`${LID}@lid`])).resolves.toMatchObject({ coldCount: 1 });
    });

    it('charges a request that names one contact by both its phone and its lid twice', async () => {
      pacing.coldSchedule = [10];
      const service = await build();

      await expect(service.assertReachoutAllowed(sessionId, [`${PHONE}@c.us`, `${LID}@lid`])).resolves.toMatchObject({
        coldCount: 2,
      });
    });

    it('reads the lid table once for the whole batch', async () => {
      pacing.coldSchedule = [10];
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      const service = await build();

      const participants = [`${PHONE}@c.us`, '6281222222222@c.us', '6281333333333@c.us', `${LID}@lid`];
      await expect(service.assertReachoutAllowed(sessionId, participants)).resolves.toMatchObject({ coldCount: 2 });

      expect(calls(singleReads)).toBe(0);
      expect(lidsOfPhones.mock.calls[0][0]).toEqual([PHONE, '6281222222222', '6281333333333']);
      expect(phonesOfLids.mock.calls[0][0]).toEqual([LID]);
    });
  });
});
