import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, differentWaIds, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { toNeutralJid } from '../identity/wa-id';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * WhatsApp often sends a lid-addressed sender's phone number beside the lid (`participantAlt` in a group,
 * `remoteJidAlt` in a one-to-one chat). That phone number tells the sender apart from the author of a
 * message stored under another number, so an edit, delete or reaction carrying it is ignored like the same
 * change sent by phone number. On the account's own one-to-one key Baileys puts the account's own number
 * there instead, which says nothing about the chat, so the account's own changes keep working.
 */

const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) =>
    Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const GROUP = '120363000000000001@g.us';
const SELF = '628222@s.whatsapp.net';
const AUTHOR = '628111@s.whatsapp.net';
const AUTHOR_LID = '111111111111111@lid';
const OTHER = '628333@s.whatsapp.net';
const OTHER_LID = '333333333333333@lid';
const PEER = '628444@s.whatsapp.net';
const PEER_LID = '444444444444444@lid';

function build(stored: Record<string, WAMessage>) {
  const store = new BaileysSessionStore(undefined, 's1');
  store.upsertChats([{ id: GROUP }, { id: AUTHOR }, { id: PEER }, { id: PEER_LID }]);
  const edited = jest.fn();
  const revoked = jest.fn();
  const reacted = jest.fn();
  const logger = createLogger('baileys-change-sender-lid-phone.spec');
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const noop = (): undefined => undefined;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger,
    loadLib: () => Promise.resolve(lib),
    getFetchDispatcher: noop,
    toNeutralJid: (jid: string) => store.toNeutralJid(jid),
    normalizedSelfJid: () => SELF,
    inboundLimiter: new ConcurrencyLimiter(2),
    recordKeyLidMappings: noop,
    recordMessage: (msg: WAMessage, type?: Parameters<BaileysSessionStore['recordMessage']>[1], order?: number) =>
      store.recordMessage(msg, type, order),
    nextMessageOrder: () => store.nextMessageOrder(),
    recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
      store.recordMessageEdit(...args),
    consumeOwnSend: () => false,
    getStoredMessage: (id: string) => Promise.resolve(stored[id] ?? null),
    // The persisted lid table has not learned any pair yet (its write is fire-and-forget).
    findPersistedLidPhone: () => Promise.resolve(null),
    putStoredMessage: noop,
    updateStoredMessage: noop,
    removeStoredMessage: noop,
    getOnMessage: noop,
    getOnMessageCreate: noop,
    getOnMessageRevoked: () => revoked,
    getOnMessageEdited: () => edited,
    getOnMessageReaction: () => reacted,
    getOnMessageAck: noop,
    getOnMessageReceipt: noop,
    getOnGroupEvent: noop,
    getOnEventResponse: noop,
    findContact: () => null,
    getOnCall: noop,
    getOnPresenceUpdate: noop,
    getOnCallOutcome: noop,
    upsertContacts: noop,
    upsertChats: noop,
    contactCount: () => 0,
    extractEphemeralDuration: noop,
    getOnHistoryMessages: noop,
    applyHistoryRevoke: noop,
  };
  return {
    events: new BaileysEvents(host),
    history: new BaileysHistory(host as unknown as BaileysHistoryHost),
    store,
    edited,
    revoked,
    reacted,
    warn,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
};

let seq = 0;
const arriving = (key: WAMessage['key'], message: WAMessage['message']): WAMessage => ({
  key: { id: `CHANGE-${++seq}`, ...key },
  message,
  messageTimestamp: 1_700_000_500,
});
const editOf = (id: string, text: string): WAMessage['message'] => ({
  protocolMessage: { type: 14, key: { id }, editedMessage: { conversation: text } },
});
const deleteOf = (id: string): WAMessage['message'] => ({ protocolMessage: { type: 0, key: { id } } });
const reactionTo = (id: string): WAMessage['message'] => ({ reactionMessage: { key: { id }, text: 'ok' } });

describe('differentWaIds across lid and phone number', () => {
  it.each([
    ['a lid with its own phone number, against another phone number', [AUTHOR], [OTHER_LID, OTHER], true],
    ['a lid alone, against a phone number', [AUTHOR], [OTHER_LID], false],
    ['a lid with its own phone number, against that phone number', [OTHER], [OTHER_LID, OTHER], false],
    ['two different lids', [AUTHOR_LID], [OTHER_LID], true],
    ['a side with no id', [], [OTHER], false],
  ])('compares %s', (_case, a, b, different) => {
    // A lid nothing resolves stays a lid, as it does in the adapter.
    expect(differentWaIds(a, b, jid => toNeutralJid(jid))).toBe(different);
  });
});

