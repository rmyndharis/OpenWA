import type { WACallEvent, WASocket } from '@whiskeysockets/baileys';
import type { CallOutcomeEvent } from '../interfaces/whatsapp-engine.interface';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { toNeutralJid } from '../identity/wa-id';
import { BaileysEvents, BaileysEventsHost } from './baileys-events';

const CALL_ID = 'CALL1';
const CALLER = '628111@s.whatsapp.net';
// A signal is dated in the past, so an outcome it published is told from one stamped when a rejection ends.
const SIGNAL_DATE = new Date(1_700_000_000_000);
const call = (status: string, from = CALLER, date = new Date()): WACallEvent =>
  ({ id: CALL_ID, from, chatId: from, status, offline: false, date }) as unknown as WACallEvent;

function setup(first: WACallEvent = call('offer'), neutral: (jid: string) => string = jid => jid) {
  const outcomes: CallOutcomeEvent[] = [];
  const rings: unknown[] = [];
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const socket = {
    rejectCall: jest.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    ),
  } as unknown as WASocket;
  const host = {
    logger: { debug: () => undefined, warn: () => undefined },
    normalizedSelfJid: () => '99999@s.whatsapp.net',
    toNeutralJid: neutral,
    getSocketOrNull: () => socket,
    getOnCall: () => (ring: unknown) => rings.push(ring),
    getOnCallOutcome: () => (outcome: CallOutcomeEvent) => outcomes.push(outcome),
  } as unknown as BaileysEventsHost;
  const events = new BaileysEvents(host);
  events.handleCallEvents([first]);
  return { events, outcomes, rings, socket, settle: () => settle };
}

describe('a call signal that arrives while its rejection is pending', () => {
  it.each([
    ['accept', 'accepted'],
    ['reject', 'rejected'],
    ['timeout', 'missed'],
  ])('is published as %s, and the later answer adds nothing', async (status, outcome) => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call(status, CALLER, SIGNAL_DATE)]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome, timestamp: 1_700_000_000 })]);
  });

  it.each([
    ['accept', 'accepted'],
    ['reject', 'rejected'],
    ['timeout', 'missed'],
  ])('is published as %s even when the rejection then fails', async (status, outcome) => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call(status, CALLER, SIGNAL_DATE)]);
    settle().reject(new Error('Connection Closed'));
    await expect(attempt).rejects.toThrow('Connection Closed');

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome, timestamp: 1_700_000_000 })]);
  });

  it.each(['accept', 'timeout', 'terminate'])(
    'leaves the call gone when %s ended it and the rejection then fails',
    async status => {
      const { events, settle } = setup();
      const attempt = events.rejectCall(CALL_ID);

      events.handleCallEvents([call(status)]);
      settle().reject(new Error('Connection Closed'));
      await expect(attempt).rejects.toThrow('Connection Closed');

      await expect(events.rejectCall(CALL_ID)).rejects.toBeInstanceOf(CallNotFoundError);
    },
  );

  it('does not report the old rejection of a call that rang again', async () => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call('offer', '628222@s.whatsapp.net')]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([]);
  });

  it('still reports its own success when nothing else happened', async () => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
  });

  it('keeps the call rejectable after a plain failure', async () => {
    const { events, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    settle().reject(new Error('Connection Closed'));
    await expect(attempt).rejects.toThrow('Connection Closed');
    const retry = events.rejectCall(CALL_ID);
    settle().resolve();

    await expect(retry).resolves.toBeUndefined();
  });

  it('reports the rejection it asked for when a terminate came first and it then succeeds', async () => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call('terminate')]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected', from: CALLER })]);
    await expect(events.rejectCall(CALL_ID)).rejects.toBeInstanceOf(CallNotFoundError);
  });

  it('reports the rejection once when a terminate comes after the answer', async () => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    settle().resolve();
    await attempt;
    events.handleCallEvents([call('terminate')]);

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
  });

  it.each(['accept', 'timeout'])('lets %s that follows a terminate publish its own outcome, once', async status => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call('terminate'), call(status, CALLER, SIGNAL_DATE)]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, timestamp: 1_700_000_000 })]);
    expect(outcomes[0].outcome).not.toBe('rejected');
  });

  it('reports the rejection it asked for when another tag of the same call arrives and it succeeds', async () => {
    const { events, outcomes, rings, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call('offer')]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
    expect(rings).toHaveLength(1);
    await expect(events.rejectCall(CALL_ID)).rejects.toBeInstanceOf(CallNotFoundError);
  });

  it('keeps the call rejectable when another tag of the same call arrives and the rejection fails', async () => {
    const { events, outcomes, rings, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call('offer')]);
    settle().reject(new Error('Connection Closed'));
    await expect(attempt).rejects.toThrow('Connection Closed');
    const retry = events.rejectCall(CALL_ID);
    settle().resolve();
    await retry;

    expect(rings).toHaveLength(1);
    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
  });

  it('leaves the call gone when a terminate came first and the rejection then fails', async () => {
    const { events, outcomes, settle } = setup();
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([call('terminate')]);
    settle().reject(new Error('Connection Closed'));
    await expect(attempt).rejects.toThrow('Connection Closed');

    expect(outcomes).toEqual([]);
    await expect(events.rejectCall(CALL_ID)).rejects.toBeInstanceOf(CallNotFoundError);
  });
});

