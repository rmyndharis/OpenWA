import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost, type GroupMember } from './baileys-events';
import { BaileysSessionStore } from './baileys-session-store';
import { userPart } from '../identity/wa-id';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * WhatsApp clients honour a group delete of someone else's message only from a group admin. Baileys hands any
 * member's delete through, so the stored copy, the chat preview and message.revoked follow one only when the
 * group's roster does not show its sender is no admin. The roster is read only where it decides something, and a
 * roster that cannot be read lets the delete through, as before.
 */

const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) =>
    Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const GROUP = '120363000000000001@g.us';
const ALICE = '628111@s.whatsapp.net';
const BOB = '628333@s.whatsapp.net';
const ADMIN = '628444@s.whatsapp.net';

type Roster = (groupId: string) => Promise<Array<{ ids: string[]; admin: boolean }> | null>;
const roster: Roster = () =>
  Promise.resolve([
    { ids: [ALICE], admin: false },
    { ids: [BOB], admin: false },
    { ids: ['900444@lid', ADMIN], admin: true },
  ]);
/** The same members, with the ones the group addresses by lid listed under it as well. */
const lidRoster: Roster = () =>
  Promise.resolve([
    { ids: [ALICE, '900111@lid'], admin: false },
    { ids: [BOB, '900333@lid'], admin: false },
    { ids: ['900444@lid', ADMIN], admin: true },
  ]);

/** `peek` is the cached roster; `held` has the session keep every message it is handed without an outcome. */
function build(
  readGroupMembers?: Roster,
  options: { peek?: () => GroupMember[] | null; held?: boolean; pairs?: Record<string, string> } = {},
) {
  const store = new BaileysSessionStore(undefined, 's1');
  store.upsertChats([{ id: GROUP }]);
  const raw = new Map<string, WAMessage>();
  const revoked = jest.fn();
  const members = readGroupMembers ? jest.fn(readGroupMembers) : undefined;
  const noop = (): undefined => undefined;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-group-revoke-admin.spec'),
    loadLib: () => Promise.resolve(lib),
    getFetchDispatcher: noop,
    toNeutralJid: (jid: string) => store.toNeutralJid(jid),
    normalizedSelfJid: () => '628222@s.whatsapp.net',
    inboundLimiter: new ConcurrencyLimiter(2),
    recordKeyLidMappings: noop,
    recordMessage: (msg: WAMessage, type?: Parameters<BaileysSessionStore['recordMessage']>[1], order?: number) =>
      store.recordMessage(msg, type, order),
    nextMessageOrder: () => store.nextMessageOrder(),
    recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
      store.recordMessageEdit(...args),
    consumeOwnSend: () => false,
    getStoredMessage: (id: string) => Promise.resolve(raw.get(id) ?? null),
    putStoredMessage: (msg: WAMessage) => {
      raw.set(msg.key.id!, msg);
      return Promise.resolve();
    },
    updateStoredMessage: (id: string, change: (stored: WAMessage) => WAMessage | null) => {
      const stored = raw.get(id);
      const next = stored && change(stored);
      if (next) raw.set(id, next);
      return Promise.resolve();
    },
    removeStoredMessage: noop,
    getOnMessage: options.held ? () => () => ({ settled: new Promise<undefined>(() => undefined) }) : noop,
    getOnMessageCreate: noop,
    getOnMessageRevoked: () => revoked,
    getOnMessageEdited: noop,
    getOnMessageReaction: noop,
    getOnMessageAck: noop,
    getOnMessageReceipt: noop,
    getOnGroupEvent: noop,
    getOnEventResponse: noop,
    findContact: () => null,
    getOnCall: noop,
    getOnPresenceUpdate: noop,
    getOnCallOutcome: noop,
    readGroupMembers: members,
    peekGroupMembers: options.peek,
    // The pairings the gateway holds as reported, by the digits of the lid (the device suffix does not count).
    findPersistedLidPhone: (jid: string) => Promise.resolve(options.pairs?.[userPart(jid)] ?? null),
  };
  const events = new BaileysEvents(host);
  const posted = (id: string, key: WAMessage['key'], text: string): void => {
    const msg: WAMessage = { key: { id, ...key }, message: { conversation: text }, messageTimestamp: 1_700_000_000 };
    raw.set(id, msg);
    store.recordMessage(msg, 'text');
  };
  const deleteOf = async (id: string, by: WAMessage['key'], target: WAMessage['key']): Promise<void> => {
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: `DEL-${id}`, remoteJid: GROUP, fromMe: false, ...by },
          message: { protocolMessage: { type: 0, key: { id, remoteJid: GROUP, ...target } } },
          messageTimestamp: 1_700_000_500,
        },
      ],
    });
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const preview = () => store.listChats().find(chat => chat.id === GROUP)?.lastMessage;
  return { events, store, raw, revoked, members, posted, deleteOf, preview };
}

