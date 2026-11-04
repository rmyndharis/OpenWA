import type { WAMessage } from '@whiskeysockets/baileys';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { BaileysEvents, BaileysEventsHost } from './baileys-events';
import { BaileysHistory, BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';

const CHAT = '120363000000000001@g.us';
const SECOND = 1800000000;
const msg = (id: string, timestamp = SECOND): WAMessage => ({
  key: { id, remoteJid: CHAT, fromMe: false },
  message: { conversation: id },
  messageTimestamp: timestamp,
});

function historyFor(store: BaileysSessionStore): BaileysHistory {
  return new BaileysHistory({
    loadLib: () =>
      Promise.resolve({
        normalizeMessageContent: (m: unknown) => m,
        getContentType: (m: object) => Object.keys(m)[0],
      }),
    normalizedSelfJid: () => '99999@s.whatsapp.net',
    toNeutralJid: (id: string) => store.toNeutralJid(id),
    extractEphemeralDuration: (message: WAMessage) => store.extractEphemeralDuration(message),
    recordMessage: (...args: Parameters<typeof store.recordMessage>) => store.recordMessage(...args),
    recordMessageEdit: (...args: Parameters<typeof store.recordMessageEdit>) => store.recordMessageEdit(...args),
    upsertContacts: () => undefined,
    getOnHistoryMessages: () => () => undefined,
  } as unknown as BaileysHistoryHost);
}

describe('chat preview among messages of one second', () => {
  it('follows the order messages were observed in', () => {
    const store = new BaileysSessionStore();
    store.recordMessage(msg('A'), 'image');
    store.recordMessage(msg('B'), 'text');

    expect(store.lastMessage(CHAT)?.key.id).toBe('B');
    expect(store.lastInboundMessage(CHAT)?.key.id).toBe('B');
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'B', lastMessageType: 'text' });
  });

  it('keeps the newer second whichever message is observed last', () => {
    const store = new BaileysSessionStore();
    store.recordMessage(msg('B', SECOND + 1));
    store.recordMessage(msg('A'));

    expect(store.lastMessage(CHAT)?.key.id).toBe('B');
    expect(store.lastInboundMessage(CHAT)?.key.id).toBe('B');
  });

  it('does not bring back the original text when the current message is delivered again after an edit', () => {
    const store = new BaileysSessionStore();
    store.recordMessage(msg('A'), 'text');
    store.recordMessageEdit(CHAT, 'A', 'edited');
    store.recordMessage(msg('A'), 'text');

    expect(store.listChats()[0].lastMessage).toBe('edited');
  });

  it('keeps the first of equal-time history, in either order, and gives way to a live message', async () => {
    for (const ids of [
      ['A', 'B'],
      ['B', 'A'],
    ]) {
      const store = new BaileysSessionStore();
      await historyFor(store).captureHistoryMessages(ids.map(id => msg(id)));
      expect(store.lastMessage(CHAT)?.key.id).toBe(ids[0]);

      store.recordMessage(msg('LIVE'));
      expect(store.lastMessage(CHAT)?.key.id).toBe('LIVE');
    }
  });

  it('does not let equal-time history displace a live message', async () => {
    const store = new BaileysSessionStore();
    store.recordMessage(msg('B'));
    await historyFor(store).captureHistoryMessages([msg('A')]);

    expect(store.lastMessage(CHAT)?.key.id).toBe('B');
  });

  it.each([false, true])('keeps arrival order when the first message is slow to process (slow=%s)', async slow => {
    const store = new BaileysSessionStore();
    const emitted: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let sequence = 0;
    const host = {
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (content: unknown) => content,
          getContentType: (content: object) => Object.keys(content)[0],
        }),
      logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
      toNeutralJid: (id: string) => store.toNeutralJid(id),
      normalizedSelfJid: () => '99999@s.whatsapp.net',
      inboundLimiter: new ConcurrencyLimiter(2),
      nextMessageOrder: () => ++sequence,
      getStoredMessage: async (id: string) => {
        if (slow && id === 'A') await gate;
        return null;
      },
      putStoredMessage: () => undefined,
      recordKeyLidMappings: () => undefined,
      recordMessage: (...args: Parameters<typeof store.recordMessage>) => store.recordMessage(...args),
      recordMessageEdit: (...args: Parameters<typeof store.recordMessageEdit>) => store.recordMessageEdit(...args),
      consumeOwnSend: () => false,
      getOnMessage: () => (message: IncomingMessage) => emitted.push(message.id),
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysEventsHost;
    const events = new BaileysEvents(host);
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));

    events.handleMessagesUpsert({ messages: [msg('A')], type: 'notify' });
    await flush();
    events.handleMessagesUpsert({ messages: [msg('B')], type: 'notify' });
    await flush();
    expect(emitted).toEqual(slow ? ['B'] : ['A', 'B']);
    release();
    await flush();

    expect(emitted).toEqual(slow ? ['B', 'A'] : ['A', 'B']);
    expect(store.lastMessage(CHAT)?.key.id).toBe('B');
    expect(store.lastInboundMessage(CHAT)?.key.id).toBe('B');
  });
});
