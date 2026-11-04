import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost, type GroupMember } from './baileys-events';
import { BaileysSessionStore } from './baileys-session-store';
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

/** `peek` is the cached roster; `held` has the session keep every message it is handed without an outcome. */
function build(readGroupMembers?: Roster, options: { peek?: () => GroupMember[] | null; held?: boolean } = {}) {
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
