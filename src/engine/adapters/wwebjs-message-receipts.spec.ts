import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * getMessageReceipts resolves the message by its full id (Client.getMessageById reads every message the page
 * holds, the same lookup Message.getInfo makes), not through the 100-message window of the writes, so an older
 * message still answers. The chat fence only checks the route's `chatId`, so the message is bound to that chat
 * before anything about it is read.
 */
const logger = createLogger('wwebjs-message-receipts.spec');
const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';
const INFO = {
  delivery: [{ id: { _serialized: '628123456789:1@s.whatsapp.net' }, t: 1719312050 }],
  deliveryRemaining: 2,
  read: [{ id: '99887766554433@lid', t: 1719312060 }],
  readRemaining: 1,
  played: [{ id: { _serialized: '628555555555@c.us' }, t: 1719312070 }],
  playedRemaining: 0,
};

function ownMessage(id: string, to: string, info: unknown = INFO) {
  return {
    id: { _serialized: id },
    fromMe: true,
    to,
    from: '628000000000@c.us',
    getInfo: jest.fn().mockResolvedValue(info),
  };
}

function makeMessaging(
  messages: Record<string, unknown>,
  getChatById: jest.Mock = jest.fn().mockResolvedValue(undefined),
  transportError?: Error,
) {
  const getMessageById = jest.fn((id: string) => Promise.resolve(messages[id] ?? null));
  const client = { getMessageById, getChatById };
  const ensureReady = jest.fn();
  const reportIfPageTransportError = jest.fn();
  const host = {
    ensureReady,
    getClient: () => client as unknown as Client,
    isPageTransportError: (error: unknown) => error === transportError,
    reportIfPageTransportError,
    logger,
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), ensureReady, reportIfPageTransportError, getMessageById, getChatById };
}

