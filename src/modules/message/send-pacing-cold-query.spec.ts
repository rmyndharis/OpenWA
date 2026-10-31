import { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { SEND_PACING_LIMITED, SendPacingService } from './send-pacing.service';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { computeSendPacingConfig } from './send-pacing.config';
import type { ConfigService } from '@nestjs/config';
import { GroupService } from '../group/group.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

/**
 * The cold-reachout count is the one piece of this feature that cannot be proven with a mocked
 * repository: it is a hand-written `NOT EXISTS` subquery, so a wrong column name, a wrong join
 * predicate or an unquoted identifier compiles, passes every mocked test, and then throws on the
 * first cold send in production.
 *
 * (It did: the subquery was first written against `session_id` / `chat_id` / `created_at`. Those
 * columns do not exist — this connection has no snake_case naming strategy and the real columns are
 * quoted camelCase — and nothing but a real database was ever going to say so.)
 *
 * So this spec drives an actual SQLite schema and asserts on rows, not on calls.
 */
describe('cold-reachout counting against a real database', () => {
  let ds: DataSource;
  let service: SendPacingService;

  const DAY_MS = 86_400_000;
  const NOW = new Date('2026-08-03T12:00:00.000Z');
  const TODAY = '2026-08-03T09:00:00.000Z';
  const YESTERDAY = '2026-08-02T09:00:00.000Z';

  const config = (over: Record<string, unknown> = {}): ConfigService =>
    ({
      get: (key: string) =>
        key === 'sendPacing'
          ? { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [10_000], coldSchedule: [3], ...over }
          : undefined,
    }) as unknown as ConfigService;

  const addMessage = (chatId: string, at: string, direction = MessageDirection.OUTGOING): Promise<unknown> =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES (?,?,?,'a','b','text',?,?)`,
      [`${chatId}-${at}-${direction}`, 's1', chatId, direction, at],
    );

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await ds.initialize();
    // The session is old enough that only the cold rule can refuse anything.
    await ds.getRepository(Session).save({ name: 'bot', id: 's1', createdAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    service = new SendPacingService(ds.getRepository(Message), ds.getRepository(Session), config());
  });

  afterEach(async () => {
    jest.useRealTimers();
    await ds.destroy();
  });

  it('counts a chat first written to today, and stops counting it once it has history', async () => {
    await addMessage('new-1@c.us', TODAY);
    await addMessage('new-2@c.us', TODAY);
    // Written to today but known since yesterday — an ongoing conversation, not a reachout.
    await addMessage('known@c.us', YESTERDAY);
    await addMessage('known@c.us', TODAY);

    // Two cold reachouts used of three: a third stranger is still allowed.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeInstanceOf(Function);

    await addMessage('new-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger-2@c.us')).rejects.toMatchObject({ status: 429 });
  });

  // The direction asymmetry is the whole point: someone writing to us first makes the chat warm,
  // but their inbound message is not itself a reachout we made.
  it('treats an inbound-first chat as warm without counting it as a reachout', async () => {
    await addMessage('inbound-1@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-2@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-3@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-4@c.us', TODAY, MessageDirection.INCOMING);

    // Replying to any of them is never refused, however many there are…
    await expect(service.assertSendAllowed('s1', 'inbound-1@c.us')).resolves.toBeInstanceOf(Function);
    // …and none of them consumed the cold budget, so a stranger is still allowed.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeInstanceOf(Function);
  });

  // The class rule — answering someone who wrote first is not a reachout — must hold for the
  // AGGREGATE too, not just the per-send probe. A reply to a chat whose first-ever message arrived
  // today used to inflate the count and spend budget the account never used.
  it('does not count a reply to someone who wrote first today toward the cold budget', async () => {
    // They wrote first this morning; we answered. A new chat, but an answered one.
    await addMessage('wrote-first@c.us', '2026-08-03T08:00:00.000Z', MessageDirection.INCOMING);
    await addMessage('wrote-first@c.us', TODAY);
    // Genuine reachouts: we wrote first — one even got a reply, which keeps it OUR reachout.
    await addMessage('cold-1@c.us', TODAY);
    await addMessage('cold-2@c.us', TODAY);
    await addMessage('cold-2@c.us', '2026-08-03T10:00:00.000Z', MessageDirection.INCOMING);

    // Two of three used: the answered chat did not count, the replied-to reachout still does.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeInstanceOf(Function);

    await addMessage('cold-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger-2@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it("does not count another session's reachouts", async () => {
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('other-1','s2','a@c.us','a','b','text','outgoing',?),
              ('other-2','s2','b@c.us','a','b','text','outgoing',?),
              ('other-3','s2','c@c.us','a','b','text','outgoing',?)`,
      [TODAY, TODAY, TODAY],
    );

    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeInstanceOf(Function);
  });

  // Whether a chat is new is a question about THIS account, not the deployment: another session
  // knowing the number says nothing about this one's relationship with it. If the history lookup
  // were not scoped per session, a second session's older message would make this session's very
  // first approach look like an ongoing conversation and free up budget it never earned.
  it("does not let another session's older history make a chat look warm", async () => {
    await addMessage('cold-a@c.us', TODAY);
    await addMessage('cold-b@c.us', TODAY);
    await addMessage('shared@c.us', TODAY);
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('s2-older','s2','shared@c.us','a','b','text','outgoing',?)`,
      [YESTERDAY],
    );

    // Three cold reachouts today, `shared@c.us` among them — the budget of three is spent.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  // Stored rows carry either user-id dialect (inbound neutralized to @c.us, outbound the caller's
  // raw form) — byte-exact probing misread a known contact addressed the other way as cold.
  it('matches history across user-id dialects, so a known contact is never misread as cold', async () => {
    await addMessage('628555@s.whatsapp.net', YESTERDAY);
    await addMessage('cold-1@c.us', TODAY);
    await addMessage('cold-2@c.us', TODAY);
    await addMessage('cold-3@c.us', TODAY);

    // The budget of three is spent, but the @c.us spelling of a known contact stays warm.
    await expect(service.assertSendAllowed('s1', '628555@c.us')).resolves.toBeInstanceOf(Function);
  });

  // The per-send probe and the daily aggregate must agree about who is a stranger, or the aggregate
  // over-counts and refuses legitimate sends a slot or more early.
  it('counts a contact reached under either dialect once, and not at all when known before today', async () => {
    // Known since yesterday under the engine spelling; today's outgoing uses the neutral one.
    await addMessage('628555@s.whatsapp.net', YESTERDAY);
    await addMessage('628555@c.us', TODAY);
    // The same stranger written to under both spellings today is ONE cold reachout, not two.
    await addMessage('628777@c.us', TODAY);
    await addMessage('628777@s.whatsapp.net', TODAY);
    await addMessage('cold-2@c.us', TODAY);

    // Two of three used (the warm contact counted zero, the double-spelled stranger counted once).
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeInstanceOf(Function);

    await addMessage('cold-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger-2@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it("forgets yesterday's reachouts when the UTC day rolls over", async () => {
    await addMessage('y1@c.us', YESTERDAY);
    await addMessage('y2@c.us', YESTERDAY);
    await addMessage('y3@c.us', YESTERDAY);
    await addMessage('y4@c.us', YESTERDAY);

    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeInstanceOf(Function);
  });
});

// Adding people to a group is the highest-risk reachout this product performs: it puts the account
// in front of strangers in bulk, in one call. It draws on the same cold budget a first message does.
describe('group reachouts against a real database', () => {
  let ds: DataSource;
  let service: SendPacingService;

  const DAY_MS = 86_400_000;
  const NOW = new Date('2026-08-03T12:00:00.000Z');
  const TODAY = '2026-08-03T09:00:00.000Z';
  const YESTERDAY = '2026-08-02T09:00:00.000Z';

  const config = (): ConfigService =>
    ({
      get: (key: string) =>
        key === 'sendPacing'
          ? { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [10_000], coldSchedule: [3] }
          : undefined,
    }) as unknown as ConfigService;

  const addMessage = (chatId: string, at: string): Promise<unknown> =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES (?,?,?,'a','b','text','outgoing',?)`,
      [`${chatId}-${at}`, 's1', chatId, at],
    );

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).save({ name: 'bot', id: 's1', createdAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    service = new SendPacingService(ds.getRepository(Message), ds.getRepository(Session), config());
  });

  afterEach(async () => {
    jest.useRealTimers();
    await ds.destroy();
  });

  // An allowed batch is reserved by the check itself; the group callers only refund on failure.
  const reachout = async (sessionId: string, ids: string[]): Promise<void> => {
    await service.assertReachoutAllowed(sessionId, ids);
  };

  it("allows a batch that fits inside the day's remaining allowance", async () => {
    await expect(reachout('s1', ['a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
  });

  // The cost is per stranger, not per call — otherwise one request adding two hundred numbers would
  // cost exactly as much as adding one, which is the abuse the rule exists to bound.
  it('charges the batch per new contact, not per call', async () => {
    await reachout('s1', ['a@c.us', 'b@c.us']);
    await expect(reachout('s1', ['c@c.us', 'd@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  // Waiting cannot help a batch larger than a whole day's allowance, so a 429 with a retry hint would
  // send a client that honours it round the same refusal every day. Refuse it as a request to split.
  it('answers 400 without a retry hint for a batch larger than the whole allowance', async () => {
    const error = await service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us', 'd@c.us']).then(
      () => null,
      (e: HttpException) => e,
    );
    expect(error?.getStatus()).toBe(400);
    expect(JSON.stringify(error?.getResponse())).toContain('batches of at most 3');
    expect(JSON.stringify(error?.getResponse())).not.toContain('retryAfterSeconds');
    // Nothing was reserved: a batch that fits is still allowed.
    await expect(reachout('s1', ['a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
  });

  it('does not charge for contacts the account already knows', async () => {
    await addMessage('known-1@c.us', YESTERDAY);
    await addMessage('known-2@c.us', YESTERDAY);

    // Five participants, but only three are strangers — exactly the allowance.
    await expect(
      reachout('s1', ['known-1@c.us', 'known-2@c.us', 'a@c.us', 'b@c.us', 'c@c.us']),
    ).resolves.toBeUndefined();
  });

  it('does not charge for a contact known under the other user-id dialect', async () => {
    await addMessage('628555@s.whatsapp.net', YESTERDAY);

    // Four participants, but the dialect twin is known — three strangers, exactly the allowance.
    await expect(reachout('s1', ['628555@c.us', 'a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
  });

  // The group endpoints accept a bare number and the engines qualify it themselves, so the probe
  // must look under both spellings or a known contact is charged as a stranger.
  it('does not charge for a known contact passed as a bare number', async () => {
    await addMessage('628555@c.us', YESTERDAY);

    // Four participants, but the bare-number form of a known contact is not a stranger — three are.
    await expect(reachout('s1', ['628555', 'a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
  });

  it('counts a repeated id once', async () => {
    await expect(reachout('s1', ['a@c.us', 'a@c.us', 'a@c.us', 'b@c.us', 'b@c.us'])).resolves.toBeUndefined();
  });

  // A bare number and its qualified form are the same contact: the engines qualify it themselves.
  it('counts a bare number and its qualified form once', async () => {
    await expect(reachout('s1', ['628111', '628111@c.us', '628222', '628222@c.us', 'c@c.us'])).resolves.toBeUndefined();
  });

  // The two paths share one budget, so a day spent on direct messages leaves nothing for group adds.
  it("shares the day's budget with cold sends already made", async () => {
    await addMessage('dm-1@c.us', TODAY);
    await addMessage('dm-2@c.us', TODAY);

    await expect(reachout('s1', ['a@c.us'])).resolves.toBeUndefined();
    await addMessage('dm-3@c.us', TODAY);
    await expect(reachout('s1', ['a@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  // The regression this file exists to lock: group adds persist no message row, so the cap must be
  // charged in memory or every request gets the full allowance afresh (per-request, not per-day).
  it('accumulates across calls in the same day — the allowance is per-day, not per-request', async () => {
    await expect(reachout('s1', ['a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
    // The allowance (3) is now spent for the day, even though no message row was written.
    await expect(reachout('s1', ['d@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  it('charges the chat cold cap too, so group adds leave fewer direct cold reachouts', async () => {
    await reachout('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    // Budget consumed by group adds; a fresh cold direct message must now be refused.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('resets the group tally on the UTC day boundary', async () => {
    await reachout('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    await expect(reachout('s1', ['d@c.us'])).rejects.toMatchObject({ status: 429 });

    // Roll into the next UTC day: the tally is keyed by day, so the allowance is fresh.
    jest.setSystemTime(new Date(NOW.getTime() + DAY_MS));
    await expect(reachout('s1', ['e@c.us', 'f@c.us', 'g@c.us'])).resolves.toBeUndefined();
  });

  it('is inert for an empty participant list', async () => {
    await addMessage('dm-1@c.us', TODAY);
    await addMessage('dm-2@c.us', TODAY);
    await addMessage('dm-3@c.us', TODAY);

    await expect(service.assertReachoutAllowed('s1', [])).resolves.toMatchObject({ coldCount: 0 });
  });

  // The check and the charge are one synchronous step: two requests in flight at once must not both
  // pass against the same unspent budget.
  it('refuses the second of two concurrent batches that together exceed the allowance', async () => {
    const results = await Promise.allSettled([
      service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us']),
      service.assertReachoutAllowed('s1', ['c@c.us', 'd@c.us']),
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
  });

  it('hands a refunded reservation back to the same day', async () => {
    const reservation = await service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    await expect(reachout('s1', ['d@c.us'])).rejects.toMatchObject({ status: 429 });

    service.refundGroupReachouts('s1', reservation);
    await expect(reachout('s1', ['e@c.us', 'f@c.us', 'g@c.us'])).resolves.toBeUndefined();
  });

  it("leaves the new day's tally alone when a reservation is refunded after UTC midnight", async () => {
    const yesterdays = await service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us']);

    jest.setSystemTime(new Date(NOW.getTime() + DAY_MS));
    await reachout('s1', ['c@c.us', 'd@c.us', 'e@c.us']);
    service.refundGroupReachouts('s1', yesterdays);

    // Today's three are still spent; the refund belonged to a day that is over.
    await expect(reachout('s1', ['f@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  // A check whose count query spans UTC midnight is judged by, and charged to, the new day.
  const rollOverDuringCount = (during: () => Promise<unknown> = () => Promise.resolve()): void => {
    const internals = service as unknown as { countColdReachoutsToday: () => Promise<number> };
    const realCount = internals.countColdReachoutsToday.bind(service);
    jest
      .spyOn(internals, 'countColdReachoutsToday')
      .mockImplementationOnce(async () => {
        jest.setSystemTime(new Date(NOW.getTime() + DAY_MS));
        await during();
        return 0;
      })
      .mockImplementation(realCount);
  };

  it('charges a check that straddled UTC midnight to the new day', async () => {
    rollOverDuringCount();

    await reachout('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    await expect(reachout('s1', ['d@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a straddling check once another request spent the new day's allowance", async () => {
    // While the first check is suspended on its count query, another request spends the whole
    // new day's allowance.
    rollOverDuringCount(() => reachout('s1', ['b@c.us', 'c@c.us', 'd@c.us']));

    await expect(reachout('s1', ['a@c.us'])).rejects.toMatchObject({ status: 429 });
    await expect(reachout('s1', ['e@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  describe('through GroupService', () => {
    const tenStrangers = (prefix: string): string[] =>
      Array.from({ length: 10 }, (_, i) => `62${prefix}${String(i).padStart(4, '0')}@c.us`);

    const groupService = (engine: Partial<IWhatsAppEngine>): GroupService => {
      const engines = new EngineRegistry();
      engines.set('s1', engine as IWhatsAppEngine);
      return new GroupService(engines, service);
    };

    beforeEach(() => {
      service = new SendPacingService(ds.getRepository(Message), ds.getRepository(Session), {
        get: (key: string) =>
          key === 'sendPacing'
            ? { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [10_000], coldSchedule: [10] }
            : undefined,
      } as unknown as ConfigService);
    });

    it('adds at most one of two concurrent batches that together exceed the allowance', async () => {
      // The engine takes a while, as a real per-participant add does: the window the race lived in.
      // Real timers, so the engine's setImmediate can fire.
      const addParticipants = jest.fn(
        () => new Promise(resolve => setImmediate(() => resolve([]))),
      ) as unknown as IWhatsAppEngine['addParticipants'];
      jest.useRealTimers();
      const svc = groupService({ addParticipants });

      const results = await Promise.allSettled([
        svc.addParticipants('s1', 'g1@g.us', tenStrangers('811')),
        svc.addParticipants('s1', 'g2@g.us', tenStrangers('822')),
      ]);

      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(addParticipants).toHaveBeenCalledTimes(1);
      expect(results.find(r => r.status === 'rejected')).toMatchObject({
        reason: { status: 429, response: { code: SEND_PACING_LIMITED } },
      });
    });

    // Both engines report a refused batch (no admin rights) as EngineRefusedError, a 403: nobody was
    // contacted, so the reservation is refunded.
    it('refunds the batch when the engine refuses the add, so the next batch still fits', async () => {
      const addParticipants = jest
        .fn()
        .mockRejectedValueOnce(new EngineRefusedError('not an admin'))
        .mockResolvedValueOnce([]);
      const svc = groupService({ addParticipants });

      await expect(svc.addParticipants('s1', 'g1@g.us', tenStrangers('811'))).rejects.toThrow('not an admin');
      await expect(svc.addParticipants('s1', 'g1@g.us', tenStrangers('822'))).resolves.toEqual([]);
    });

    // A failure that does not prove nobody was reached (a dropped socket, a deadline while the query is
    // still in flight) keeps the batch charged: WhatsApp may already have added the participants.
    it('keeps the batch charged when the add fails with an unknown outcome', async () => {
      const addParticipants = jest.fn().mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce([]);
      const svc = groupService({ addParticipants });

      await expect(svc.addParticipants('s1', 'g1@g.us', tenStrangers('811'))).rejects.toThrow('socket closed');
      await expect(svc.addParticipants('s1', 'g1@g.us', tenStrangers('822'))).rejects.toMatchObject({
        status: 429,
        response: { code: SEND_PACING_LIMITED },
      });
      expect(addParticipants).toHaveBeenCalledTimes(1);
    });
  });
});

// A send's row is written by the caller after the check returns (after the plugin gate), so the
// persisted count alone cannot see sends that passed the check moments earlier. A burst of parallel
// requests must still be held to the cap, not each judged against the same stale count.
describe('concurrent sends against a real database', () => {
  let ds: DataSource;
  const NOW = new Date('2026-08-03T12:00:00.000Z');

  const build = (warmupSchedule: number[], coldSchedule: number[]): SendPacingService =>
    new SendPacingService(ds.getRepository(Message), ds.getRepository(Session), {
      get: (key: string) =>
        key === 'sendPacing'
          ? { ...computeSendPacingConfig({}), enabled: true, warmupSchedule, coldSchedule }
          : undefined,
    } as unknown as ConfigService);

  const insertRow = (id: string, chatId: string): Promise<unknown> =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES (?,?,?,'a','b','text','outgoing',?)`,
      [id, 's1', chatId, new Date().toISOString()],
    );

  // Check, then persist the row the way a send path does; resolves true when the send went out.
  const send = async (service: SendPacingService, chatId: string, i: number): Promise<boolean> => {
    try {
      await service.assertSendAllowed('s1', chatId);
    } catch {
      return false;
    }
    await insertRow(`m${i}`, chatId);
    return true;
  };

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(NOW);
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).save({ name: 'bot', id: 's1', createdAt: NOW });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await ds.destroy();
  });

  it('admits exactly the daily allowance from a parallel burst', async () => {
    const service = build([20], []);
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('seed','s1','known@c.us','a','b','text','incoming',?)`,
      [new Date(NOW.getTime() - 60_000).toISOString()],
    );

    const sent = await Promise.all(Array.from({ length: 100 }, (_, i) => send(service, 'known@c.us', i)));

    expect(sent.filter(Boolean)).toHaveLength(20);
  });

  it('admits exactly the cold allowance from a parallel burst to strangers', async () => {
    const service = build([10_000], [5]);

    const sent = await Promise.all(Array.from({ length: 100 }, (_, i) => send(service, `6281${i}@c.us`, i)));

    expect(sent.filter(Boolean)).toHaveLength(5);
  });

  it('charges parallel sends to one stranger as a single reachout', async () => {
    const service = build([10_000], [2]);

    const sent = await Promise.all(Array.from({ length: 3 }, (_, i) => send(service, 'lead@c.us', i)));

    expect(sent).toEqual([true, true, true]);
    expect(await send(service, 'second@c.us', 9)).toBe(true);
  });

  it('judges an edit against the cap without holding it, since an edit writes no row', async () => {
    const service = build([20], []);
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('seed','s1','known@c.us','a','b','text','outgoing',?)`,
      [new Date(NOW.getTime() - 60_000).toISOString()],
    );
    for (let i = 0; i < 30; i++) await service.assertSendAllowed('s1', 'known@c.us', { hold: false });

    expect(await send(service, 'known@c.us', 1)).toBe(true);
  });

  it('charges a group add for a cold send admitted but not yet persisted', async () => {
    const service = build([10_000], [1]);
    await service.assertSendAllowed('s1', 'stranger@c.us');

    await expect(service.assertReachoutAllowed('s1', ['other@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  it('still admits sequential sends up to the allowance, each counted once', async () => {
    const service = build([5], []);
    const sent: boolean[] = [];
    for (let i = 0; i < 7; i++) sent.push(await send(service, 'known@c.us', i));

    expect(sent).toEqual([true, true, true, true, true, false, false]);
  });

  it('holds a send admitted just before the window would have lapsed for a full window of its own', async () => {
    const service = build([2], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    jest.setSystemTime(NOW.getTime() + 9_990);
    // Admitted, but its row has not landed yet (the plugin gate is still running).
    await service.assertSendAllowed('s1', 'known@c.us');
    jest.setSystemTime(NOW.getTime() + 10_010);

    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('holds a cold send admitted just before the window would have lapsed', async () => {
    const service = build([10_000], [2]);
    expect(await send(service, 'first@c.us', 1)).toBe(true);
    jest.setSystemTime(NOW.getTime() + 9_990);
    await service.assertSendAllowed('s1', 'second@c.us');
    jest.setSystemTime(NOW.getTime() + 10_010);

    await expect(service.assertSendAllowed('s1', 'third@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('counts a burst against rows the session wrote without asking, not a stale base', async () => {
    const service = build([5], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    jest.setSystemTime(NOW.getTime() + 5_000);
    // Sent from the phone: outgoing rows that never went through this check.
    for (const id of ['phone1', 'phone2']) {
      await ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
         VALUES (?,'s1','known@c.us','a','b','text','outgoing',?)`,
        [id, new Date().toISOString()],
      );
    }
    jest.setSystemTime(NOW.getTime() + 8_000);
    expect(await send(service, 'known@c.us', 2)).toBe(true);
    jest.setSystemTime(NOW.getTime() + 12_000);

    const sent = await Promise.all(Array.from({ length: 5 }, (_, i) => send(service, 'known@c.us', 10 + i)));

    expect(sent.filter(Boolean)).toHaveLength(1);
  });

  it('stops holding a send that wrote no row once no send admitted after it is held', async () => {
    const service = build([5], []);
    // Three admitted sends that never write a row (an engine failure in a bulk batch), 3 s apart.
    for (let i = 0; i < 3; i++) {
      jest.setSystemTime(NOW.getTime() + i * 3_000);
      await service.assertSendAllowed('s1', 'known@c.us');
    }
    jest.setSystemTime(NOW.getTime() + 16_000);
    const sent: boolean[] = [];
    for (let i = 0; i < 6; i++) sent.push(await send(service, 'known@c.us', i));

    expect(sent).toEqual([true, true, true, true, true, false]);
  });

  it('stops counting an admitted send against the caps once it is released', async () => {
    const service = build([2], [2]);
    expect(await send(service, 'first@c.us', 1)).toBe(true);
    // Admitted, then failed before writing a row (a plugin veto, an engine refusal).
    const release = await service.assertSendAllowed('s1', 'second@c.us');
    release?.();

    expect(await send(service, 'third@c.us', 2)).toBe(true);
  });

  it('answers a refusal caused only by held sends with the seconds until they lapse', async () => {
    const service = build([2], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    await service.assertSendAllowed('s1', 'known@c.us');
    jest.setSystemTime(NOW.getTime() + 3_000);

    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({
      status: 429,
      response: { code: SEND_PACING_LIMITED, retryAfterSeconds: 7 },
    });
  });

  it('answers a cold refusal caused only by held sends with the seconds until they lapse', async () => {
    const service = build([10_000], [2]);
    expect(await send(service, 'first@c.us', 1)).toBe(true);
    await service.assertSendAllowed('s1', 'second@c.us');
    jest.setSystemTime(NOW.getTime() + 4_000);

    await expect(service.assertSendAllowed('s1', 'third@c.us')).rejects.toMatchObject({
      status: 429,
      response: { code: SEND_PACING_LIMITED, retryAfterSeconds: 6 },
    });
  });

  it('answers a group add refused only by held cold sends with the seconds until they lapse', async () => {
    const service = build([10_000], [5]);
    for (let i = 0; i < 3; i++) expect(await send(service, `first${i}@c.us`, i)).toBe(true);
    // A cold send admitted but never persisted (its outcome unknown), so it stays held.
    await service.assertSendAllowed('s1', 'held@c.us');
    jest.setSystemTime(NOW.getTime() + 4_000);

    await expect(service.assertReachoutAllowed('s1', ['new1@c.us', 'new2@c.us'])).rejects.toMatchObject({
      status: 429,
      response: { code: SEND_PACING_LIMITED, retryAfterSeconds: 6 },
    });
  });

  describe('a cold send with no row in a busy session', () => {
    const seedKnown = (): Promise<unknown> =>
      ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
         VALUES ('seed','s1','known@c.us','a','b','text','incoming',?)`,
        [new Date(NOW.getTime() - 86_400_000).toISOString()],
      );

    // A cold bulk item with an unknown outcome (it never writes a row), a cold send whose row lands,
    // then a warm send every 3 s for 30 s.
    const busySession = async (service: SendPacingService): Promise<void> => {
      await seedKnown();
      const settle = await service.assertSendAllowed('s1', 'x@c.us', { untilSettled: true });
      settle?.(true);
      expect(await send(service, 'y@c.us', 1)).toBe(true);
      for (let t = 1; t <= 10; t++) {
        jest.setSystemTime(NOW.getTime() + t * 3_000);
        expect(await send(service, 'known@c.us', 10 + t)).toBe(true);
      }
    };

    it('stops counting it once its own window ends, however busy the session', async () => {
      const service = build([10_000], [2]);
      await busySession(service);

      // One new chat (y) of two reached.
      expect(await send(service, 'z@c.us', 99)).toBe(true);
    });

    it('stops charging it to a group add once its own window ends, however busy the session', async () => {
      const service = build([10_000], [2]);
      await busySession(service);

      await expect(service.assertReachoutAllowed('s1', ['z@c.us'])).resolves.toMatchObject({ coldCount: 1 });
    });

    it('judges a second send to that chat against the cap once the first stopped counting', async () => {
      const service = build([10_000], [2]);
      await busySession(service);
      expect(await send(service, 'z@c.us', 99)).toBe(true);

      // y and z reached; x would be a third new chat.
      await expect(service.assertSendAllowed('s1', 'x@c.us')).rejects.toMatchObject({ status: 429 });
    });
  });

  it.each([
    ['send', (service: SendPacingService) => service.assertSendAllowed('s1', 'y@c.us')],
    ['group add', (service: SendPacingService) => service.assertReachoutAllowed('s1', ['y@c.us'])],
  ])('answers a cold %s refused by held sends with a hint a retry then passes', async (_, attempt) => {
    const service = build([10_000], [1]);
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('seed','s1','known@c.us','a','b','text','incoming',?)`,
      [new Date(NOW.getTime() - 86_400_000).toISOString()],
    );
    // A bulk item to a known chat, in flight until +5 s, and a cold send admitted meanwhile whose row never lands.
    const settleKnown = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 1_000);
    await service.assertSendAllowed('s1', 'x@c.us');
    jest.setSystemTime(NOW.getTime() + 5_000);
    settleKnown?.(true);
    await insertRow('m1', 'known@c.us');
    jest.setSystemTime(NOW.getTime() + 6_000);

    const refusal = (await attempt(service).catch((error: HttpException) => error.getResponse())) as {
      retryAfterSeconds: number;
    };
    jest.setSystemTime(NOW.getTime() + 6_000 + refusal.retryAfterSeconds * 1_000);

    await expect(attempt(service)).resolves.toBeDefined();
  });

  it('keeps holding a send taken until settled while it is still running, then for a window from the settle', async () => {
    const service = build([2], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    // A bulk item whose engine call (a media URL fetch, an upload) outlasts the window.
    const settle = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 11_000);

    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({
      status: 429,
      response: { code: SEND_PACING_LIMITED, retryAfterSeconds: 10 },
    });

    settle?.(true);
    jest.setSystemTime(NOW.getTime() + 20_000);
    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
    jest.setSystemTime(NOW.getTime() + 21_010);
    await expect(service.assertSendAllowed('s1', 'known@c.us')).resolves.toBeDefined();
  });

  it('keeps holding a cold send taken until settled while it is still running', async () => {
    const service = build([10_000], [2]);
    expect(await send(service, 'first@c.us', 1)).toBe(true);
    await service.assertSendAllowed('s1', 'second@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 11_000);

    await expect(service.assertSendAllowed('s1', 'third@c.us')).rejects.toMatchObject({ status: 429 });
    await expect(service.assertReachoutAllowed('s1', ['third@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  it('counts a settled send for one still running that was admitted before its row landed', async () => {
    const service = build([3], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    const settleFirst = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 5_000);
    // Admitted while the first is in flight, so the count it read cannot include the first's row.
    await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 30_000);
    settleFirst?.(true);
    await insertRow('m2', 'known@c.us');
    jest.setSystemTime(NOW.getTime() + 41_000);

    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('counts a settled cold send for one still running that was admitted before its row landed', async () => {
    const service = build([10_000], [3]);
    expect(await send(service, 'first@c.us', 1)).toBe(true);
    const settleFirst = await service.assertSendAllowed('s1', 'second@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 5_000);
    await service.assertSendAllowed('s1', 'third@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 30_000);
    settleFirst?.(true);
    await insertRow('m2', 'second@c.us');
    jest.setSystemTime(NOW.getTime() + 41_000);

    await expect(service.assertSendAllowed('s1', 'fourth@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('holds a send for as long as a send admitted after it, whose count missed its row, is held', async () => {
    const service = build([2], []);
    // A single send and a bulk item read the count together; the single send is admitted first.
    await Promise.all([
      service.assertSendAllowed('s1', 'known@c.us'),
      service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true }),
    ]);
    // The single send's row lands while the bulk item is still in flight (a media URL fetch).
    await insertRow('m1', 'known@c.us');
    jest.setSystemTime(NOW.getTime() + 11_000);

    // Two sends of two made.
    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('holds a cold send for as long as a send admitted after it, whose count missed its row, is held', async () => {
    const service = build([10_000], [2]);
    await Promise.all([
      service.assertSendAllowed('s1', 'x@c.us'),
      service.assertSendAllowed('s1', 'y@c.us', { untilSettled: true }),
    ]);
    await insertRow('m1', 'x@c.us');
    jest.setSystemTime(NOW.getTime() + 11_000);

    await expect(service.assertSendAllowed('s1', 'z@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('holds a settled send for a send admitted after the settle but before its row landed', async () => {
    const service = build([2], []);
    const settleFirst = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    settleFirst?.(true);
    // Admitted after the settle, while the first send's row (written after the engine call) is still due.
    await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    await insertRow('m1', 'known@c.us');
    jest.setSystemTime(NOW.getTime() + 11_000);

    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('counts a settled send once for a send admitted after its row landed', async () => {
    const service = build([3], []);
    const settleFirst = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    // The own-send echo persists the row before the engine call returns.
    await insertRow('m0', 'known@c.us');
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    settleFirst?.(true);

    // Two sends of three made.
    await expect(service.assertSendAllowed('s1', 'known@c.us')).resolves.toBeDefined();
  });

  it('counts a settled cold chat once when a send still held goes to the same chat', async () => {
    const service = build([10_000], [3]);
    const settleFirst = await service.assertSendAllowed('s1', 'x@c.us', { untilSettled: true });
    await service.assertSendAllowed('s1', 'y@c.us', { untilSettled: true });
    await service.assertSendAllowed('s1', 'x@c.us', { untilSettled: true });
    settleFirst?.(true);

    // Two new chats of three reached.
    await expect(service.assertSendAllowed('s1', 'z@c.us')).resolves.toBeDefined();
  });

  it('stops holding a settled send once every send admitted while it was in flight has lapsed', async () => {
    const service = build([2], []);
    const settleFirst = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    const settleSecond = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    settleFirst?.(true);
    settleSecond?.(true);
    jest.setSystemTime(NOW.getTime() + 11_000);

    await expect(service.assertSendAllowed('s1', 'known@c.us')).resolves.toBeDefined();
  });

  it('holds a settled send while a send admitted after a later settle is still in flight', async () => {
    const service = build([3], []);
    const settleFirst = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 60_000);
    const settleSecond = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 240_000);
    settleFirst?.(true);
    jest.setSystemTime(NOW.getTime() + 300_000);
    // Admitted while the second is in flight, and still running.
    await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 310_000);
    settleSecond?.(true);
    jest.setSystemTime(NOW.getTime() + 400_000);

    // Three sends of three made, none with a row yet.
    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('stops counting a settled cold send once its own window ends, though a warm send admitted meanwhile is held', async () => {
    const service = build([10_000], [1]);
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('seed','s1','known@c.us','a','b','text','incoming',?)`,
      [new Date(NOW.getTime() - 86_400_000).toISOString()],
    );
    const settleCold = await service.assertSendAllowed('s1', 'x@c.us', { untilSettled: true });
    const settleKnown = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    settleCold?.(true);
    jest.setSystemTime(NOW.getTime() + 5_000);
    settleKnown?.(true);
    jest.setSystemTime(NOW.getTime() + 9_000);
    await expect(service.assertSendAllowed('s1', 'z@c.us')).rejects.toMatchObject({
      response: { code: SEND_PACING_LIMITED, retryAfterSeconds: 1 },
    });
    jest.setSystemTime(NOW.getTime() + 12_000);

    // The warm send read no cold count, so it cannot have missed the cold send's row.
    await expect(service.assertSendAllowed('s1', 'z@c.us')).resolves.toBeDefined();
  });

  it('hands back a send taken until settled at once when it is settled as never sent', async () => {
    const service = build([2], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    const settle = await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    settle?.();

    expect(await send(service, 'known@c.us', 2)).toBe(true);
  });

  it('stops holding a send never settled after the safety bound', async () => {
    const service = build([2], []);
    expect(await send(service, 'known@c.us', 1)).toBe(true);
    await service.assertSendAllowed('s1', 'known@c.us', { untilSettled: true });
    jest.setSystemTime(NOW.getTime() + 5 * 60_000 - 1_000);
    await expect(service.assertSendAllowed('s1', 'known@c.us')).rejects.toMatchObject({ status: 429 });
    jest.setSystemTime(NOW.getTime() + 5 * 60_000);

    expect(await send(service, 'known@c.us', 2)).toBe(true);
  });

  it('judges by the persisted rows alone once the hold has lapsed', async () => {
    const service = build([5], []);
    // A gated send that never writes a row (a plugin veto) is held only briefly.
    await service.assertSendAllowed('s1', 'known@c.us');
    for (let i = 0; i < 4; i++) await send(service, 'known@c.us', i);
    jest.setSystemTime(NOW.getTime() + 60_000);

    expect(await send(service, 'known@c.us', 9)).toBe(true);
  });
});
