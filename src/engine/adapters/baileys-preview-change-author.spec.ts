import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * WhatsApp applies an edit only from the author of the message and a delete only from its author (or
 * a group admin), and only inside the message's own chat. Baileys hands any edit or delete through
 * as-is, naming whatever message id the sender knows, so the chat list preview must not show an edit
 * or delete that the message it names could not have received: the preview holds that message's key.
 */

const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) =>
    Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const PEER = '628111@s.whatsapp.net';
const OTHER = '628333@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const SELF = '628222@s.whatsapp.net';
const LID_PEER = '111111111111111@lid';
const LID_OTHER = '333333333333333@lid';

/** Lid to phone pairs the persisted table reports, as `findPersistedLidPhone` answers them (digits). */
function build(pairs: Record<string, string> = {}) {
  const store = new BaileysSessionStore(undefined, 's1');
  store.upsertChats([{ id: PEER }, { id: GROUP }]);
  const edited = jest.fn();
  const revoked = jest.fn();
  const noop = (): undefined => undefined;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-preview-change-author.spec'),
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
    // The message the change names is not in the message store: it came with the history sync, which
    // the store never holds, or it was evicted past BAILEYS_MESSAGE_STORE_LIMIT.
    getStoredMessage: () => Promise.resolve(null),
    findPersistedLidPhone: (jid: string) => Promise.resolve(pairs[jid.replace(/:\d+(?=@)/, '')] ?? null),
    putStoredMessage: noop,
    updateStoredMessage: noop,
    removeStoredMessage: noop,
    getOnMessage: noop,
    getOnMessageCreate: noop,
    getOnMessageRevoked: () => revoked,
    getOnMessageEdited: () => edited,
    getOnMessageReaction: noop,
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
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
};

const change = (key: WAMessage['key'], protocolMessage: Record<string, unknown>): WAMessage => ({
  key: { id: `CHANGE-${Math.random()}`, ...key },
  message: { protocolMessage },
  messageTimestamp: 1_700_000_500,
});

