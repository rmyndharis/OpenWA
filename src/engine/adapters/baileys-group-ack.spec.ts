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
  roster: string[][] | null | ((groupId: string) => Promise<string[][] | null>) = ROSTER,
  overrides: Partial<GroupAckHost> = {},
  maxMessages?: number,
  maxKeys?: number,
  maxHeld?: number,
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
    maxHeld,
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

  it('reads the roster of a group once for the messages that arrive together', async () => {
    const { aggregator, reports, readRoster } = setup();
    await Promise.all(
      ['M1', 'M2', 'M3'].flatMap(id => [ALICE, BOB, CARA].map(m => aggregator.record(receipt(m[0], 'delivered', id)))),
    );
    expect(readRoster).toHaveBeenCalledTimes(1);
    expect(reports.map(([id]) => id).sort()).toEqual(['M1', 'M2', 'M3']);
  });

  it('keeps messages that share an id in different chats apart', async () => {
    const other = '120363000000000002@g.us';
    const dave = '444444444444444@lid';
    const erin = '555555555555555@lid';
    const rosters: Record<string, string[][]> = { [GROUP]: ROSTER, [other]: [[dave], [erin]] };
    const { aggregator, reports } = setup(groupId => Promise.resolve(rosters[groupId]));
    await aggregator.record(receipt(ALICE[0], 'delivered', 'M1', GROUP));
    await aggregator.record(receipt(dave, 'delivered', 'M1', other));
    await aggregator.record(receipt(erin, 'delivered', 'M1', other));
    expect(reports).toEqual([['M1', 'delivered', other]]);

    await aggregator.record(receipt(BOB[0], 'delivered', 'M1', GROUP));
    await aggregator.record(receipt(CARA[0], 'delivered', 'M1', GROUP));
    expect(reports).toEqual([
      ['M1', 'delivered', other],
      ['M1', 'delivered', GROUP],
    ]);
  });

  describe('when the roster cannot be read', () => {
    it('does not read the group again for another message until the retry delay has passed', async () => {
      const { aggregator, reports, readRoster, advance } = setup(null);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M3'));
      expect(readRoster).toHaveBeenCalledTimes(1);

      advance(GROUP_ACK_RETRY_MS);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M4'));
      expect(readRoster).toHaveBeenCalledTimes(2);
      expect(reports).toEqual([]);
    });

    it('still reads a different group meanwhile, and remembers only a bounded number of unreadable groups', async () => {
      const failing = new Set<string>();
      const { aggregator, readRoster, reports } = setup(groupId =>
        Promise.resolve(failing.has(groupId) ? null : ROSTER),
      );
      const groupId = (n: number): string => `1203630000000${String(n).padStart(5, '0')}@g.us`;
      for (let n = 0; n < 300; n++) failing.add(groupId(n));
      for (let n = 0; n < 300; n++) await aggregator.record(receipt(ALICE[0], 'delivered', 'M1', groupId(n)));
      expect(readRoster).toHaveBeenCalledTimes(300);

      // the oldest unreadable groups were forgotten, so they are read again at once; the newest are not
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2', groupId(0)));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2', groupId(299)));
      expect(readRoster).toHaveBeenCalledTimes(301);

      await aggregator.record(receipt(ALICE[0], 'delivered', 'M3', '120363000000999999@g.us'));
      expect(readRoster).toHaveBeenCalledTimes(302);
      expect(reports).toEqual([]);
    });

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

  describe('receipts held while the roster cannot be read', () => {
    // The first read fails, every later one answers: what a dropped query followed by a working socket looks like.
    const recovering = (): (() => Promise<string[][] | null>) => {
      const failures = [() => Promise.resolve(null)];
      return () => (failures.shift() ?? (() => Promise.resolve(ROSTER)))();
    };

    it('are counted once a later receipt of the message finds the roster readable', async () => {
      const read = recovering();
      const { aggregator, reports, advance } = setup(() => read());
      for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'delivered'));
      expect(reports).toEqual([]);

      advance(GROUP_ACK_RETRY_MS);
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);
    });

    it('are counted in order, so a held read still completes delivered before read', async () => {
      const read = recovering();
      const { aggregator, reports, advance } = setup(() => read());
      for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], 'read'));
      advance(GROUP_ACK_RETRY_MS);
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      expect(reports.map(([, status]) => status)).toEqual(['delivered', 'read']);
    });

    it('are bounded, and the receipts of the oldest message are given up first', async () => {
      const read = recovering();
      const { aggregator, reports, advance } = setup(() => read(), {}, undefined, undefined, 3);
      for (const id of ['M1', 'M2']) {
        await aggregator.record(receipt(ALICE[0], 'delivered', id));
        await aggregator.record(receipt(BOB[0], 'delivered', id));
      }
      advance(GROUP_ACK_RETRY_MS);
      await aggregator.record(receipt(CARA[0], 'delivered', 'M1'));
      await aggregator.record(receipt(CARA[0], 'delivered', 'M2'));
      expect(reports).toEqual([['M2', 'delivered', GROUP]]);
    });

    it('are let go when the message turns out to have no one to wait for', async () => {
      const reads = [() => Promise.resolve(null), () => Promise.resolve([])];
      const { aggregator, reports, readRoster, advance } = setup(() => (reads.shift() ?? reads[0])());
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      advance(GROUP_ACK_RETRY_MS);
      await aggregator.record(receipt(BOB[0], 'delivered'));
      await aggregator.record(receipt(CARA[0], 'delivered'));
      expect(reports).toEqual([]);
      expect(readRoster).toHaveBeenCalledTimes(2);
    });
  });

  describe('a member who leaves the group', () => {
    it('is no longer waited for, which completes the messages it was the last to hold up', async () => {
      const { aggregator, reports } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      await aggregator.record(receipt(BOB[0], 'delivered'));
      expect(reports).toEqual([]);

      aggregator.forget(GROUP, [CARA[0]]);
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);

      await aggregator.record(receipt(ALICE[0], 'read'));
      await aggregator.record(receipt(BOB[0], 'read'));
      expect(reports.map(([, status]) => status)).toEqual(['delivered', 'read']);
    });

    it('is matched by the phone number the departure names as well as by lid', async () => {
      const { aggregator, reports } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      await aggregator.record(receipt(BOB[0], 'delivered'));
      aggregator.forget(GROUP, [CARA[1]]);
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);
    });

    it('takes its own receipts out of the count', async () => {
      const { aggregator, reports } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      await aggregator.record(receipt(BOB[0], 'delivered'));
      aggregator.forget(GROUP, [ALICE[0]]);
      expect(reports).toEqual([]);

      await aggregator.record(receipt(CARA[0], 'delivered'));
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);
    });

    it('changes nothing for someone who is not followed, for another group, or for a finished message', async () => {
      const { aggregator, reports } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      aggregator.forget(GROUP, ['999999999999999@lid', 'not-a-jid']);
      aggregator.forget('120363000000000009@g.us', [BOB[0], CARA[0]]);
      expect(reports).toEqual([]);

      for (const status of ['delivered', 'read'] as const) {
        for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], status, 'M2'));
      }
      expect(reports).toHaveLength(2);
      aggregator.forget(GROUP, [CARA[0]]);
      expect(reports).toHaveLength(2);
    });

    it('ends the following of a message once every member has left, with nothing reported', async () => {
      const { aggregator, reports, readRoster } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered'));
      aggregator.forget(GROUP, [ALICE[0], BOB[0], CARA[0]]);
      await aggregator.record(receipt(BOB[0], 'delivered'));
      expect(reports).toEqual([]);
      expect(readRoster).toHaveBeenCalledTimes(1);
    });

    it('leaves the budget exact when completing one message drops expired ones the departure was still to visit', async () => {
      const { aggregator, reports, advance } = setup();
      await aggregator.record(receipt(ALICE[0], 'delivered', 'MA'));
      await aggregator.record(receipt(ALICE[0], 'read', 'MK'));
      await aggregator.record(receipt(BOB[0], 'read', 'MK'));
      await aggregator.record(receipt(ALICE[0], 'delivered', 'MB'));
      advance(GROUP_ACK_FOLLOW_MS + 1);

      aggregator.forget(GROUP, [CARA[0]]);
      expect(reports.map(([id, status]) => `${id} ${status}`)).toEqual(['MK delivered', 'MK read']);
      // only the fresh record of the finished message is left, and it weighs 1
      expect((aggregator as unknown as { weight: number }).weight).toBe(1);
    });

    it('keeps the budget in step with the members that remain', async () => {
      // M1 holds 6 ids and room for 6 marks (12), and 8 once CARA has left; M2 holds 12: 20 fits a budget of 20.
      const { aggregator, readRoster } = setup(ROSTER, {}, 500, 20);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      aggregator.forget(GROUP, [CARA[0]]);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
      await aggregator.record(receipt(BOB[0], 'delivered', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(2);
    });
  });

  describe('members who join or leave while the roster is read', () => {
    // A roster read that stays open until the test answers it, and the answers still owed.
    const gated = () => {
      const answers: Array<(roster: string[][] | null) => void> = [];
      const read = () => new Promise<string[][] | null>(resolve => answers.push(resolve));
      return { read, answers };
    };
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('reads again for a message whose roster read began before a member joined, and for one that arrives after', async () => {
      const { read, answers } = gated();
      const { aggregator, readRoster, reports } = setup(read);
      const first = aggregator.record(receipt(ALICE[0], 'delivered', 'M0'));
      aggregator.membershipChanged(GROUP); // Bob joins while the read for M0 is out
      const second = aggregator.record(receipt(ALICE[0], 'read', 'M1')); // M1 reaches Bob too
      expect(readRoster).toHaveBeenCalledTimes(2);

      answers[0]([ALICE]); // the answer to the read that began before Bob joined
      await flush();
      answers[1]([ALICE, BOB]);
      await Promise.all([first, second]);
      expect(readRoster).toHaveBeenCalledTimes(2);
      expect(reports).toEqual([]);

      await aggregator.record(receipt(BOB[0], 'delivered', 'M1'));
      expect(reports).toEqual([['M1', 'delivered', GROUP]]);
    });

    it('applies a departure that happens before the first roster read ends', async () => {
      const { read, answers } = gated();
      const { aggregator, reports } = setup(read);
      const first = aggregator.record(receipt(ALICE[0], 'read', 'M1'));
      aggregator.membershipChanged(GROUP); // what the leave handler tells it, then it forgets the leaver
      aggregator.forget(GROUP, [BOB[0]]); // no message is followed yet, so there is nothing to drop

      answers[0]([ALICE, BOB]); // read before Bob left
      await flush();
      answers[1]([ALICE]);
      await first;
      expect(reports).toEqual([
        ['M1', 'delivered', GROUP],
        ['M1', 'read', GROUP],
      ]);
    });

    it('gives up repeating a read when the members keep changing', async () => {
      const { read, answers } = gated();
      const { aggregator, readRoster } = setup(read);
      const pending = aggregator.record(receipt(ALICE[0], 'read', 'M1'));
      for (let n = 0; n < 5; n++) {
        aggregator.membershipChanged(GROUP);
        answers[n](ROSTER);
        await flush();
      }
      await pending;
      expect(readRoster).toHaveBeenCalledTimes(5);
    });

    it('lets neither the end nor the failure of a replaced read touch the read that replaced it', async () => {
      const { read, answers } = gated();
      const { aggregator, readRoster, reports } = setup(read);
      const first = aggregator.record(receipt(ALICE[0], 'delivered', 'M0'));
      aggregator.membershipChanged(GROUP);
      const second = aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(2);

      answers[0](null); // the replaced read fails
      await flush();
      // a message that starts now joins the read in progress, and the group is not held back as unreadable
      const third = aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
      expect(readRoster).toHaveBeenCalledTimes(2);
      answers[1](ROSTER);
      await Promise.all([first, second, third]);

      const fourth = aggregator.record(receipt(ALICE[0], 'delivered', 'M3'));
      expect(readRoster).toHaveBeenCalledTimes(3);
      answers[2](ROSTER);
      await fourth;
      expect(reports).toEqual([]);
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

    it('frees the budget of a message it drops', async () => {
      // A message weighs 12 here, so a budget of 30 keeps two: the third drops the first, not the second.
      const { aggregator, readRoster } = setup(ROSTER, {}, 500, 30);
      for (const id of ['M1', 'M2', 'M3']) await aggregator.record(receipt(ALICE[0], 'delivered', id));
      expect(readRoster).toHaveBeenCalledTimes(3);

      await aggregator.record(receipt(BOB[0], 'delivered', 'M2'));
      expect(readRoster).toHaveBeenCalledTimes(3);
      await aggregator.record(receipt(BOB[0], 'delivered', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(4);
    });

    it('frees the budget of a finished message, and still remembers that it finished', async () => {
      // A finished message weighs 1, so with a budget of 14 it fits beside a followed one (12).
      const { aggregator, readRoster, reports } = setup(ROSTER, {}, 500, 14);
      for (const status of ['delivered', 'read'] as const) {
        for (const member of [ALICE, BOB, CARA]) await aggregator.record(receipt(member[0], status, 'M1'));
      }
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M2'));
      expect(readRoster).toHaveBeenCalledTimes(2);

      await aggregator.record(receipt(ALICE[0], 'read', 'M1'));
      expect(readRoster).toHaveBeenCalledTimes(2);
      expect(reports).toHaveLength(2);
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

    it('remembers a finished message for the follow period after its latest receipt', async () => {
      const { aggregator, reports, advance } = setup([ALICE]);
      await aggregator.record(receipt(ALICE[0], 'read', 'M1'));
      expect(reports).toEqual([
        ['M1', 'delivered', GROUP],
        ['M1', 'read', GROUP],
      ]);

      // a second device of the member keeps reporting, each time less than the period after the one before
      advance(GROUP_ACK_FOLLOW_MS - 1000);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      advance(GROUP_ACK_FOLLOW_MS - 1000);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      expect(reports).toHaveLength(2);

      advance(GROUP_ACK_FOLLOW_MS);
      await aggregator.record(receipt(ALICE[0], 'delivered', 'M1'));
      expect(reports).toHaveLength(3);
    });
  });
});