describe('WwebjsMessaging.getMessageReceipts', () => {
  it('reads an own message that has a hundred newer ones in its chat, and maps every list', async () => {
    const id = `true_${GROUP}_3EB0OLDEST`;
    const newest = Array.from({ length: 100 }, (_, i) => ({ id: { _serialized: `true_${GROUP}_3EB0NEW${i}` } }));
    const fetchMessages = jest.fn().mockResolvedValue(newest);
    const getChatById = jest.fn().mockResolvedValue({ id: { _serialized: GROUP }, fetchMessages });
    const { messaging } = makeMessaging({ [id]: ownMessage(id, GROUP) }, getChatById);

    await expect(messaging.getMessageReceipts(GROUP, id)).resolves.toEqual({
      delivery: [{ participant: '628123456789@c.us', timestamp: 1719312050 }],
      deliveryRemaining: 2,
      read: [{ participant: '99887766554433@lid', timestamp: 1719312060 }],
      readRemaining: 1,
      played: [{ participant: '628555555555@c.us', timestamp: 1719312070 }],
      playedRemaining: 0,
    });
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('reads lists and counts the page left out as empty and absent', async () => {
    const id = `true_${GROUP}_PARTIAL`;
    const { messaging } = makeMessaging({ [id]: ownMessage(id, GROUP, { read: [{}] }) });

    await expect(messaging.getMessageReceipts(GROUP, id)).resolves.toEqual({
      delivery: [],
      deliveryRemaining: undefined,
      read: [{ participant: '', timestamp: 0 }],
      readRemaining: undefined,
      played: [],
      playedRemaining: undefined,
    });
  });

  it('preserves empty recipient lists for an own 1:1 message even when its aggregate ack is read', async () => {
    const chat = '12025550100@c.us';
    const id = `true_${chat}_EMPTY_out`;
    const message = { ...ownMessage(id, chat, { delivery: [], read: [], played: [] }), ack: 3 };
    const { messaging } = makeMessaging({ [id]: message });

    await expect(messaging.getMessageReceipts(chat, id)).resolves.toEqual({
      delivery: [],
      deliveryRemaining: undefined,
      read: [],
      readRemaining: undefined,
      played: [],
      playedRemaining: undefined,
    });
    expect(message.getInfo).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a message of another chat without reading it', async () => {
    const id = `true_${OTHER}_X`;
    const message = ownMessage(id, OTHER);
    const { messaging } = makeMessaging({ [id]: message }, jest.fn().mockResolvedValue({ id: { _serialized: GROUP } }));

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(message.getInfo).not.toHaveBeenCalled();
  });

  it('answers 404, not 403, for a received message of another chat', async () => {
    const id = `false_${OTHER}_IN_628333333333@c.us`;
    const message = { ...ownMessage(id, '628000000000@c.us'), fromMe: false, from: OTHER };
    const { messaging } = makeMessaging({ [id]: message });

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it('answers 404 when the named chat is unknown to WhatsApp Web', async () => {
    const id = `true_${OTHER}_Y`;
    const { messaging, getChatById } = makeMessaging({ [id]: ownMessage(id, OTHER) });

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(getChatById).toHaveBeenCalledWith(GROUP);
  });

  it('answers 404 for an own message that names no chat, even when the named chat is unknown too', async () => {
    const id = `true_${OTHER}_NOTO`;
    const message = { ...ownMessage(id, OTHER), to: undefined };
    const { messaging } = makeMessaging({ [id]: message });

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(message.getInfo).not.toHaveBeenCalled();
  });

  it('answers 404, not 403, for a received message that names no chat', async () => {
    const id = `false_${OTHER}_NOFROM`;
    const message = { ...ownMessage(id, '628000000000@c.us'), fromMe: false, from: undefined };
    const { messaging } = makeMessaging({ [id]: message });

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it('matches a chat named in another dialect of the same id without asking the page', async () => {
    const chat = '628123456789@c.us';
    const id = `true_${chat}_3EB0DIALECT_out`;
    const { messaging, getChatById } = makeMessaging({ [id]: ownMessage(id, '628123456789:1@s.whatsapp.net') });

    await expect(messaging.getMessageReceipts(chat, id)).resolves.toMatchObject({ deliveryRemaining: 2 });
    expect(getChatById).not.toHaveBeenCalled();
  });

  it('passes on a chat lookup that fails for another reason', async () => {
    const id = `true_${OTHER}_Z`;
    const failure = new Error('chat lookup failed');
    const { messaging } = makeMessaging({ [id]: ownMessage(id, OTHER) }, jest.fn().mockRejectedValue(failure));

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBe(failure);
  });

  it('accepts the @c.us name of a 1:1 chat WhatsApp Web keeps under the @lid', async () => {
    const lid = '99887766554433@lid';
    const id = `true_${lid}_LID`;
    const getChatById = jest.fn().mockResolvedValue({ id: { _serialized: lid } });
    const { messaging } = makeMessaging({ [id]: ownMessage(id, lid) }, getChatById);

    await expect(messaging.getMessageReceipts('628222222222@c.us', id)).resolves.toMatchObject({ readRemaining: 1 });
    expect(getChatById).toHaveBeenCalledWith('628222222222@c.us');
  });

  it.each([
    '3EB0ABCDEF',
    `true_${GROUP}_A_B_C`,
    'true_notawid_3EB0ABCDEF',
    `maybe_${GROUP}_3EB0ABCDEF`,
    `true_${GROUP}`,
  ])('answers 404 with no page call for %s, which is not a full serialized id', async id => {
    const { messaging, getMessageById } = makeMessaging({});

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(getMessageById).not.toHaveBeenCalled();
  });

  it('reads the id of an own 1:1 message, which ends in out', async () => {
    const chat = '628123456789@c.us';
    const id = `true_${chat}_3EB0ABCDEF_out`;
    const { messaging, getMessageById } = makeMessaging({ [id]: ownMessage(id, chat) });

    await expect(messaging.getMessageReceipts(chat, id)).resolves.toMatchObject({ deliveryRemaining: 2 });
    expect(getMessageById).toHaveBeenCalledWith(id);
  });

  it('reads the id of a group message, which ends in the sender', async () => {
    const id = `true_${GROUP}_3EB0ABCDEF_628111111111@lid`;
    const { messaging } = makeMessaging({ [id]: ownMessage(id, GROUP) });

    await expect(messaging.getMessageReceipts(GROUP, id)).resolves.toMatchObject({ readRemaining: 1 });
  });

  it('answers 409 before it looks at the id when the session is not ready', async () => {
    const notReady = new Error('session is not ready');
    const { messaging, ensureReady, getMessageById } = makeMessaging({});
    ensureReady.mockImplementation(() => {
      throw notReady;
    });

    await expect(messaging.getMessageReceipts(GROUP, '3EB0ABCDEF')).rejects.toBe(notReady);
    expect(getMessageById).not.toHaveBeenCalled();
  });

  it('answers 404 for an id WhatsApp Web does not hold', async () => {
    const { messaging } = makeMessaging({});

    await expect(messaging.getMessageReceipts(GROUP, `true_${GROUP}_NONE`)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('refuses a received message instead of reporting that nobody read it', async () => {
    const id = `false_${GROUP}_IN_628333333333@c.us`;
    const message = { ...ownMessage(id, '628000000000@c.us'), fromMe: false, from: GROUP };
    const { messaging } = makeMessaging({ [id]: message });

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(EngineRefusedError);
    expect(message.getInfo).not.toHaveBeenCalled();
  });

  it('answers 404 when getInfo no longer finds the message', async () => {
    const id = `true_${GROUP}_GONE`;
    const { messaging } = makeMessaging({ [id]: ownMessage(id, GROUP, null) });

    await expect(messaging.getMessageReceipts(GROUP, id)).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it('checks readiness again between the lookup and reading through the message', async () => {
    const id = `true_${GROUP}_READY`;
    const message = ownMessage(id, GROUP);
    const { messaging, ensureReady, getMessageById } = makeMessaging({ [id]: message });
    const order: string[] = [];
    ensureReady.mockImplementation(() => order.push('ensureReady'));
    getMessageById.mockImplementation(() => {
      order.push('getMessageById');
      return Promise.resolve(message);
    });
    message.getInfo.mockImplementation(() => {
      order.push('getInfo');
      return Promise.resolve(INFO);
    });

    await messaging.getMessageReceipts(GROUP, id);
    expect(order).toEqual(['ensureReady', 'getMessageById', 'ensureReady', 'getInfo']);
  });

  it('answers a dead page with the 503 and reports the death', async () => {
    const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
    const { messaging, reportIfPageTransportError, getMessageById } = makeMessaging({}, undefined, dead);
    getMessageById.mockRejectedValue(dead);

    await expect(messaging.getMessageReceipts(GROUP, `true_${GROUP}_DEAD`)).rejects.toBeInstanceOf(
      EngineTransportError,
    );
    expect(reportIfPageTransportError).toHaveBeenCalledWith(dead, 'getMessageReceipts');
  });
});
