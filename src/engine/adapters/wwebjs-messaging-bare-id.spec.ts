import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import type { WwebjsEngineHost } from './wwebjs-host';

const logger = createLogger('wwebjs-messaging-bare-id.spec');

const CHAT = '628111@c.us';
const BARE_ID = '3EB02A183BE553A16004B2';
const SERIALIZED_ID = `false_${CHAT}_${BARE_ID}`;

function makeMessaging(overrides?: {
  fetchMessagesResult?: unknown[];
  getMessageByIdResult?: unknown;
}): {
  messaging: WwebjsMessaging;
  client: {
    sendMessage: jest.Mock;
    getChatById: jest.Mock;
    getMessageById: jest.Mock;
  };
} {
  const replyMock = jest.fn().mockResolvedValue({ id: { _serialized: 'REPLY_SENT' }, timestamp: 2 });
  const forwardMock = jest.fn().mockResolvedValue(undefined);
  const reactMock = jest.fn().mockResolvedValue(undefined);

  const defaultMsg = {
    id: { _serialized: SERIALIZED_ID, id: BARE_ID },
    reply: replyMock,
    forward: forwardMock,
    react: reactMock,
    hasReaction: true,
    getReactions: jest.fn().mockResolvedValue([{ id: '❤️', senders: [] }]),
  };

  const client = {
    sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 }),
    getChatById: jest.fn().mockResolvedValue({
      fetchMessages: jest.fn().mockResolvedValue(overrides?.fetchMessagesResult ?? [defaultMsg]),
    }),
    getMessageById: jest.fn().mockResolvedValue(overrides?.getMessageByIdResult ?? defaultMsg),
  };

  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    config: {},
    getNumberId: jest.fn().mockResolvedValue({ _serialized: CHAT }),
    capInboundMediaFor: jest.fn(),
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;

  return { messaging: new WwebjsMessaging(host), client };
}

describe('WwebjsMessaging — bare stanza id resolution', () => {
  it('replyToMessage finds message by bare stanza id in fetchMessages', async () => {
    const { messaging, client } = makeMessaging();
    const res = await messaging.replyToMessage(CHAT, BARE_ID, 'hello reply');
    expect(res.id).toBe('REPLY_SENT');
  });

  it('replyToMessage resolves with serialized id when bare id matches', async () => {
    const { messaging, client } = makeMessaging();
    await messaging.replyToMessage(CHAT, BARE_ID, 'hello reply');
    expect(client.getChatById).toHaveBeenCalledWith(CHAT);
  });

  it('replyToMessage throws MessageNotFoundError if bare id is not found in window', async () => {
    const { messaging } = makeMessaging({ fetchMessagesResult: [] });
    await expect(messaging.replyToMessage(CHAT, BARE_ID, 'hello reply')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('sendTextMessage resolves bare quotedMessageId to serialized id before sending', async () => {
    const { messaging, client } = makeMessaging();
    await messaging.sendTextMessage(CHAT, 'quoting text', undefined, { quotedMessageId: BARE_ID });
    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT,
      'quoting text',
      expect.objectContaining({ quotedMessageId: SERIALIZED_ID }),
    );
  });

  it('sendImageMessage resolves bare quotedMessageId to serialized id before sending', async () => {
    const { messaging, client } = makeMessaging();
    await messaging.sendImageMessage(CHAT, {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      mimetype: 'image/png',
      quotedMessageId: BARE_ID,
    });
    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT,
      expect.anything(),
      expect.objectContaining({ quotedMessageId: SERIALIZED_ID }),
    );
  });

  it('forwardMessage finds message by bare stanza id', async () => {
    const { messaging } = makeMessaging();
    const res = await messaging.forwardMessage(CHAT, CHAT, BARE_ID);
    expect(res).toBeDefined();
  });

  it('reactToMessage finds message by bare stanza id', async () => {
    const { messaging } = makeMessaging();
    await expect(messaging.reactToMessage(CHAT, BARE_ID, '👍')).resolves.not.toThrow();
  });

  it('getMessageReactions finds message by bare stanza id', async () => {
    const { messaging } = makeMessaging();
    const reactions = await messaging.getMessageReactions(CHAT, BARE_ID);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('❤️');
  });
});