describe('Baileys chat preview against an edit or delete from someone other than the author', () => {
  it('keeps the preview of the account own last message when the contact sends an edit of it', async () => {
    const { events, history, store, edited } = build();
    await history.captureHistoryMessages([
      {
        key: { id: 'MINE', remoteJid: PEER, fromMe: true },
        message: { conversation: 'I will pay on Friday' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    expect(store.listChats().find(c => c.id === '628111@c.us')?.lastMessage).toBe('I will pay on Friday');

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        change(
          { remoteJid: PEER, fromMe: false },
          {
            type: 14,
            key: { id: 'MINE', remoteJid: PEER, fromMe: true },
            editedMessage: { conversation: 'I owe you 1000' },
          },
        ),
      ],
    });
    await settle();

    expect(edited).toHaveBeenCalled();
    expect(store.listChats().find(c => c.id === '628111@c.us')?.lastMessage).toBe('I will pay on Friday');
  });

  it('keeps the preview of a group member last message when another member sends an edit of it', async () => {
    const { events, history, store } = build();
    await history.captureHistoryMessages([
      {
        key: { id: 'ALICE', remoteJid: GROUP, fromMe: false, participant: PEER },
        message: { conversation: 'meeting moved to 3pm' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        change(
          { remoteJid: GROUP, fromMe: false, participant: OTHER },
          {
            type: 14,
            key: { id: 'ALICE', remoteJid: GROUP, participant: PEER },
            editedMessage: { conversation: 'meeting cancelled' },
          },
        ),
      ],
    });
    await settle();

    expect(store.listChats().find(c => c.id === GROUP)?.lastMessage).toBe('meeting moved to 3pm');
  });

  it('keeps the preview of the account own last message when the contact sends a delete of it', async () => {
    const { events, history, store, revoked } = build();
    await history.captureHistoryMessages([
      {
        key: { id: 'MINE2', remoteJid: PEER, fromMe: true },
        message: { conversation: 'the address is 12 Main St' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        change({ remoteJid: PEER, fromMe: false }, { type: 0, key: { id: 'MINE2', remoteJid: PEER, fromMe: true } }),
      ],
    });
    await settle();

    expect(revoked).toHaveBeenCalled();
    expect(store.listChats().find(c => c.id === '628111@c.us')).toMatchObject({
      lastMessage: 'the address is 12 Main St',
      lastMessageType: 'text',
    });
  });

  it('lets a group member delete another member last message, as an admin may', async () => {
    const { events, history, store } = build();
    await history.captureHistoryMessages([
      {
        key: { id: 'ALICE2', remoteJid: GROUP, fromMe: false, participant: PEER },
        message: { conversation: 'off-topic link' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        change(
          { remoteJid: GROUP, fromMe: false, participant: OTHER },
          { type: 0, key: { id: 'ALICE2', remoteJid: GROUP, participant: PEER } },
        ),
      ],
    });
    await settle();
    expect(store.listChats().find(c => c.id === GROUP)).toMatchObject({ lastMessage: '', lastMessageType: 'revoked' });
  });

  it('applies the account own edit from its phone, also when the chat is addressed by lid there', async () => {
    const { events, history, store } = build({ [LID_PEER]: '628111' });
    await history.captureHistoryMessages([
      {
        key: { id: 'MINE3', remoteJid: PEER, fromMe: true },
        message: { conversation: 'see you at 6' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        change(
          { remoteJid: LID_PEER, fromMe: true },
          {
            type: 14,
            key: { id: 'MINE3', remoteJid: LID_PEER, fromMe: true },
            editedMessage: { conversation: 'see you at 7' },
          },
        ),
      ],
    });
    await settle();
    expect(store.listChats().find(c => c.id === '628111@c.us')?.lastMessage).toBe('see you at 7');
  });

  it('applies the contact own edit of its message, under its lid or its phone', async () => {
    const { events, history, store } = build({ [LID_PEER]: '628111' });
    await history.captureHistoryMessages([
      {
        key: { id: 'THEIRS', remoteJid: PEER, fromMe: false },
        message: { conversation: 'call me at 5' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        change(
          { remoteJid: LID_PEER, remoteJidAlt: PEER, fromMe: false },
          {
            type: 14,
            key: { id: 'THEIRS', remoteJid: LID_PEER, fromMe: true },
            editedMessage: { conversation: 'call me at 6' },
          },
        ),
      ],
    });
    await settle();
    expect(store.listChats().find(c => c.id === '628111@c.us')?.lastMessage).toBe('call me at 6');
  });

  it('applies a group member edit of its own message and refuses another member, across lid and phone', async () => {
    const { events, history, store } = build({ [LID_PEER]: '628111', [LID_OTHER]: '628333' });
    await history.captureHistoryMessages([
      {
        key: { id: 'ALICE3', remoteJid: GROUP, fromMe: false, participant: PEER },
        message: { conversation: 'lunch at noon' },
        messageTimestamp: 1_700_000_000,
      },
    ]);
    const editBy = (participant: string, text: string): WAMessage =>
      change(
        { remoteJid: GROUP, fromMe: false, participant },
        { type: 14, key: { id: 'ALICE3', remoteJid: GROUP, participant }, editedMessage: { conversation: text } },
      );

    events.handleMessagesUpsert({ type: 'notify', messages: [editBy(LID_OTHER, 'lunch cancelled')] });
    await settle();
    expect(store.listChats().find(c => c.id === GROUP)?.lastMessage).toBe('lunch at noon');

    events.handleMessagesUpsert({ type: 'notify', messages: [editBy(LID_PEER, 'lunch at one')] });
    await settle();
    expect(store.listChats().find(c => c.id === GROUP)?.lastMessage).toBe('lunch at one');
  });
});
