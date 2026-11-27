import type { Client } from 'whatsapp-web.js';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { WwebjsMessaging } from './wwebjs-messaging';

/**
 * The number lookup a send makes first can answer another number than the caller wrote: WhatsApp holds some
 * numbers under other digits than people type (a Brazilian mobile with or without its ninth digit). The message
 * goes to the number the lookup answered, and the send result names it, so the stored row is filed in the chat the
 * conversation is in. A lookup that answers the contact's lid names no phone, and its pair is reported under the
 * id the caller wrote, so that result names nothing.
 */
const logger = createLogger('wwebjs-send-resolved-number.spec');
const TYPED = '5511987654321@c.us';
const HELD = '551187654321@c.us';
const LID = '484848484848@lid';

function makeMessaging(lookup: (number: string) => Promise<string | null>) {
  const sent = { id: { _serialized: 'M1' }, timestamp: 1 };
  // The message a reply quotes and a forward copies, as the chat holds it.
  const held = {
    id: { _serialized: 'Q1' },
    timestamp: 1,
    reply: jest.fn().mockResolvedValue(sent),
    forward: jest.fn(),
  };
  const chat = { fetchMessages: jest.fn().mockResolvedValue([held]) };
  const client = {
    sendMessage: jest.fn().mockResolvedValue(sent),
    getChatById: jest.fn().mockResolvedValue(chat),
  };
  const getNumberId = jest.fn(lookup);
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    config: {},
    getNumberId,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), client, getNumberId, held, chat };
}
const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimetype: 'image/png',
};
const sentTo = (client: { sendMessage: jest.Mock }): unknown[] =>
  client.sendMessage.mock.calls.map((call: unknown[]) => call[0]);

type Send = (m: WwebjsMessaging, to: string) => Promise<unknown>;
const sends: Array<[string, Send]> = [
  ['a text', (m, to) => m.sendTextMessage(to, 'hi')],
  ['a location', (m, to) => m.sendLocationMessage(to, { latitude: 1, longitude: 2 })],
  ['a contact card', (m, to) => m.sendContactMessage(to, { name: 'Alice', number: '628999' })],
  ['a poll', (m, to) => m.sendPollMessage(to, { name: 'Q', options: ['a', 'b'] })],
  ['an image', (m, to) => m.sendImageMessage(to, IMAGE)],
  ['a sticker', (m, to) => m.sendStickerMessage(to, IMAGE)],
];