describe('Baileys group delete of another member message', () => {
  it('leaves the stored copy and the preview, announcing nothing, when the sender is no admin', async () => {
    const { raw, revoked, posted, deleteOf, preview } = build(roster);
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'meeting at 3');

    await deleteOf('A1', { participant: BOB }, { fromMe: false, participant: ALICE });

    expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    expect(preview()).toBe('meeting at 3');
    expect(revoked).not.toHaveBeenCalled();
  });

  it('leaves a message the account sent when a member who is no admin deletes it', async () => {
    const { raw, revoked, posted, deleteOf } = build(roster);
    posted('O1', { remoteJid: GROUP, fromMe: true }, 'mine');

    await deleteOf('O1', { participant: BOB }, { fromMe: false, participant: '628222@s.whatsapp.net' });

    expect(raw.get('O1')?.message).toEqual({ conversation: 'mine' });
    expect(revoked).not.toHaveBeenCalled();
  });

  it.each([
    ['its phone number', ADMIN, ALICE, '628444@c.us'],
    ['its lid, in a group addressed by lid', '900444@lid', '900111@lid', '900444@lid'],
  ])('applies an admin delete named by %s, and says who sent it', async (_how, admin, author, neutral) => {
    const { raw, revoked, posted, deleteOf, preview } = build(roster);
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: author }, 'meeting at 3');

    await deleteOf('A1', { participant: admin }, { fromMe: false, participant: author });

    expect(raw.get('A1')?.message).toBeNull();
    expect(preview()).toBe('');
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ id: 'A1' }), {
      fromMe: false,
      participant: neutral,
      admin: true,
    });
  });

  it('reads no roster when the sender lid cannot be compared with the author number', async () => {
    const { raw, members, posted, deleteOf } = build(roster);
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'meeting at 3');

    await deleteOf('A1', { participant: '900333@lid' }, { fromMe: false, participant: ALICE });

    expect(members).not.toHaveBeenCalled();
    expect(raw.get('A1')?.message).toBeNull();
  });

  // A sender known by a lid and an author known by a number are one person only if a reported pairing says so. With a
  // pairing that names another number the copy is not the sender's, so the roster is read and settles it.
  it('reads the roster when a reported pairing shows the sender lid is not the author', async () => {
    const { raw, revoked, members, posted, deleteOf, preview } = build(lidRoster, { pairs: { '900333': '628333' } });
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'meeting at 3');

    await deleteOf('A1', { participant: '900333@lid' }, { fromMe: false, participant: ALICE });

    expect(members).toHaveBeenCalledTimes(1);
    expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    expect(preview()).toBe('meeting at 3');
    // The session is told the sender is no admin and judges the row it holds under that id itself.
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ id: 'A1' }), {
      fromMe: false,
      participant: '900333@lid',
      admin: false,
    });
  });

  it('reads no roster when a reported pairing shows the sender lid is the author', async () => {
    const { raw, members, posted, deleteOf } = build(roster, { pairs: { '900111': '628111' } });
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'oops');

    await deleteOf('A1', { participant: '900111@lid' }, { fromMe: false, participant: ALICE });

    expect(members).not.toHaveBeenCalled();
    expect(raw.get('A1')?.message).toBeNull();
  });

  // The roster may list a member by number only while the delete names its sender by lid with the number beside it. The
  // table holds that pairing too, as the gateway records it from the key, and it does not make the sender the author.
  it('matches the roster by the number the delete carries beside the sender lid', async () => {
    const { raw, revoked, members, posted, deleteOf } = build(roster, { pairs: { '900333': '628333' } });
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: '900111@lid' }, 'meeting at 3');

    await deleteOf(
      'A1',
      { participant: '900333@lid', participantAlt: BOB },
      { fromMe: false, participant: '900111@lid' },
    );

    expect(members).toHaveBeenCalledTimes(1);
    expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    expect(revoked).not.toHaveBeenCalled();
  });

  // A reported pairing brings a lid and a number together, never two lids. A sender whose lid the table cannot place is
  // not taken for the author because the author's lid, or the sender's own, is placed: two lids are two members.
  it.each([
    ['only the author lid is paired', { '900111': '628111' }, { participant: '900111@lid' }],
    [
      'only the author lid is paired and the stored key carries its number',
      { '900111': '628111' },
      { participant: '900111@lid', participantAlt: ALICE },
    ],
    ['only the sender lid is paired', { '900333': '628333' }, { participant: '900111@lid' }],
    ['both lids are paired to one number', { '900111': '628111', '900333': '628111' }, { participant: '900111@lid' }],
  ])('reads the roster for two different lids when %s', async (_how, pairs, author) => {
    const { raw, revoked, members, posted, deleteOf } = build(lidRoster, { pairs });
    posted('A1', { remoteJid: GROUP, fromMe: false, ...author }, 'meeting at 3');

    await deleteOf('A1', { participant: '900333@lid' }, { fromMe: false, participant: '900111@lid' });

    expect(members).toHaveBeenCalledTimes(1);
    expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    expect(revoked).not.toHaveBeenCalled();
  });

  // A lid in the alt of a stored key is still the author's lid: the sender's lid is a second lid, and a pairing of that
  // lid to the number the stored key carries does not make the two one member.
  it.each([
    ['a lid', '900111@lid'],
    ['a hosted lid', '900111@hosted.lid'],
  ])(
    'reads the roster for two lids when the stored key names its author by number with %s beside it',
    async (_how, alt) => {
      const { raw, members, posted, deleteOf } = build(lidRoster, { pairs: { '900333': '628111' } });
      posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE, participantAlt: alt }, 'meeting at 3');

      await deleteOf('A1', { participant: '900333@lid' }, { fromMe: false, participant: ALICE });

      expect(members).toHaveBeenCalledTimes(1);
      expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    },
  );

  // The author lid is looked up for the chat list preview as well as for the stored copy.
  it('keeps the preview when the pairing of the author lid shows a sender by number is another member', async () => {
    const { raw, members, posted, deleteOf, preview } = build(lidRoster, { pairs: { '900111': '628111' } });
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: '900111@lid' }, 'meeting at 3');

    await deleteOf('A1', { participant: BOB }, { fromMe: false, participant: '900111@lid' });

    expect(members).toHaveBeenCalledTimes(1);
    expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    expect(preview()).toBe('meeting at 3');
  });

  // The pairing, not the number beside the author lid, says who the lid is: a member whose number changed since the
  // message was stored is still its author when the table has moved the lid to the new number.
  it('takes the sender for the author when the pairing of the author lid names the sender number', async () => {
    const { raw, members, posted, deleteOf } = build(lidRoster, { pairs: { '900111': '628555' } });
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: '900111@lid', participantAlt: ALICE }, 'meeting at 3');

    await deleteOf('A1', { participant: '628555@s.whatsapp.net' }, { fromMe: false, participant: '900111@lid' });

    expect(members).not.toHaveBeenCalled();
    expect(raw.get('A1')?.message).toBeNull();
  });

  // The table is trusted for the lid it names, so an author whose number changed after the message was stored is no
  // longer the sender it names: the delete reads as another member's, as an edit by that author does.
  it('reads the roster when the pairing names another number than the one the message was stored under', async () => {
    const { raw, revoked, members, posted, deleteOf } = build(lidRoster, { pairs: { '900111': '628999' } });
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'meeting at 3');

    await deleteOf('A1', { participant: '900111@lid' }, { fromMe: false, participant: ALICE });

    expect(members).toHaveBeenCalledTimes(1);
    expect(raw.get('A1')?.message).toEqual({ conversation: 'meeting at 3' });
    expect(revoked).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'A1' }),
      expect.objectContaining({ admin: false }),
    );
  });

  it('reads no roster for a member deleting their own message', async () => {
    const { raw, revoked, members, posted, deleteOf } = build(roster);
    posted('B1', { remoteJid: GROUP, fromMe: false, participant: BOB }, 'oops');

    await deleteOf('B1', { participant: BOB }, { fromMe: true });

    expect(members).not.toHaveBeenCalled();
    expect(raw.get('B1')?.message).toBeNull();
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ id: 'B1' }), {
      fromMe: false,
      participant: '628333@c.us',
      admin: undefined,
    });
  });

  it.each([
    ['cannot be read', () => Promise.reject(new Error('WhatsApp did not answer the group metadata query in time'))],
    ['does not list the sender', () => Promise.resolve([{ ids: [ALICE], admin: false }])],
    ['is not there', () => Promise.resolve(null)],
  ])('applies the delete as before when the roster %s', async (_label, readGroupMembers: Roster) => {
    const { raw, revoked, posted, deleteOf } = build(readGroupMembers);
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'meeting at 3');

    await deleteOf('A1', { participant: BOB }, { fromMe: false, participant: ALICE });

    expect(raw.get('A1')?.message).toBeNull();
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ id: 'A1' }), {
      fromMe: false,
      participant: '628333@c.us',
      admin: undefined,
    });
  });

  it('reads no roster for a delete that names no message', async () => {
    const { members, deleteOf } = build(roster);

    await deleteOf('', { participant: BOB }, { fromMe: false, participant: ALICE });

    expect(members).not.toHaveBeenCalled();
  });

  it('leaves the chat preview of a message it never stored when the sender holds a message under its id', async () => {
    const cached = [
      { ids: [ALICE], admin: false },
      { ids: [BOB], admin: false },
    ];
    const { events, store, raw, revoked, deleteOf, preview } = build(roster, { peek: () => cached, held: true });
    // The preview holds a message that was synced from history, which the raw store never gets.
    store.recordMessage(
      {
        key: { id: 'A1', remoteJid: GROUP, fromMe: false, participant: ALICE },
        message: { conversation: 'meeting at 3' },
        messageTimestamp: 1_700_000_100,
      },
      'text',
    );
    // His own message under that id is older, so the preview keeps the real one, and is handed on without an outcome.
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'A1', remoteJid: GROUP, fromMe: false, participant: BOB },
          message: { conversation: 'noise' },
          messageTimestamp: 1_699_999_000,
        },
      ],
    });
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    expect(raw.get('A1')?.key.participant).toBe(BOB);

    await deleteOf('A1', { participant: BOB }, { fromMe: false, participant: ALICE });

    expect(preview()).toBe('meeting at 3');
    expect(raw.get('A1')?.message).toBeNull();
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ id: 'A1' }), {
      fromMe: false,
      participant: '628333@c.us',
      admin: false,
    });
  });

  it('applies the account own delete from its phone without reading the roster', async () => {
    const { raw, members, posted, deleteOf } = build(roster);
    posted('A1', { remoteJid: GROUP, fromMe: false, participant: ALICE }, 'meeting at 3');

    await deleteOf('A1', { fromMe: true, participant: undefined }, { fromMe: false, participant: ALICE });

    expect(members).not.toHaveBeenCalled();
    expect(raw.get('A1')?.message).toBeNull();
  });
});

