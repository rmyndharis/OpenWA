import {
  GROUP_ACK_FOLLOW_MS,
  GROUP_ACK_RETRY_MS,
  GroupAckAggregator,
  type GroupAckHost,
  type GroupAckStatus,
} from './baileys-group-ack';
import type { MessageReceiptEvent } from '../interfaces/whatsapp-engine.interface';

const GROUP = '120363000000000001@g.us';
// A group that addresses its members by lid: the roster lists the lid with the phone number beside it.
const ALICE = ['111111111111111@lid', '6281111111111@s.whatsapp.net'];
const BOB = ['222222222222222@lid', '6282222222222@s.whatsapp.net'];
const CARA = ['333333333333333@lid', '6283333333333@s.whatsapp.net'];
const ROSTER = [ALICE, BOB, CARA];

const receipt = (
  participant: string,
  status: MessageReceiptEvent['status'],
  messageId = 'M1',
  chatId = GROUP,
): MessageReceiptEvent => ({ messageId, chatId, participant, status, timestamp: 1 });

function setup(
  roster: string[][] | null | (() => Promise<string[][] | null>) = ROSTER,
  overrides: Partial<GroupAckHost> = {},
  maxMessages?: number,
  maxKeys?: number,
) {
  let time = 1_700_000_000_000;
  const reports: Array<[string, GroupAckStatus, string]> = [];
  const readRoster = jest.fn(typeof roster === 'function' ? roster : () => Promise.resolve(roster));
  const warn = jest.fn();
  const aggregator = new GroupAckAggregator(
    { readRoster, report: (...args) => reports.push(args), warn, ...overrides },
    () => time,
    maxMessages,
    maxKeys,
  );
  return {
    aggregator,
    reports,
    readRoster,
    warn,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('GroupAckAggregator', () => {
  it('reports delivered once every member has received the message, and read once every member has read it', async () => {
    const { aggregator, reports } = setup();
    await aggregator.record(receipt(ALICE[0], 'delivered'));
    await aggregator.record(receipt(BOB[0], 'delivered'));
    expect(reports).toEqual([]);

    await aggregator.record(receipt(CARA[0], 'delivered'));
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);

    await aggregator.record(receipt(ALICE[0], 'read'));
    await aggregator.record(receipt(BOB[0], 'read'));
    expect(reports).toHaveLength(1);

    await aggregator.record(receipt(CARA[0], 'read'));
    expect(reports).toEqual([
      ['M1', 'delivered', GROUP],
      ['M1', 'read', GROUP],
    ]);
  });

  it('counts a member once however many devices report', async () => {
    const { aggregator, reports } = setup();
    for (let device = 0; device < 3; device++) await aggregator.record(receipt(ALICE[0], 'delivered'));
    await aggregator.record(receipt(BOB[0], 'delivered'));
    expect(reports).toEqual([]);

    await aggregator.record(receipt(CARA[0], 'delivered'));
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);
  });

  it('treats a read receipt as a delivery too, and reports delivered before read', async () => {
    const { aggregator, reports } = setup();
    for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'read'));
    expect(reports).toEqual([
      ['M1', 'delivered', GROUP],
      ['M1', 'read', GROUP],
    ]);
  });

  it('treats a played receipt as read', async () => {
    const { aggregator, reports } = setup();
    for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'played'));
    expect(reports.map(([, status]) => status)).toEqual(['delivered', 'read']);
  });

  it('matches a member by the lid or by the phone number the roster lists for them', async () => {
    const { aggregator, reports } = setup();
    await aggregator.record(receipt(ALICE[0], 'delivered'));
    await aggregator.record(receipt('6282222222222@c.us', 'delivered'));
    await aggregator.record(receipt('333333333333333@lid', 'delivered'));
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);
  });

  it('resolves a lid that the roster lists only as a phone number', async () => {
    const roster = [['6281111111111@s.whatsapp.net'], ['6282222222222@s.whatsapp.net']];
    const resolvePhone = jest.fn((jid: string) => (jid === '111111111111111@lid' ? '6281111111111' : null));
    const { aggregator, reports } = setup(roster, { resolvePhone });
    await aggregator.record(receipt('111111111111111@lid', 'delivered'));
    await aggregator.record(receipt('6282222222222@c.us', 'delivered'));
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);
  });

  it('ignores a participant the roster does not name', async () => {
    const { aggregator, reports } = setup();
    await aggregator.record(receipt('999999999999999@lid', 'read'));
    await aggregator.record(receipt(ALICE[0], 'delivered'));
    await aggregator.record(receipt(BOB[0], 'delivered'));
    expect(reports).toEqual([]);
  });

  it('leaves a message below the status a silent member has not reached', async () => {
    const { aggregator, reports } = setup();
    for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'delivered'));
    await aggregator.record(receipt(ALICE[0], 'read'));
    await aggregator.record(receipt(BOB[0], 'read'));
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);
  });

  it('reads the roster once for the receipts of a message that arrive together', async () => {
    const { aggregator, reports, readRoster } = setup();
    await Promise.all(
      [ALICE, BOB, CARA].flatMap(member => [
        aggregator.record(receipt(member[0], 'delivered')),
        aggregator.record(receipt(member[1], 'delivered')),
      ]),
    );
    expect(readRoster).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);
  });

  it('reads the roster once per message, and does not start a finished message over', async () => {
    const { aggregator, reports, readRoster } = setup();
    for (const status of ['delivered', 'read'] as const) {
      for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], status));
    }
    expect(reports).toHaveLength(2);

    await aggregator.record(receipt(ALICE[1], 'read'));
    expect(reports).toHaveLength(2);
    expect(readRoster).toHaveBeenCalledTimes(1);

    await aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
    expect(readRoster).toHaveBeenCalledTimes(2);
  });

  it('waits for nobody when this account is alone in the group', async () => {
    const { aggregator, reports, readRoster } = setup([]);
    await aggregator.record(receipt(ALICE[0], 'delivered'));
    await aggregator.record(receipt(ALICE[0], 'read'));
    expect(reports).toEqual([]);
    expect(readRoster).toHaveBeenCalledTimes(1);
  });

  it('skips roster entries that carry no usable id and merges entries that name the same member', async () => {
    const roster = [[], ['not-a-jid'], ALICE, [ALICE[1]], BOB];
    const { aggregator, reports } = setup(roster);
    await aggregator.record(receipt(ALICE[0], 'delivered'));
    await aggregator.record(receipt(BOB[0], 'delivered'));
    expect(reports).toEqual([['M1', 'delivered', GROUP]]);
  });

  describe('when the roster cannot be read', () => {
    it.each([
      ['answers null', () => Promise.resolve(null)],
      ['throws', () => Promise.reject(new Error('WhatsApp did not answer'))],
    ])('reports nothing and tries again after the retry delay when the read %s', async (_how, first) => {
      const reads = [first, () => Promise.resolve(ROSTER)];
      const { aggregator, reports, readRoster, warn, advance } = setup(() => (reads.shift() ?? reads[0])());

      await aggregator.record(receipt(ALICE[0], 'delivered'));
      await aggregator.record(receipt(BOB[0], 'delivered'));
      expect(readRoster).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([]);

      advance(GROUP_ACK_RETRY_MS);
      for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'delivered'));
      expect(readRoster).toHaveBeenCalledTimes(2);
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);
      expect(warn).toHaveBeenCalledTimes(_how === 'throws' ? 1 : 0);
    });
  });

  it('ignores the receipts of a status post and of chats that are not groups', async () => {
    const { aggregator, reports, readRoster } = setup();
    await aggregator.record(receipt(ALICE[0], 'delivered', 'ST1', 'status@broadcast'));
    await aggregator.record(receipt(ALICE[0], 'delivered', 'DM1', '6281111111111@c.us'));
    expect(readRoster).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it('keeps going when handing an ack to the engine throws', async () => {
    const report = jest.fn(() => {
      throw new Error('callback failed');
    });
    const { aggregator, warn } = setup(ROSTER, { report });
    for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'read'));
    expect(report).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  describe('bounds', () => {
    it('drops the message heard from longest ago once past the limit', async () => {
      const { aggregator, readRoster } = setup(ROSTER, {}, 2);
      for (const id of ['M1', 'M2', 'M3']) await aggregator.record(receipt(ALICE[0], 'delivered', id));
      expect(readRoster).toHaveBeenCalledTimes(3);

      await aggregator.record(receipt(BOB[0], 'delivered', 'M3'));
      expect(readRoster).toHaveBeenCalledTimes(3);
      await aggregator.record(receipt(BOB[0], 'delivered', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(4);
    });

    it('drops the messages heard from longest ago once the member ids they hold pass the budget', async () => {
      // A message holds 6 roster ids and room for 6 marks, so a budget of 20 keeps one message at a time.
      const { aggregator, readRoster } = setup(ROSTER, {}, 500, 20);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
      expect(readRoster).toHaveBeenCalledTimes(2);

      await aggregator.record(receipt(BOB[0], 'delivered', 'M2'));
      expect(readRoster).toHaveBeenCalledTimes(2);
      await aggregator.record(receipt(BOB[0], 'delivered', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(3);
    });

    it('keeps the newest message even when it alone passes the budget', async () => {
      const { aggregator, reports } = setup(ROSTER, {}, 500, 1);
      for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'delivered'));
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);
    });

    it('moves a message that is heard from to the newest place', async () => {
      const { aggregator, readRoster } = setup(ROSTER, {}, 2);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
      await aggregator.record(receipt(BOB[0], 'delivered', 'M1'));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M3'));
      expect(readRoster).toHaveBeenCalledTimes(3);

      await aggregator.record(receipt(CARA[0], 'delivered', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(3);
    });

    it('forgets a message that has not been heard from for the follow period', async () => {
      const { aggregator, readRoster, advance } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      advance(GROUP_ACK_FOLLOW_MS - 1);
      await aggregator.record(receipt(BOB[0], 'delivered'));
      expect(readRoster).toHaveBeenCalledTimes(1);

      advance(GROUP_ACK_FOLLOW_MS);
      await aggregator.record(receipt(CARA[0], 'delivered'));
      expect(readRoster).toHaveBeenCalledTimes(2);
    });
  });
});