describe('another tag of the call being rejected, spelled with the other identity form', () => {
  const LID = '1234@lid';
  const PHONE_ID = '628111@s.whatsapp.net';
  const resolved = (jid: string): string => (jid === LID || jid === PHONE_ID ? '628111@c.us' : jid);
  const tag = (from: string, callerPn?: string): WACallEvent => ({ ...call('offer', from), callerPn });

  // Baileys reads `from` and `callerPn` off each tag. It fills a missing callerPn from its offer cache only on
  // the tags that are not offers, so a repeat offer keeps just the callerPn it carries, and the same caller
  // can be spelled as a lid on one tag and as a phone number on the next.
  const spellings: Array<[string, WACallEvent, WACallEvent]> = [
    ['lid then phone', tag(LID, PHONE_ID), tag(PHONE_ID, PHONE_ID)],
    ['phone then lid', tag(PHONE_ID, PHONE_ID), tag(LID, PHONE_ID)],
  ];

  it.each(spellings)(
    'is the same call after %s, so its success reports one rejection',
    async (_name, first, repeat) => {
      const { events, outcomes, rings, settle } = setup(first, resolved);
      const attempt = events.rejectCall(CALL_ID);

      events.handleCallEvents([repeat]);
      settle().resolve();
      await attempt;

      expect(outcomes).toEqual([
        expect.objectContaining({ callId: CALL_ID, outcome: 'rejected', from: '628111@c.us' }),
      ]);
      expect(rings).toHaveLength(1);
      await expect(events.rejectCall(CALL_ID)).rejects.toBeInstanceOf(CallNotFoundError);
    },
  );

  it.each(spellings)(
    'is the same call after %s, so its failure leaves one rejectable call',
    async (_name, first, repeat) => {
      const { events, outcomes, rings, settle } = setup(first, resolved);
      const attempt = events.rejectCall(CALL_ID);

      events.handleCallEvents([repeat]);
      settle().reject(new Error('Connection Closed'));
      await expect(attempt).rejects.toThrow('Connection Closed');
      const retry = events.rejectCall(CALL_ID);
      settle().resolve();
      await retry;

      expect(rings).toHaveLength(1);
      expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
    },
  );

  // The device suffix a jid may carry is not part of the caller: the neutral form drops it, the raw jid does not.
  it.each([
    ['lid', '1234:7@lid', '1234@lid'],
    ['phone', '628111:7@s.whatsapp.net', '628111@s.whatsapp.net'],
  ])('is the same call when only the device of the %s caller differs', async (_name, withDevice, bare) => {
    const { events, outcomes, rings, settle } = setup(tag(withDevice), toNeutralJid);
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([tag(bare)]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
    expect(rings).toHaveLength(1);
  });

  // The same raw caller stays the same call even when the lid resolved after the first tag changed its neutral form.
  it('is the same call when the same lid resolved to a phone number after the first tag', async () => {
    let learned = false;
    const { events, outcomes, rings, settle } = setup(tag(LID), jid => (learned && jid === LID ? '628111@c.us' : jid));
    const attempt = events.rejectCall(CALL_ID);

    learned = true;
    events.handleCallEvents([tag(LID)]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([expect.objectContaining({ callId: CALL_ID, outcome: 'rejected' })]);
    expect(rings).toHaveLength(1);
  });

  it('is another call when a different caller reuses the id', async () => {
    const { events, outcomes, rings, settle } = setup(tag(LID, PHONE_ID), resolved);
    const attempt = events.rejectCall(CALL_ID);

    events.handleCallEvents([tag('628222@s.whatsapp.net')]);
    settle().resolve();
    await attempt;

    expect(outcomes).toEqual([]);
    expect(rings).toHaveLength(2);
  });
});