// However the stored author and the sender of a delete are named, by lid, by number, or by both (either first), a
// reported pairing may bring a lid and a number together but must never make two people read as one, nor one person
// as two: the roster is read for every pair the names prove different, and for no other. Two members of whom one is
// named by number alone and the other by both are left out of this table, which pairs every lid with its own number;
// what a pairing that names another number does there is pinned by the cases above.
describe('Baileys group delete judged by who the names say the author and the sender are', () => {
  type How = 'lid' | 'number' | 'both' | 'number first';
  const HOWS: How[] = ['lid', 'number', 'both', 'number first'];
  const person = (n: number) => ({
    lid: `9001${n}@lid`,
    lidDigits: `9001${n}`,
    number: `62811${n}@s.whatsapp.net`,
    digits: `62811${n}`,
  });
  type Person = ReturnType<typeof person>;
  const keyOf = (how: How, p: Person) =>
    how === 'lid'
      ? { participant: p.lid }
      : how === 'number'
        ? { participant: p.number }
        : how === 'both'
          ? { participant: p.lid, participantAlt: p.number }
          : { participant: p.number, participantAlt: p.lid };
  const carriesLid = (how: How) => how !== 'number';
  const carriesNumber = (how: How) => how !== 'lid';
  const flags = (how: How): boolean[] => (carriesLid(how) ? [false, true] : [false]);

  type Row = [label: string, author: How, sender: How, same: boolean, authorPaired: boolean, senderPaired: boolean];
  const rows: Row[] = [];
  for (const author of HOWS) {
    for (const sender of HOWS) {
      for (const same of [true, false]) {
        for (const authorPaired of flags(author)) {
          for (const senderPaired of same ? (carriesLid(sender) ? [authorPaired] : [false]) : flags(sender)) {
            const numberAgainstBoth =
              (author === 'number' && carriesLid(sender) && carriesNumber(sender)) ||
              (sender === 'number' && carriesLid(author) && carriesNumber(author));
            if (!same && numberAgainstBoth) continue;
            const paired = (flag: boolean) => (flag ? 'paired' : 'not paired');
            rows.push([
              `${same ? 'the same member' : 'two members'}: author by ${author} (${paired(authorPaired)}), sender by ${sender} (${paired(senderPaired)})`,
              author,
              sender,
              same,
              authorPaired,
              senderPaired,
            ]);
          }
        }
      }
    }
  }

  it.each(rows)('%s', async (_label, author, sender, same, authorPaired, senderPaired) => {
    const a = person(1);
    const s = same ? a : person(2);
    const pairs: Record<string, string> = {};
    if (authorPaired) pairs[a.lidDigits] = a.digits;
    if (senderPaired) pairs[s.lidDigits] = s.digits;
    // Whether the names prove them different: two lids, or two numbers, compare as they are; a lid against a number
    // only through a reported pairing of that lid.
    const provenDifferent =
      !same &&
      (carriesLid(author) && carriesLid(sender)
        ? true
        : carriesNumber(author) && carriesNumber(sender)
          ? true
          : author === 'lid'
            ? authorPaired
            : senderPaired);
    // Both members are listed, by both names, and neither is an admin.
    const both: Roster = () =>
      Promise.resolve([
        { ids: [a.lid, a.number], admin: false },
        { ids: [person(2).lid, person(2).number], admin: false },
        { ids: ['900444@lid', ADMIN], admin: true },
      ]);
    const { raw, members, posted, deleteOf } = build(both, { pairs });
    posted('A1', { remoteJid: GROUP, fromMe: false, ...keyOf(author, a) }, 'meeting at 3');

    await deleteOf('A1', keyOf(sender, s), { fromMe: false, ...keyOf(author, a) });

    expect(members).toHaveBeenCalledTimes(provenDifferent ? 1 : 0);
    // A delete the names prove foreign is refused, as a member who is no admin is held to the author; any other is
    // let through.
    expect(raw.get('A1')?.message).toEqual(provenDifferent ? { conversation: 'meeting at 3' } : null);
  });
});