describe('WwebjsMessaging: a send to a number WhatsApp holds under other digits', () => {
  it.each(sends)('names the number the lookup answered in the result of %s', async (_kind, send) => {
    const { messaging, client } = makeMessaging(() => Promise.resolve(HELD));

    await expect(send(messaging, TYPED)).resolves.toEqual({
      id: 'M1',
      timestamp: 1,
      resolvedChatId: HELD,
      engineChatId: HELD,
    });
    expect(sentTo(client)).toEqual([HELD]);
  });

  it('names it in the result of a reply, which the quoted message sends', async () => {
    const { messaging, held } = makeMessaging(() => Promise.resolve(HELD));

    await expect(messaging.replyToMessage(TYPED, 'Q1', 'hi')).resolves.toEqual({
      id: 'M1',
      timestamp: 1,
      resolvedChatId: HELD,
      engineChatId: HELD,
    });
    expect(held.reply).toHaveBeenCalledWith('hi', HELD);
  });

  it.each([
    ['whose copy it finds in the chat', [{ id: { _serialized: 'FWD' }, timestamp: 5, isForwarded: true }], 'FWD'],
    ['whose copy it cannot tell', [], ''],
  ])('names it in the result of a forward %s', async (_case, after, id) => {
    const { messaging, held, chat } = makeMessaging(() => Promise.resolve(HELD));
    // The chat is read three times: for the message to forward, then before and after the forward.
    chat.fetchMessages.mockResolvedValueOnce([held]).mockResolvedValueOnce([]).mockResolvedValueOnce(after);

    const result = await messaging.forwardMessage('628111@c.us', TYPED, 'Q1');

    expect(result).toMatchObject({ id, resolvedChatId: HELD, engineChatId: HELD });
    expect(held.forward).toHaveBeenCalledWith(HELD);
  });

  it('names it again for a later send that reuses the lookup', async () => {
    const { messaging, getNumberId } = makeMessaging(() => Promise.resolve(HELD));

    await messaging.sendTextMessage(TYPED, 'first');
    const second = await messaging.sendTextMessage('5511987654321@s.whatsapp.net', 'second');

    expect(getNumberId).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ id: 'M1', timestamp: 1, resolvedChatId: HELD, engineChatId: HELD });
  });

  it.each<[string, string, () => Promise<string | null>, string]>([
    ['the lookup answers the number the caller wrote', TYPED, () => Promise.resolve(TYPED), TYPED],
    [
      'the caller wrote that number in the other dialect',
      '551187654321@s.whatsapp.net',
      () => Promise.resolve(HELD),
      HELD,
    ],
    ['the lookup answers nothing', TYPED, () => Promise.resolve(null), TYPED],
    ['the lookup fails', TYPED, () => Promise.reject(new Error('page busy')), TYPED],
    ['the caller addressed a lid', LID, () => Promise.resolve(HELD), LID],
    ['the caller addressed a group', '120363000000000001@g.us', () => Promise.resolve(HELD), '120363000000000001@g.us'],
  ])('names no other number when %s', async (_case, chatId, lookup, to) => {
    const { messaging, client } = makeMessaging(lookup);

    const result = await messaging.sendTextMessage(chatId, 'hi');

    expect(result).toStrictEqual({ id: 'M1', timestamp: 1 });
    expect(sentTo(client)).toEqual([to]);
  });
  it('names the lid as the chat the message went to when the lookup answers the lid of the contact', async () => {
    const { messaging, client } = makeMessaging(() => Promise.resolve(LID));

    await expect(messaging.sendTextMessage(TYPED, 'hi')).resolves.toStrictEqual({
      id: 'M1',
      timestamp: 1,
      engineChatId: LID,
    });
    expect(sentTo(client)).toEqual([LID]);
  });

  describe('named from the id the send was handed, not from what the lookup memory holds afterwards', () => {
    const sent = { id: { _serialized: 'M1' }, timestamp: 1 };
    /** The first send is held in the page until the test lets it go; every later one answers at once. */
    const holdFirstSend = (client: { sendMessage: jest.Mock }): (() => void) => {
      let release!: () => void;
      client.sendMessage.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve(sent);
          }),
      );
      return () => release();
    };
    const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('names nothing for a send handed the written id, though a later lookup of the number answered', async () => {
      const { messaging, client, getNumberId } = makeMessaging(() => Promise.resolve(HELD));
      getNumberId.mockImplementationOnce(() => Promise.reject(new Error('page busy')));
      const release = holdFirstSend(client);

      const first = messaging.sendTextMessage(TYPED, 'first');
      await turn();
      await messaging.sendTextMessage(TYPED, 'second');
      release();

      expect(sentTo(client)).toEqual([TYPED, HELD]);
      await expect(first).resolves.toStrictEqual({ id: 'M1', timestamp: 1 });
    });

    it('names the number a send was handed after another send replaced it in the memory with a lid', async () => {
      const { messaging, client, getNumberId } = makeMessaging(() => Promise.resolve(HELD));
      const release = holdFirstSend(client);

      const first = messaging.sendTextMessage(TYPED, 'first');
      await turn();
      // The second send is refused under the number and resolves the recipient again, to its lid this time.
      client.sendMessage.mockImplementationOnce(() => Promise.reject(new Error('No LID for user')));
      getNumberId.mockImplementationOnce(() => Promise.resolve(LID));
      await expect(messaging.sendTextMessage(TYPED, 'second')).resolves.toStrictEqual({
        id: 'M1',
        timestamp: 1,
        engineChatId: LID,
      });
      release();

      expect(sentTo(client)).toEqual([HELD, HELD, LID]);
      await expect(first).resolves.toEqual({ id: 'M1', timestamp: 1, resolvedChatId: HELD, engineChatId: HELD });
    });

    it('names it after the memory dropped the number for 5000 newer recipients', async () => {
      const { messaging, client, getNumberId } = makeMessaging(() => Promise.resolve(HELD));
      const release = holdFirstSend(client);

      const first = messaging.sendTextMessage(TYPED, 'first');
      await turn();
      getNumberId.mockImplementation((number: string) => Promise.resolve(number));
      for (let other = 0; other < 5000; other++) {
        await messaging.sendTextMessage(`62850000${String(other).padStart(4, '0')}@c.us`, 'other');
      }
      release();

      await expect(first).resolves.toEqual({ id: 'M1', timestamp: 1, resolvedChatId: HELD, engineChatId: HELD });
    }, 30_000);
  });
});
