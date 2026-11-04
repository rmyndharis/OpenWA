import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { baileysMessageText } from './baileys-message-mapper';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * The chat list preview (GET /chats `lastMessage`) is the text of the chat's newest message, the
 * same text the message itself is announced with. A message in a disappearing chat arrives wrapped
 * in `ephemeralMessage`, and a photo or video carries its text as a caption; both are announced with
 * that text as their body, and the preview must show it too.
 */

// Library stand-in: unwraps the envelopes the real normalizeMessageContent opens.
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'];
const normalizeMessageContent = (content: Record<string, unknown> | null | undefined): unknown => {
  let current: unknown = content ?? undefined;
  for (let i = 0; i < 5 && current; i++) {
    const wrapper = WRAPPERS.find(name => (current as Record<string, { message?: unknown }>)[name]);
    if (!wrapper) break;
    current = (current as Record<string, { message?: unknown }>)[wrapper].message;
  }
  return current;
};
const getContentType = (content: Record<string, unknown> | undefined): string | undefined =>
  Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message'));
const lib = {
  normalizeMessageContent,
  extractMessageContent: normalizeMessageContent,
  getContentType,
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const PEER = '628111@s.whatsapp.net';
const SELF = '628222@s.whatsapp.net';

function build(overrides: Record<string, unknown> = {}): {
  events: BaileysEvents;
  history: BaileysHistory;
  store: BaileysSessionStore;
  emitted: string[];
} {
  const store = new BaileysSessionStore(undefined, 's1');
  store.upsertChats([{ id: PEER }]);
  const emitted: string[] = [];
  const noop = (): undefined => undefined;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-chat-preview-text.spec'),
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
    getStoredMessage: noop,
    putStoredMessage: noop,
    updateStoredMessage: noop,
    removeStoredMessage: noop,
    getOnMessage: () => (m: { body: string }) => void emitted.push(m.body),
    getOnMessageCreate: noop,
    getOnMessageRevoked: noop,
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
    // history host
    upsertContacts: noop,
    upsertChats: noop,
    contactCount: () => 0,
    extractEphemeralDuration: (msg: WAMessage) => store.extractEphemeralDuration(msg),
    getOnHistoryMessages: noop,
    applyHistoryRevoke: noop,
    ...overrides,
  };
  return {
    events: new BaileysEvents(host),
    history: new BaileysHistory(host as unknown as BaileysHistoryHost),
    store,
    emitted,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Wait until `done` holds, up to a deadline. */
const until = async (done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
};

const inbound = (id: string, message: WAMessage['message']): WAMessage => ({
  key: { id, remoteJid: PEER, fromMe: false },
  message,
  messageTimestamp: 1_700_000_000,
});

describe('Baileys chat list preview text', () => {
  const previous = process.env.MEDIA_DOWNLOAD_ENABLED;
  beforeAll(() => {
    process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.MEDIA_DOWNLOAD_ENABLED;
    else process.env.MEDIA_DOWNLOAD_ENABLED = previous;
  });

  it('previews a disappearing-chat text with the body it was announced with', async () => {
    const { events, store, emitted } = build();
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        inbound('E1', {
          ephemeralMessage: {
            message: { extendedTextMessage: { text: 'see you at 7', contextInfo: { expiration: 86400 } } },
          },
        }),
      ],
    });
    await settle();
    expect(emitted).toEqual(['see you at 7']);
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'see you at 7', lastMessageType: 'text' });
  });

  it('previews a captioned photo with its caption, as the announced body and an edited caption do', async () => {
    const { events, store, emitted } = build();
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [inbound('I1', { imageMessage: { caption: 'the receipt', mimetype: 'image/jpeg', fileLength: 10 } })],
    });
    await settle();
    expect(emitted).toEqual(['the receipt']);
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'the receipt', lastMessageType: 'image' });
  });

  it('previews a captioned document and a view-once photo with their captions', async () => {
    const { events, store } = build();
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        inbound('D1', {
          documentWithCaptionMessage: {
            message: { documentMessage: { caption: 'the contract', mimetype: 'application/pdf', fileName: 'c.pdf' } },
          },
        }),
      ],
    });
    await settle();
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'the contract', lastMessageType: 'document' });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          ...inbound('V1', {
            viewOnceMessageV2: { message: { imageMessage: { caption: 'look once', mimetype: 'image/jpeg' } } },
          }),
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
    await settle();
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'look once', lastMessageType: 'image' });
  });

  it('previews a photo the account sent with its caption', () => {
    const { store } = build();
    store.recordMessage(
      {
        key: { id: 'S1', remoteJid: PEER, fromMe: true },
        message: { imageMessage: { caption: 'invoice attached', mimetype: 'image/jpeg' } },
        messageTimestamp: 1_700_000_000,
      },
      'image',
    );
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'invoice attached', lastMessageType: 'image' });
  });

  it('previews nothing of a captioned photo deleted while it was still being processed', async () => {
    // The first store read is the original's repeat-delivery check, held until released.
    let release: (stored: null) => void = () => undefined;
    let reads = 0;
    const getStoredMessage = (): Promise<null> =>
      ++reads === 1 ? new Promise<null>(resolve => (release = resolve)) : Promise.resolve(null);
    const { events, store } = build({ getStoredMessage });
    const own = { remoteJid: PEER, fromMe: true };
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'P1', ...own },
          message: { imageMessage: { caption: 'wrong photo', mimetype: 'image/jpeg' } },
          messageTimestamp: 1_700_000_000,
        },
      ],
    });
    await settle();
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'R1', ...own },
          message: { protocolMessage: { type: 0, key: { id: 'P1', ...own } } },
          messageTimestamp: 1_700_000_010,
        },
      ],
    });
    await settle();
    release(null);
    await settle();
    expect(store.listChats()[0]).toMatchObject({ lastMessage: '', lastMessageType: 'revoked' });
  });

  it('previews a history-synced disappearing-chat text with its body', async () => {
    const { history, store } = build();
    await history.captureHistoryMessages([
      inbound('H1', { ephemeralMessage: { message: { conversation: 'from before the link' } } }),
    ]);
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'from before the link', lastMessageType: 'text' });
  });

  // Some clients send a tapped native-flow button with its label only in the params: the reply is announced with
  // that label as its body, so the preview shows it too.
  it('previews a native-flow reply by the label it carries only in its params', async () => {
    const { events, store, emitted } = build();
    const reply: WAMessage['message'] = {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: {
          name: 'quick_reply',
          paramsJson: '{"id":"opt-yes","display_text":"Yes, book it"}',
        },
      },
    };
    events.handleMessagesUpsert({ type: 'notify', messages: [inbound('NF1', reply)] });
    await until(() => emitted.length > 0);
    expect(emitted).toEqual(['Yes, book it']);
    expect(store.listChats()[0]).toMatchObject({ lastMessage: 'Yes, book it', lastMessageType: 'text' });
    expect(baileysMessageText({ ephemeralMessage: { message: reply } })).toBe('Yes, book it');
  });

  it('previews nothing of a native-flow reply whose params carry no id, as it is announced with no body', async () => {
    const { events, store, emitted } = build();
    const reply: WAMessage['message'] = {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: '{"display_text":"Yes, book it"}' },
      },
    };
    events.handleMessagesUpsert({ type: 'notify', messages: [inbound('NF2', reply)] });
    await until(() => emitted.length > 0);
    expect(emitted).toEqual(['']);
    expect(store.listChats()[0]).toMatchObject({ lastMessage: '' });
  });
});
