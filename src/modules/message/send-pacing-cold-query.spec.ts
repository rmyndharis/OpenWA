import { DataSource } from 'typeorm';
import { SendPacingService } from './send-pacing.service';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { computeSendPacingConfig } from './send-pacing.config';
import type { ConfigService } from '@nestjs/config';

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
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();

    await addMessage('new-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  // The direction asymmetry is the whole point: someone writing to us first makes the chat warm,
  // but their inbound message is not itself a reachout we made.
  it('treats an inbound-first chat as warm without counting it as a reachout', async () => {
    await addMessage('inbound-1@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-2@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-3@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-4@c.us', TODAY, MessageDirection.INCOMING);

    // Replying to any of them is never refused, however many there are…
    await expect(service.assertSendAllowed('s1', 'inbound-1@c.us')).resolves.toBeUndefined();
    // …and none of them consumed the cold budget, so a stranger is still allowed.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();
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
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();

    await addMessage('cold-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it("does not count another session's reachouts", async () => {
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('other-1','s2','a@c.us','a','b','text','outgoing',?),
              ('other-2','s2','b@c.us','a','b','text','outgoing',?),
              ('other-3','s2','c@c.us','a','b','text','outgoing',?)`,
      [TODAY, TODAY, TODAY],
    );

    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();
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
    await expect(service.assertSendAllowed('s1', '628555@c.us')).resolves.toBeUndefined();
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
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();

    await addMessage('cold-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it("forgets yesterday's reachouts when the UTC day rolls over", async () => {
    await addMessage('y1@c.us', YESTERDAY);
    await addMessage('y2@c.us', YESTERDAY);
    await addMessage('y3@c.us', YESTERDAY);
    await addMessage('y4@c.us', YESTERDAY);

    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();
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

  it("allows a batch that fits inside the day's remaining allowance", async () => {
    await expect(service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
  });

  // The cost is per stranger, not per call — otherwise one request adding two hundred numbers would
  // cost exactly as much as adding one, which is the abuse the rule exists to bound.
  it('charges the batch per new contact, not per call', async () => {
    await expect(service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us', 'd@c.us'])).rejects.toMatchObject({
      status: 429,
    });
  });

  it('does not charge for contacts the account already knows', async () => {
    await addMessage('known-1@c.us', YESTERDAY);
    await addMessage('known-2@c.us', YESTERDAY);

    // Five participants, but only three are strangers — exactly the allowance.
    await expect(
      service.assertReachoutAllowed('s1', ['known-1@c.us', 'known-2@c.us', 'a@c.us', 'b@c.us', 'c@c.us']),
    ).resolves.toBeUndefined();
  });

  it('does not charge for a contact known under the other user-id dialect', async () => {
    await addMessage('628555@s.whatsapp.net', YESTERDAY);

    // Four participants, but the dialect twin is known — three strangers, exactly the allowance.
    await expect(
      service.assertReachoutAllowed('s1', ['628555@c.us', 'a@c.us', 'b@c.us', 'c@c.us']),
    ).resolves.toBeUndefined();
  });

  // The group endpoints accept a bare number and the engines qualify it themselves, so the probe
  // must look under both spellings or a known contact is charged as a stranger.
  it('does not charge for a known contact passed as a bare number', async () => {
    await addMessage('628555@c.us', YESTERDAY);

    // Four participants, but the bare-number form of a known contact is not a stranger — three are.
    await expect(
      service.assertReachoutAllowed('s1', ['628555', 'a@c.us', 'b@c.us', 'c@c.us']),
    ).resolves.toBeUndefined();
  });

  it('counts a repeated id once', async () => {
    await expect(
      service.assertReachoutAllowed('s1', ['a@c.us', 'a@c.us', 'a@c.us', 'b@c.us', 'b@c.us']),
    ).resolves.toBeUndefined();
  });

  // The two paths share one budget, so a day spent on direct messages leaves nothing for group adds.
  it("shares the day's budget with cold sends already made", async () => {
    await addMessage('dm-1@c.us', TODAY);
    await addMessage('dm-2@c.us', TODAY);

    await expect(service.assertReachoutAllowed('s1', ['a@c.us'])).resolves.toBeUndefined();
    await addMessage('dm-3@c.us', TODAY);
    await expect(service.assertReachoutAllowed('s1', ['a@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  // The regression this file exists to lock: group adds persist no message row, so the cap must be
  // charged in memory or every request gets the full allowance afresh (per-request, not per-day).
  it('accumulates across calls in the same day — the allowance is per-day, not per-request', async () => {
    await expect(service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us'])).resolves.toBeUndefined();
    // The allowance (3) is now spent for the day, even though no message row was written.
    await expect(service.assertReachoutAllowed('s1', ['d@c.us'])).rejects.toMatchObject({ status: 429 });
  });

  it('charges the chat cold cap too, so group adds leave fewer direct cold reachouts', async () => {
    await service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    // Budget consumed by group adds; a fresh cold direct message must now be refused.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it('resets the group tally on the UTC day boundary', async () => {
    await service.assertReachoutAllowed('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    await expect(service.assertReachoutAllowed('s1', ['d@c.us'])).rejects.toMatchObject({ status: 429 });

    // Roll into the next UTC day: the tally is keyed by day, so the allowance is fresh.
    jest.setSystemTime(new Date(NOW.getTime() + DAY_MS));
    await expect(service.assertReachoutAllowed('s1', ['e@c.us', 'f@c.us', 'g@c.us'])).resolves.toBeUndefined();
  });

  it('is inert for an empty participant list', async () => {
    await addMessage('dm-1@c.us', TODAY);
    await addMessage('dm-2@c.us', TODAY);
    await addMessage('dm-3@c.us', TODAY);

    await expect(service.assertReachoutAllowed('s1', [])).resolves.toBeUndefined();
  });
});
