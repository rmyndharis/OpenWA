import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * A message id names one message of one chat. History can carry two messages of different chats under one id
 * (an id two senders chose alike, or a copy filed under a twin form), and each chat's preview must come from its
 * own message, and a delete of one from its own chat, not from whichever of the two the batch held last.
 */

const ANI = '628111@s.whatsapp.net';
const BUDI = '628333@s.whatsapp.net';

function build() {
  const store = new BaileysSessionStore(undefined, 's1');
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-history-same-id-chats.spec'),
    loadLib: () =>
      Promise.resolve({
        normalizeMessageContent: (m: unknown) => m,
        getContentType: (m: object) => Object.keys(m)[0],
        proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
      }),
    normalizedSelfJid: () => '628999@s.whatsapp.net',
    toNeutralJid: (id: string) => store.toNeutralJid(id),
    extractEphemeralDuration: (msg: WAMessage) => store.extractEphemeralDuration(msg),
    recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1]) =>
      store.recordMessage(msg, type),
    recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
      store.recordMessageEdit(...args),
    upsertContacts: () => undefined,
    getOnHistoryMessages: () => () => undefined,
    inboundLimiter: new ConcurrencyLimiter(2),
    getStoredMessage: () => Promise.resolve(null),
    updateStoredMessage: () => undefined,
  };
  const events = new BaileysEvents(host as unknown as BaileysEventsHost);
  const history = new BaileysHistory({
    ...host,
    applyHistoryRevoke: (...args: Parameters<BaileysEvents['applyHistoryRevoke']>) =>
      events.applyHistoryRevoke(...args),
  } as unknown as BaileysHistoryHost);
  // The lifecycle upserts the chats a history sync carries before it captures the messages.
  store.upsertChats([
    { id: ANI, conversationTimestamp: 100 },
    { id: BUDI, conversationTimestamp: 200 },
  ] as never);
  return { store, history };
}

const fromAni: WAMessage = {
  key: { id: 'X1', remoteJid: ANI, fromMe: false },
  message: { conversation: 'from Ani' },
  messageTimestamp: 100,
};
const fromBudi: WAMessage = {
  key: { id: 'X1', remoteJid: BUDI, fromMe: false },
  message: { conversation: 'from Budi' },
  messageTimestamp: 200,
};

describe('history previews of two chats whose messages share an id', () => {
  it('previews each chat with its own message', async () => {
    const { store, history } = build();
    await history.captureHistoryMessages([fromAni, fromBudi]);

    const previews = Object.fromEntries(store.listChats().map(chat => [chat.id, chat.lastMessage]));
    expect(previews).toEqual({ '628111@c.us': 'from Ani', '628333@c.us': 'from Budi' });
  });

  it('applies a delete in the batch to the message of its own chat only', async () => {
    const { store, history } = build();
    await history.captureHistoryMessages([
      fromAni,
      {
        key: { id: 'R1', remoteJid: ANI, fromMe: false },
        message: { protocolMessage: { type: 0, key: { id: 'X1', remoteJid: '628999@s.whatsapp.net', fromMe: true } } },
        messageTimestamp: 150,
      },
      fromBudi,
    ]);

    const previews = Object.fromEntries(
      store.listChats().map(chat => [chat.id, [chat.lastMessage, chat.lastMessageType]]),
    );
    expect(previews).toEqual({ '628111@c.us': ['', 'revoked'], '628333@c.us': ['from Budi', 'text'] });
  });
});