describe('Baileys change from a sender carrying a lid and its own phone number', () => {
  const groupMessage: WAMessage = {
    key: { id: 'G1', remoteJid: GROUP, fromMe: false, participant: AUTHOR },
    message: { conversation: 'meeting at 10' },
    messageTimestamp: 1_700_000_000,
  };
  const groupPreview = (store: BaileysSessionStore) => store.listChats().find(c => c.id === GROUP)?.lastMessage;

  it('ignores a group member edit of another member message, as when sent by phone number', async () => {
    const { events, history, store, edited, warn } = build({ G1: groupMessage });
    await history.captureHistoryMessages([groupMessage]);

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: GROUP, fromMe: false, participant: OTHER }, editOf('G1', 'cancelled'))],
    });
    await settle();
    expect(edited).not.toHaveBeenCalled();

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        arriving(
          { remoteJid: GROUP, fromMe: false, participant: OTHER_LID, participantAlt: OTHER },
          editOf('G1', 'cancelled'),
        ),
      ],
    });
    await settle();
    expect(edited).not.toHaveBeenCalled();
    expect(groupPreview(store)).toBe('meeting at 10');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['edit', editOf('A1', 'changed'), 'edited'],
    ['delete', deleteOf('A1'), 'revoked'],
    ['reaction', reactionTo('A1'), 'reacted'],
  ] as const)('ignores a contact %s naming a message of another chat', async (_kind, message, callback) => {
    const authorMessage: WAMessage = {
      key: { id: 'A1', remoteJid: AUTHOR, fromMe: false },
      message: { conversation: 'see you' },
      messageTimestamp: 1_700_000_000,
    };
    const built = build({ A1: authorMessage });

    built.events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: OTHER_LID, remoteJidAlt: OTHER, fromMe: false }, message)],
    });
    await settle();

    expect(built[callback]).not.toHaveBeenCalled();
  });

  it('still lets a group edit through under a lid nothing maps, which may be the author', async () => {
    const { events, edited } = build({ G1: groupMessage });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: GROUP, fromMe: false, participant: AUTHOR_LID }, editOf('G1', 'at 11'))],
    });
    await settle();

    expect(edited).toHaveBeenCalledTimes(1);
  });
});

describe('Baileys change to the account own message in a chat its phone addresses by lid', () => {
  // A message typed on the account's phone: Baileys files the account's own number beside the chat's lid.
  const phoneTyped: WAMessage = {
    key: { id: 'O1', remoteJid: PEER_LID, remoteJidAlt: SELF, fromMe: true },
    message: { conversation: 'see you' },
    messageTimestamp: 1_700_000_000,
  };

  it('applies the account own edit when it arrives under the chat phone number', async () => {
    const { events, edited } = build({ O1: phoneTyped });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: PEER, fromMe: true }, editOf('O1', 'see you at 5'))],
    });
    await settle();

    expect(edited).toHaveBeenCalledTimes(1);
  });

  it('applies the account own delete when it arrives under the chat phone number', async () => {
    const { events, revoked } = build({ O1: phoneTyped });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: PEER, fromMe: true }, deleteOf('O1'))],
    });
    await settle();

    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it('reports the contact reaction that arrives under the chat phone number', async () => {
    const { events, reacted } = build({ O1: phoneTyped });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: PEER, fromMe: false }, reactionTo('O1'))],
    });
    await settle();

    expect(reacted).toHaveBeenCalledTimes(1);
  });

  it('applies the account own edit, sent under the chat lid, of a message stored under the phone number', async () => {
    const sentByPhone: WAMessage = {
      key: { id: 'O2', remoteJid: PEER, fromMe: true },
      message: { conversation: 'lunch?' },
      messageTimestamp: 1_700_000_000,
    };
    const { events, edited } = build({ O2: sentByPhone });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [arriving({ remoteJid: PEER_LID, remoteJidAlt: SELF, fromMe: true }, editOf('O2', 'lunch at 1?'))],
    });
    await settle();

    expect(edited).toHaveBeenCalledTimes(1);
  });
});
