import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { computeSendPacingConfig } from './send-pacing.config';
import { SEND_PACING_LIMITED, SendPacingService, type SettleAdmission } from './send-pacing.service';

const BEFORE_MIDNIGHT = new Date('2026-08-03T23:59:59.000Z');
const AFTER_MIDNIGHT = new Date('2026-08-04T00:00:01.000Z');

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => (resolve = yes));
  return { promise, resolve };
}

describe('send pacing UTC rollover', () => {
  let db: DataSource;
  let pacing: SendPacingService;
  const settlements: SettleAdmission[] = [];

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(BEFORE_MIDNIGHT);
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    }).initialize();
    await db.getRepository(Session).save({ id: 's1', name: 'sender', createdAt: BEFORE_MIDNIGHT });
  });

  afterEach(async () => {
    for (const settle of settlements.splice(0)) settle();
    jest.restoreAllMocks();
    jest.useRealTimers();
    await db.destroy();
  });

  function configure(rule: 'daily' | 'cold', cap: number): void {
    pacing = new SendPacingService(
      db.getRepository(Message),
      db.getRepository(Session),
      new ConfigService({
        sendPacing: {
          ...computeSendPacingConfig({}),
          enabled: true,
          warmupSchedule: [rule === 'daily' ? cap : 1000],
          coldSchedule: rule === 'cold' ? [cap] : [],
        },
      }),
    );
  }

  const insertRow = (id: string, chatId: string) =>
    db.getRepository(Message).insert({
      id,
      sessionId: 's1',
      chatId,
      from: 'sender',
      to: chatId,
      type: 'text',
      direction: MessageDirection.OUTGOING,
      createdAt: new Date(),
    });

  const admit = async (chatId: string, options: { whilePreparing?: boolean; untilSettled?: boolean }) => {
    const settle = await pacing.assertSendAllowed('s1', chatId, options);
    if (settle) settlements.push(settle);
    return settle;
  };

  const limited = (chatId = 'next@c.us') =>
    expect(admit(chatId, { whilePreparing: true })).rejects.toMatchObject({
      status: 429,
      response: { code: SEND_PACING_LIMITED },
    });

  it.each(['daily', 'cold'] as const)('rechecks a %s count that returned after midnight', async rule => {
    configure(rule, 2);
    const entered = barrier();
    const finish = barrier();
    if (rule === 'daily') {
      const repository = db.getRepository(Message);
      const count = repository.count.bind(repository);
      jest.spyOn(repository, 'count').mockImplementationOnce(async options => {
        const value = await count(options);
        entered.resolve();
        await finish.promise;
        return value;
      });
    } else {
      const counters = pacing as unknown as {
        countColdReachoutsToday(sessionId: string, dayStart: Date): Promise<number>;
      };
      const count = counters.countColdReachoutsToday.bind(pacing);
      jest.spyOn(counters, 'countColdReachoutsToday').mockImplementationOnce(async (...args) => {
        const value = await count(...args);
        entered.resolve();
        await finish.promise;
        return value;
      });
    }
    const oldCheck = admit('old@c.us', { whilePreparing: true });
    const outcome = oldCheck.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      jest.setSystemTime(AFTER_MIDNIGHT);
      await insertRow('phone', 'phone@c.us');
      await admit('held@c.us', { whilePreparing: true });
      finish.resolve();

      expect(await outcome).toMatchObject({ status: 429, response: { code: SEND_PACING_LIMITED } });
      await limited();
    } finally {
      finish.resolve();
      await outcome;
    }
  });

  it.each(['daily', 'cold'] as const)('keeps a %s admission until the engine settles after midnight', async rule => {
    configure(rule, 1);
    await admit('running@c.us', { untilSettled: true });

    jest.setSystemTime(AFTER_MIDNIGHT);

    await limited();
  });

  it.each(['daily', 'cold'] as const)('refunds an unsettled %s admission after midnight', async rule => {
    configure(rule, 1);
    const settle = await admit('running@c.us', { untilSettled: true });
    jest.setSystemTime(AFTER_MIDNIGHT);
    await limited();

    settle?.();

    await expect(admit('next@c.us', { whilePreparing: true })).resolves.toBeInstanceOf(Function);
  });

  it.each(['daily', 'cold'] as const)('gives a completed previous-day %s send a fresh allowance', async rule => {
    configure(rule, 1);
    const settle = await admit('completed@c.us', { untilSettled: true });
    await insertRow('completed', 'completed@c.us');
    settle?.(true);

    jest.setSystemTime(AFTER_MIDNIGHT);

    await expect(admit('next@c.us', { whilePreparing: true })).resolves.toBeInstanceOf(Function);
  });

  it('keeps the original five-minute safety expiry across midnight', async () => {
    configure('daily', 1);
    await admit('running@c.us', { untilSettled: true });
    jest.setSystemTime(new Date('2026-08-04T00:04:58.000Z'));
    await limited();

    jest.setSystemTime(new Date('2026-08-04T00:04:59.000Z'));

    await expect(admit('next@c.us', { whilePreparing: true })).resolves.toBeInstanceOf(Function);
  });
});
