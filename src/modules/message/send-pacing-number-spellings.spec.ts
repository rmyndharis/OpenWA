import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type Logger, type Repository } from 'typeorm';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { computeSendPacingConfig, type SendPacingConfig } from './send-pacing.config';
import { SendPacingService } from './send-pacing.service';

/**
 * WhatsApp holds some numbers under other digits than people write (a Brazilian mobile with or without its ninth
 * digit), and a send is stored under the number WhatsApp holds, where the contact's own messages arrive. A caller
 * that goes on writing the other spelling is still talking to a contact the account knows, so the cold-reachout
 * rule has to find that history: such a send is never counted as a new conversation and never refused as one.
 *
 * Real tables and the real lid store, SQLite in memory.
 */
describe('cold-reachout rule for a number written in its other spelling', () => {
  const DAY_MS = 86_400_000;
  const NOW = new Date('2026-08-03T12:00:00.000Z');
  const YESTERDAY = '2026-08-02T09:00:00.000Z';
  const EIGHT = '2026-08-03T08:00:00.000Z';
  const NINE = '2026-08-03T09:00:00.000Z';
  /** The number as the caller writes it, and as WhatsApp holds it. */
  const WRITTEN = '5511987654321';
  const HELD = '551187654321';
  const LID = '187654321098765';
  const STRANGER = '6289900000001@c.us';
  const OTHER_STRANGER = '6289900000002@c.us';

  let ds: DataSource;
  let messages: Repository<Message>;
  let sessions: Repository<Session>;
  let lids: Repository<LidMapping>;
  let store: LidMappingStoreService;
  let service: SendPacingService;
  let sessionId: string;
  let pacing: SendPacingConfig;
  let lidReads: jest.SpyInstance[];
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
  const pair = (phone: string, isReported = true): Promise<unknown> =>
    lids.insert({ lid: LID, phone, sessionId: null, isReported });
  const countToday = (): Promise<number> =>
    (
      service as unknown as { countColdReachoutsToday(session: string, dayStart: Date): Promise<number> }
    ).countColdReachoutsToday(sessionId, new Date('2026-08-03T00:00:00.000Z'));
  const refused = { status: 429 };

  beforeEach(async () => {
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
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session, LidMapping],
      synchronize: true,
      logging: ['query'],
      logger: recorder,
    }).initialize();
    messages = ds.getRepository(Message);
    sessions = ds.getRepository(Session);
    lids = ds.getRepository(LidMapping);
    // Old enough that only the cold rule can refuse anything.
    sessionId = (await sessions.save({ name: 'bot', createdAt: new Date(NOW.getTime() - 30 * DAY_MS) })).id;
    store = new LidMappingStoreService(lids);
    lidReads = (
      ['findLidsForPhone', 'findPhoneForLid', 'lidsForPhonesPersisted', 'phonesForLidsPersisted'] as const
    ).map(method => jest.spyOn(store, method));
    pacing = { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [10_000], coldSchedule: [1] };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SendPacingService,
        { provide: getRepositoryToken(Message, 'data'), useValue: messages },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessions },
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'sendPacing' ? pacing : undefined) } },
        { provide: LidMappingStoreService, useValue: store },
      ],
    }).compile();
    service = moduleRef.get(SendPacingService);
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await ds.destroy();
  });

  describe('with the cold reachout of the day spent on a stranger', () => {
    beforeEach(() => add(STRANGER, NINE));

    it.each([
      ['@c.us', '@c.us'],
      ['@c.us', '@s.whatsapp.net'],
      ['@s.whatsapp.net', '@c.us'],
      ['@s.whatsapp.net', '@s.whatsapp.net'],
    ])(
      'lets a send to the written spelling (%s) through after an earlier one was stored under the held number (%s)',
      async (written, stored) => {
        await add(`${HELD}${stored}`, YESTERDAY);

        await expect(service.assertSendAllowed(sessionId, `${WRITTEN}${written}`)).resolves.toBeDefined();
      },
    );

    it('finds that history with the one indexed probe, without reading the lid table', async () => {
      await add(`${HELD}@c.us`, YESTERDAY);

      recorded = [];
      await service.assertSendAllowed(sessionId, `${WRITTEN}@c.us`);
      const probes = recorded.filter(statement => statement.includes('"chatId"'));
      recorded = null;

      expect(probes).toHaveLength(1);
      expect(lidReads.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0);
    });

    it('lets an answer in the written spelling through when the contact wrote first, under the held number', async () => {
      await add(`${HELD}@c.us`, YESTERDAY, MessageDirection.INCOMING);

      await expect(service.assertSendAllowed(sessionId, `${WRITTEN}@c.us`)).resolves.toBeDefined();
    });

    it('lets it through when the contact wrote first under the lid reported for the held number', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      await pair(HELD);

      await expect(service.assertSendAllowed(sessionId, `${WRITTEN}@c.us`)).resolves.toBeDefined();
    });

    it('still refuses it when that lid is only a display lookup of the held number', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      await pair(HELD, false);

      await expect(service.assertSendAllowed(sessionId, `${WRITTEN}@c.us`)).rejects.toMatchObject(refused);
    });

    it('lets a send to the held number through when a row of an earlier release sits under the written spelling', async () => {
      await add(`${WRITTEN}@c.us`, YESTERDAY);

      await expect(service.assertSendAllowed(sessionId, `${HELD}@c.us`)).resolves.toBeDefined();
    });

    it('lets a send addressed to the lid through when the history is under the spelling its pair does not name', async () => {
      // The pair names the held number; the row is one an earlier release stored as the caller wrote it.
      await pair(HELD);
      await add(`${WRITTEN}@c.us`, YESTERDAY);

      await expect(service.assertSendAllowed(sessionId, `${LID}@lid`)).resolves.toBeDefined();
    });

    it('treats a number no rule covers as before: another number is a stranger, the same one is not', async () => {
      await add('6281234567890@c.us', YESTERDAY);

      await expect(service.assertSendAllowed(sessionId, '62812345678901@c.us')).rejects.toMatchObject(refused);
      await expect(service.assertSendAllowed(sessionId, '6281234567890@s.whatsapp.net')).resolves.toBeDefined();
    });

    it('reads no number out of an id that is not a plain number', async () => {
      await add('551187654321@c.us', YESTERDAY);
      await add('120363000000000001@g.us', YESTERDAY);

      // Their digits, read as a number, would be that Brazilian mobile in its other spelling.
      await expect(service.assertSendAllowed(sessionId, 'x5511987654321@c.us')).rejects.toMatchObject(refused);
      await expect(service.assertSendAllowed(sessionId, '5511987654321@g.us')).rejects.toMatchObject(refused);
    });

    it('does not charge a group add in the written spelling when the history is under the lid of the held number', async () => {
      await add(`${LID}@lid`, YESTERDAY, MessageDirection.INCOMING);
      await pair(HELD);

      await expect(service.assertReachoutAllowed(sessionId, [`${WRITTEN}@c.us`])).resolves.toBeDefined();
    });

    it('does not charge a group add of the contact named in its written spelling', async () => {
      await add(`${HELD}@c.us`, YESTERDAY, MessageDirection.INCOMING);

      await expect(service.assertReachoutAllowed(sessionId, [`${WRITTEN}@c.us`])).resolves.toBeDefined();
      await expect(service.assertReachoutAllowed(sessionId, [OTHER_STRANGER])).rejects.toMatchObject(refused);
    });
  });

  describe('a number WhatsApp resolves by a rule the gateway does not know', () => {
    /** As a caller writes it and as WhatsApp answered a send to it: no rule of the three folds these. */
    const WROTE = '6281234567890@c.us';
    const RESOLVED = '628123456789@c.us';
    beforeEach(() => add(STRANGER, NINE));

    it('is a stranger in the written spelling until a send has shown what it resolves to', async () => {
      await add(RESOLVED, YESTERDAY);
      await expect(service.assertSendAllowed(sessionId, WROTE)).rejects.toMatchObject(refused);

      service.rememberResolvedNumber(sessionId, '6281234567890:7@s.whatsapp.net', RESOLVED);

      await expect(service.assertSendAllowed(sessionId, WROTE)).resolves.toBeDefined();
      await expect(service.assertSendAllowed(sessionId, '6281234567890@s.whatsapp.net')).resolves.toBeDefined();
    });

    it('reads the history under the lid a send to the written id was filed under', async () => {
      await add(`${LID}@lid`, YESTERDAY);
      await expect(service.assertSendAllowed(sessionId, WROTE)).rejects.toMatchObject(refused);

      service.rememberResolvedNumber(sessionId, WROTE, `${LID}@lid`);

      await expect(service.assertSendAllowed(sessionId, WROTE)).resolves.toBeDefined();
    });

    it('is remembered for the session whose send showed it, and for no other', async () => {
      const other = (await sessions.save({ name: 'other', createdAt: new Date(NOW.getTime() - 30 * DAY_MS) })).id;
      await add(RESOLVED, YESTERDAY);

      service.rememberResolvedNumber(other, WROTE, RESOLVED);

      await expect(service.assertSendAllowed(sessionId, WROTE)).rejects.toMatchObject(refused);
    });

    it('lets a send to the resolved number through on a row of an earlier release under the written id', async () => {
      await add(WROTE, YESTERDAY);
      await expect(service.assertSendAllowed(sessionId, RESOLVED)).rejects.toMatchObject(refused);

      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);

      await expect(service.assertSendAllowed(sessionId, RESOLVED)).resolves.toBeDefined();
    });

    it('keeps the count of the day in step with that', async () => {
      // The send of today was stored under the resolved number; the history is under the written id.
      await add(WROTE, YESTERDAY);
      await add(RESOLVED, NINE);
      expect(await countToday()).toBe(2);

      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);

      expect(await countToday()).toBe(1);
    });

    it('counts a contact once whose failed first attempt is under the written id and the retry under the resolved one', async () => {
      await add(WROTE, EIGHT);
      await messages.update({ chatId: WROTE }, { status: MessageStatus.FAILED });
      await add(RESOLVED, NINE);

      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);

      // The stranger and this contact.
      expect(await countToday()).toBe(2);
    });

    it('charges a group add that names the written and the resolved id once', async () => {
      // One of the two slots is spent on the stranger: charged as two, the add would be refused.
      pacing.coldSchedule = [2];
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);

      await expect(service.assertReachoutAllowed(sessionId, [WROTE, RESOLVED])).resolves.toBeDefined();
      await expect(service.assertReachoutAllowed(sessionId, [OTHER_STRANGER])).rejects.toMatchObject(refused);
    });

    it.each([
      ['pacing is off', { enabled: false }],
      ['no cold cap is set', { coldSchedule: [] }],
    ])('notes nothing while %s', async (_case, off: Partial<SendPacingConfig>) => {
      await add(RESOLVED, YESTERDAY);
      const on = pacing;
      pacing = { ...on, ...off };
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      pacing = on;

      await expect(service.assertSendAllowed(sessionId, WROTE)).rejects.toMatchObject(refused);
    });

    it('notes no number the spelling rule already folds, so such sends push no note out', async () => {
      await add(RESOLVED, YESTERDAY);
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      for (let other = 0; other < 1000; other++) {
        const line = String(other).padStart(8, '0');
        service.rememberResolvedNumber(sessionId, `55119${line}@c.us`, `5511${line}@c.us`);
      }

      await expect(service.assertSendAllowed(sessionId, WROTE)).resolves.toBeDefined();
    });

    it('remembers them for the 1000 sessions that learned one last', async () => {
      await add(RESOLVED, YESTERDAY);
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      for (let other = 0; other < 1000; other++) service.rememberResolvedNumber(`session-${other}`, WROTE, RESOLVED);

      await expect(service.assertSendAllowed(sessionId, WROTE)).rejects.toMatchObject(refused);
    });

    it('keeps the notes of a session that noted again while 1000 others noted one', async () => {
      await add(RESOLVED, YESTERDAY);
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      for (let other = 0; other < 999; other++) service.rememberResolvedNumber(`session-${other}`, WROTE, RESOLVED);
      service.rememberResolvedNumber(sessionId, '6281234567891@c.us', '628123456781@c.us');
      service.rememberResolvedNumber('session-999', WROTE, RESOLVED);

      await expect(service.assertSendAllowed(sessionId, WROTE)).resolves.toBeDefined();
    });

    it('remembers the 1000 written ids it learned last', async () => {
      await add(RESOLVED, YESTERDAY);
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      for (let other = 0; other < 1000; other++) {
        service.rememberResolvedNumber(
          sessionId,
          `62850000${String(other).padStart(4, '0')}@c.us`,
          `6285${other}@c.us`,
        );
      }
      await expect(service.assertSendAllowed(sessionId, WROTE)).rejects.toMatchObject(refused);

      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      await expect(service.assertSendAllowed(sessionId, WROTE)).resolves.toBeDefined();
    });

    it('keeps a written id noted again while 1000 others were noted', async () => {
      await add(RESOLVED, YESTERDAY);
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      const noteAnother = (other: number): void =>
        service.rememberResolvedNumber(
          sessionId,
          `62850000${String(other).padStart(4, '0')}@c.us`,
          `6285${other}@c.us`,
        );
      for (let other = 0; other < 999; other++) noteAnother(other);
      service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);
      noteAnother(999);

      await expect(service.assertSendAllowed(sessionId, WROTE)).resolves.toBeDefined();
    });

    it.each([
      ['the written id, with the history under the resolved one', '6281234567890:3@s.whatsapp.net', RESOLVED],
      ['the resolved id, with the history under the written one', '628123456789:3@s.whatsapp.net', WROTE],
    ])(
      'finds the history of %s, asked in the other dialect with a device suffix, in the one probe',
      async (_case, asked, stored) => {
        await add(stored, YESTERDAY);
        service.rememberResolvedNumber(sessionId, WROTE, RESOLVED);

        recorded = [];
        await expect(service.assertSendAllowed(sessionId, asked)).resolves.toBeDefined();
        const probes = recorded.filter(statement => statement.includes('"chatId"'));
        recorded = null;

        expect(probes).toHaveLength(1);
        expect(lidReads.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0);
      },
    );
  });

  it('charges a group add that names one number in both spellings once', async () => {
    // An allowance of one: charged as two, the request is refused as larger than the whole day allows.
    await expect(
      service.assertReachoutAllowed(sessionId, [`${WRITTEN}@c.us`, `${HELD}@s.whatsapp.net`, `${HELD}@c.us`]),
    ).resolves.toBeDefined();
    await expect(service.assertReachoutAllowed(sessionId, [OTHER_STRANGER])).rejects.toMatchObject(refused);
  });

  it('holds no cold slot for such a send while it is in flight', async () => {
    pacing.coldSchedule = [2];
    await add(STRANGER, NINE);
    await add(`${HELD}@c.us`, YESTERDAY);

    // Admitted and not settled: the send is still on its way.
    await service.assertSendAllowed(sessionId, `${WRITTEN}@c.us`, { untilSettled: true });

    await expect(service.assertSendAllowed(sessionId, OTHER_STRANGER)).resolves.toBeDefined();
  });

  describe('the count of the day', () => {
    it('reads the chats started today in the same few statements, however many are written in two spellings', async () => {
      const started = async (chats: number): Promise<number> => {
        await messages.clear();
        await messages.insert(
          Array.from({ length: chats }, (_, i) => ({
            id: randomUUID(),
            sessionId,
            chatId: `55119${String(i).padStart(8, '0')}@c.us`,
            from: 'a',
            to: 'b',
            type: 'text',
            direction: MessageDirection.OUTGOING,
            createdAt: new Date(NINE),
          })),
        );
        recorded = [];
        expect(await countToday()).toBe(chats);
        const statements = recorded.length;
        recorded = null;
        return statements;
      };

      const few = await started(3);
      expect(await started(200)).toBe(few);
      expect(few).toBeLessThanOrEqual(5);
    });

    it('still leaves out a chat that another form of its contact wrote to first today', async () => {
      await add(`${HELD}@c.us`, EIGHT, MessageDirection.INCOMING);
      await add(`${WRITTEN}@c.us`, NINE);
      await add(STRANGER, NINE);

      expect(await countToday()).toBe(1);
    });

    it('leaves out a chat stored under the held number whose older history is under the written spelling', async () => {
      await add(STRANGER, NINE);
      await add(`${WRITTEN}@c.us`, YESTERDAY);
      await add(`${HELD}@c.us`, NINE);

      expect(await countToday()).toBe(1);
    });

    it('counts a contact reached today under both spellings once', async () => {
      await add(`${WRITTEN}@c.us`, EIGHT);
      await add(`${HELD}@c.us`, NINE);

      expect(await countToday()).toBe(1);
    });

    it('leaves out a lid chat whose older history is under the spelling its pair does not name', async () => {
      await pair(HELD);
      await add(`${WRITTEN}@c.us`, YESTERDAY);
      await add(`${LID}@lid`, NINE);

      expect(await countToday()).toBe(0);
    });

    it('counts two chats whose ids are no plain numbers as two', async () => {
      await add('alice@c.us', EIGHT);
      await add('bob@c.us', NINE);

      expect(await countToday()).toBe(2);
    });

    it('counts a contact reached today under the lid of the held number and under the written spelling once', async () => {
      await pair(HELD);
      await add(`${LID}@lid`, EIGHT);
      await add(`${WRITTEN}@c.us`, NINE);

      expect(await countToday()).toBe(1);
    });
  });
});
