import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

type Lib = Awaited<ReturnType<BaileysEventsHost['loadLib']>>;
type Content = Record<string, unknown>;

/**
 * Baileys counts a message as unread when it arrives, before the session has recorded it. The messages the session is
 * still processing that a read of their chat has to account for are the ones Baileys counts and the session records.
 * Run over a limiter of one slot: a message held at its first await keeps the others waiting for a slot, in flight and
 * not yet looked at. The library functions mirror the ones the package exports (`isRealMessage` takes a message for
 * real unless it is a protocol message, a reaction, a poll vote or has no content, and counts an album header, a pin,
 * a keep-in-chat toggle, an event RSVP, an encrypted comment and an encrypted edit or reaction among them), checked
 * against the package for every message of this file.
 */
const normalizeMessageContent = (content: unknown): unknown => content;
const getContentType = (content: Content | undefined): string | undefined =>
  Object.keys(content ?? {}).find(
    k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage',
  );
const isRealMessage = (message: { message?: Content | null }): boolean => {
  const content = message.message ?? undefined;
  return (
    !!getContentType(content) && !content?.protocolMessage && !content?.reactionMessage && !content?.pollUpdateMessage
  );
};
const lib = {
  normalizeMessageContent,
  extractMessageContent: normalizeMessageContent,
  getContentType,
  isRealMessage,
  BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v },
  downloadMediaMessage: jest.fn(() =>
    Promise.resolve({
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('IMGDATA');
      },
      destroy: jest.fn(),
    }),
  ),
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Lib;

const PHONE_CHAT = '6281111111111@s.whatsapp.net';
const author = '6282222222222@s.whatsapp.net';

const incoming = (id: string, message: WAMessage['message'], key: Partial<WAMessage['key']> = {}): WAMessage => ({
  key: { id, remoteJid: PHONE_CHAT, fromMe: false, ...key },
  messageTimestamp: 1_786_000_000,
  message,
});

/** Waits for `condition` between event-loop turns and fails at the deadline instead of hanging. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function setup(options: { libLoaded?: boolean } = {}) {
  const limiter = new ConcurrencyLimiter(1);
  const delivered: string[] = [];
  let releaseHeld: () => void = () => undefined;
  let order = 0;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('BaileysReceivedInFlightSpec'),
    loadLib: () => Promise.resolve(lib),
    getLoadedLib: options.libLoaded === false ? undefined : () => lib,
    getFetchDispatcher: () => undefined,
    toNeutralJid: (jid: string) => jid,
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    inboundLimiter: limiter,
    recordKeyLidMappings: () => undefined,
    recordMessage: () => undefined,
    nextMessageOrder: () => ++order,
    recordMessageEdit: () => undefined,
    consumeOwnSend: () => false,
    getStoredMessage: (id: string) =>
      id === 'HELD' ? new Promise<null>(resolve => (releaseHeld = () => resolve(null))) : Promise.resolve(null),
    putStoredMessage: () => undefined,
    updateStoredMessage: () => undefined,
    removeStoredMessage: () => undefined,
    getOnMessage: () => (m: { id: string }) => delivered.push(m.id),
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => undefined,
    getOnMessageEdited: () => undefined,
    getOnMessageReaction: () => undefined,
    getOnMessageAck: () => undefined,
    getOnMessageReceipt: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnEventResponse: () => undefined,
    getOnPollVote: () => undefined,
    findContact: () => null,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
  } as unknown as BaileysEventsHost;
  const events = new BaileysEvents(host);
  const upsert = (...messages: WAMessage[]): void => events.handleMessagesUpsert({ type: 'notify', messages });
  return {
    events,
    upsert,
    /** The first message takes the only slot and waits there; whatever follows waits for the slot. */
    hold: async (): Promise<void> => {
      upsert(incoming('HELD', { conversation: 'held' }));
      await until(() => limiter.activeCount === 1, 'the held message to take the slot');
    },
    drain: async (): Promise<void> => {
      releaseHeld();
      await until(() => limiter.activeCount === 0 && limiter.queuedCount === 0, 'the limiter to drain');
    },
    delivered,
  };
}

