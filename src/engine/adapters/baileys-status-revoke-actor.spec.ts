import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysSessionStore } from './baileys-session-store';
import type { EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * Baileys hands any revoke through as-is, naming whatever message id the sender knows, and only judges it against a
 * stored copy of the message. A story's copy may be gone from the store, and then the revoke reaches the session
 * unchecked: the session has to be told who sent it, to hold it against the contact the story is stored under.
 */

const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) =>
    Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const STATUS = 'status@broadcast';
const POSTER = '628111@s.whatsapp.net';
const SELF = '628222@s.whatsapp.net';

function build() {
  const store = new BaileysSessionStore(undefined, 's1');
  const revoked = jest.fn<void, Parameters<NonNullable<EngineEventCallbacks['onMessageRevoked']>>>();
  const noop = (): undefined => undefined;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-status-revoke-actor.spec'),
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
    // The message the revoke names is not in the message store: it was evicted past BAILEYS_MESSAGE_STORE_LIMIT.
    getStoredMessage: () => Promise.resolve(null),
    findPersistedLidPhone: () => Promise.resolve(null),
    putStoredMessage: noop,
    updateStoredMessage: noop,
    removeStoredMessage: noop,
    getOnMessage: noop,
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
    upsertContacts: noop,
    upsertChats: noop,
    contactCount: () => 0,
    extractEphemeralDuration: noop,
    getOnHistoryMessages: noop,
    applyHistoryRevoke: noop,
  };
  return { events: new BaileysEvents(host), revoked };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
};

/** A REVOKE protocol message in `chat`, sent by `participant` (none in a one-to-one chat), naming message `target`. */
const revokeOf = (chat: string, target: string, participant?: string, fromMe = false): WAMessage => ({
  key: { id: `REVOKE-${target}`, remoteJid: chat, fromMe, ...(participant ? { participant } : {}) },
  message: {
    protocolMessage: {
      type: 0,
      key: { id: target, remoteJid: chat, fromMe: false, ...(participant ? { participant } : {}) },
    },
  },
  messageTimestamp: 1_700_000_500,
});

describe('Baileys tells the session who deleted a status post', () => {
  it('names the contact who sent the delete, in the neutral form, though the story is no longer stored', async () => {
    const { events, revoked } = build();

    events.handleMessagesUpsert({ type: 'notify', messages: [revokeOf(STATUS, 'ST1', POSTER)] });
    await settle();

    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'ST1', revokedId: 'ST1', chatId: STATUS }));
    expect(revoked.mock.calls[0][1]).toStrictEqual({ fromMe: false, participant: '628111@c.us' });
  });

  it('names no sender when the key carries none', async () => {
    const { events, revoked } = build();

    events.handleMessagesUpsert({ type: 'notify', messages: [revokeOf(STATUS, 'ST1')] });
    await settle();

    expect(revoked.mock.calls[0][1]).toStrictEqual({ fromMe: false });
  });

  it('flags the delete the account made from its phone', async () => {
    const { events, revoked } = build();

    events.handleMessagesUpsert({ type: 'notify', messages: [revokeOf(STATUS, 'ST1', undefined, true)] });
    await settle();

    expect(revoked.mock.calls[0][1]).toStrictEqual({ fromMe: true });
  });

  it('adds nothing to the delete of a message in a broadcast list', async () => {
    const { events, revoked } = build();

    events.handleMessagesUpsert({ type: 'notify', messages: [revokeOf('12345@broadcast', 'M1', POSTER)] });
    await settle();

    expect(revoked.mock.calls[0][1]).toStrictEqual({ fromMe: false });
  });

  it('adds nothing to the delete of a message in a one-to-one chat', async () => {
    const { events, revoked } = build();

    events.handleMessagesUpsert({ type: 'notify', messages: [revokeOf(POSTER, 'M1')] });
    await settle();

    expect(revoked.mock.calls[0][1]).toStrictEqual({ fromMe: false });
  });
});