describe('the messages received that the session is still processing', () => {
  it('lists the messages Baileys counts and the session records, where each belongs and in the order they arrived', async () => {
    const { events, upsert, hold, drain } = setup();
    await hold();

    upsert(
      incoming('TEXT1', { conversation: 'hello' }),
      incoming('IMG1', { imageMessage: { mimetype: 'image/jpeg' } }),
      incoming('STORY', { conversation: 'a story' }, { remoteJid: 'status@broadcast', participant: author }),
      incoming('LIST1', { conversation: 'a list message' }, { remoteJid: '1786000000@broadcast', participant: author }),
    );

    expect(events.receivedInFlight()).toEqual([
      { chatJid: PHONE_CHAT, id: 'HELD', timestamp: 1_786_000_000, order: 1 },
      { chatJid: PHONE_CHAT, id: 'TEXT1', timestamp: 1_786_000_000, order: 2 },
      { chatJid: PHONE_CHAT, id: 'IMG1', timestamp: 1_786_000_000, order: 3 },
      { chatJid: 'status@broadcast', id: 'STORY', timestamp: 1_786_000_000, order: 4 },
      // A broadcast-list message the account received belongs to the chat with its sender.
      { chatJid: author, id: 'LIST1', timestamp: 1_786_000_000, order: 5 },
    ]);
    await drain();
  });

  it('leaves out what the account sent, what Baileys counts for no message, and what the session drops as none', async () => {
    const { events, upsert, hold, drain } = setup();
    await hold();

    upsert(
      incoming('OWN', { conversation: 'sent from the phone' }, { fromMe: true }),
      incoming('REACT', { reactionMessage: { key: { id: 'X' }, text: 'x' } }),
      incoming('EDIT', { protocolMessage: { type: 14, key: { id: 'X' }, editedMessage: { conversation: 'y' } } }),
      incoming('VOTE', { pollUpdateMessage: { pollCreationMessageKey: { id: 'X' } } }),
      incoming('ALBUM', { albumMessage: { expectedImageCount: 2 } }),
      incoming('PIN', { pinInChatMessage: { key: { id: 'X' } } }),
      incoming('KEEP', { keepInChatMessage: { key: { id: 'X' } } }),
      incoming('RSVP', { encEventResponseMessage: { eventCreationMessageKey: { id: 'X' } } }),
      incoming('ENC-COMMENT', { encCommentMessage: { targetMessageKey: { id: 'X' } } }),
      incoming('ENC-EDIT', { secretEncryptedMessage: { targetMessageKey: { id: 'X' } } }),
      incoming('ENC-REACT', { encReactionMessage: { targetMessageKey: { id: 'X' } } }),
      incoming('NOISE', { senderKeyDistributionMessage: { groupId: 'g' } }),
      // Baileys counts this one, and the session drops it as protocol noise.
      incoming('FAST-RATCHET', { fastRatchetKeySenderKeyDistributionMessage: { groupId: 'g' } }),
      incoming('FAST-RATCHET-PIN', {
        fastRatchetKeySenderKeyDistributionMessage: { groupId: 'g' },
        pinInChatMessage: { key: { id: 'X' } },
      }),
    );

    expect(events.receivedInFlight().map(m => m.id)).toEqual(['HELD']);
    await drain();
  });

  it('lists a text that merged with a fast-ratchet sender-key distribution, whichever came first', async () => {
    const { events, upsert, hold, drain } = setup();
    await hold();

    upsert(
      incoming('FIRST', { fastRatchetKeySenderKeyDistributionMessage: { groupId: 'g' }, conversation: 'hello' }),
      incoming('LAST', { conversation: 'hello', fastRatchetKeySenderKeyDistributionMessage: { groupId: 'g' } }),
    );

    expect(events.receivedInFlight().map(m => m.id)).toEqual(['HELD', 'FIRST', 'LAST']);
    await drain();
  });

  it('lists every message received while the library is not loaded, which cannot be told apart yet', async () => {
    const { events, upsert, hold, drain } = setup({ libLoaded: false });
    await hold();

    upsert(
      incoming('ALBUM', { albumMessage: { expectedImageCount: 2 } }),
      incoming('OWN', { conversation: 'sent' }, { fromMe: true }),
    );

    expect(events.receivedInFlight().map(m => m.id)).toEqual(['HELD', 'ALBUM']);
    await drain();
  });

  it('lists nothing once the messages are processed, however each ended', async () => {
    const { events, upsert, hold, drain, delivered } = setup();
    await hold();
    upsert(
      incoming('TEXT1', { conversation: 'hello' }),
      incoming('ALBUM', { albumMessage: { expectedImageCount: 2 } }),
    );

    await drain();

    await until(() => delivered.length === 2, 'the messages to be delivered');
    expect(delivered).toEqual(['HELD', 'TEXT1']);
    expect(events.receivedInFlight()).toEqual([]);
  });
});
