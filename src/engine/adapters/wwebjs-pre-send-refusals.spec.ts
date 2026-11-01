import { EventEmitter } from 'events';
import { BadRequestException, HttpException } from '@nestjs/common';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { type WwebjsMessaging } from './wwebjs-messaging';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSentError, provesNothingSent } from '../../common/errors/engine-not-sent.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';

/**
 * A send whatsapp-web.js refuses before anything reaches WhatsApp sent nothing, and its refusal says so: a keyed send
 * then frees its Idempotency-Key for the corrected retry instead of answering "outcome unknown" for a message that
 * never left. A refusal raised after a send attempt proves nothing and stays unmarked.
 */
describe('whatsapp-web.js send refusals raised before anything is sent', () => {
  const GROUP = '120363000000000000@g.us';
  const CHANNEL = '120363401234567890@newsletter';
  const PHONE = '628111222333@c.us';
  const LID = '159442138038327@lid';
  const QUOTE_REFUSED = new Error('Could not get the quoted message.');
  const PROTOCOL_TIMEOUT = new Error(
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
  );

  function ready(client: Record<string, unknown> = {}): WhatsAppWebJsAdapter {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { client: unknown }).client = Object.assign(
      new EventEmitter(),
      { pupPage: new EventEmitter(), pupBrowser: new EventEmitter() },
      client,
    );
    return adapter;
  }

  const refusal = (send: Promise<unknown>): Promise<unknown> =>
    send.then(
      () => {
        throw new Error('expected the send to be refused');
      },
      (error: unknown) => error,
    );
  const status = (error: unknown): number => (error as HttpException).getStatus();
  // The quoted text send goes through the delegate, whose options carry the quote.
  const messaging = (adapter: WhatsAppWebJsAdapter): WwebjsMessaging =>
    (adapter as unknown as { messaging: WwebjsMessaging }).messaging;

  it('marks the 404 for a quote the page cannot resolve on the first attempt', async () => {
    const sendMessage = jest.fn().mockRejectedValue(QUOTE_REFUSED);

    const error = await refusal(
      messaging(ready({ sendMessage })).sendTextMessage(GROUP, 'hi', undefined, { quotedMessageId: 'Q1' }),
    );

    expect(error).toBeInstanceOf(MessageNotFoundError);
    expect(provesNothingSent(error)).toBe(true);
  });

  it.each([
    ['the chat is unknown', () => Promise.resolve(undefined)],
    ['the message is not in the chat', () => Promise.resolve({ fetchMessages: () => Promise.resolve([]) })],
  ])('marks the 404 of a reply when %s', async (_case, getChatById) => {
    const error = await refusal(ready({ getChatById }).replyToMessage(GROUP, 'Q1', 'hi'));

    expect(status(error)).toBe(404);
    expect(provesNothingSent(error)).toBe(true);
  });

  it.each([
    ['the chat is unknown', () => Promise.resolve(undefined)],
    ['the message is not in the chat', () => Promise.resolve({ fetchMessages: () => Promise.resolve([]) })],
  ])('marks the 404 of a forward when %s', async (_case, getChatById) => {
    const error = await refusal(ready({ getChatById }).forwardMessage(GROUP, PHONE, 'M1'));

    expect(status(error)).toBe(404);
    expect(provesNothingSent(error)).toBe(true);
  });

  it('answers a reply whose chat read outran the protocol budget with a 503 that sent nothing', async () => {
    const getChatById = jest.fn().mockRejectedValue(PROTOCOL_TIMEOUT);

    const error = await refusal(ready({ getChatById }).replyToMessage(GROUP, 'Q1', 'hi'));

    expect(error).toBeInstanceOf(EngineNotSentError);
  });

  it.each([
    [
      'a location to a channel',
      (a: WhatsAppWebJsAdapter) => a.sendLocationMessage(CHANNEL, { latitude: 1, longitude: 2 }),
    ],
    [
      'a poll to a status',
      (a: WhatsAppWebJsAdapter) => a.sendPollMessage('status@broadcast', { name: 'q', options: ['a', 'b'] }),
    ],
    ['a reply to a channel', (a: WhatsAppWebJsAdapter) => a.replyToMessage(CHANNEL, 'Q1', 'hi')],
    [
      'an image to a channel',
      (a: WhatsAppWebJsAdapter) => a.sendImageMessage(CHANNEL, { mimetype: 'image/png', data: 'aGk=' }),
    ],
    [
      'a custom link preview',
      (a: WhatsAppWebJsAdapter) =>
        a.sendTextMessage(GROUP, 'https://example.com', undefined, {
          customPreview: { url: 'https://example.com', title: 't' },
        }),
    ],
  ])('marks the 501 for %s', async (_case, send) => {
    const sendMessage = jest.fn();

    const error = await refusal(send(ready({ sendMessage })));

    expect(status(error)).toBe(501);
    expect(provesNothingSent(error)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // whatsapp-web.js converts only a type it reads as an image or a video, and throws a bare error before the page
  // send for anything else.
  it.each(['application/pdf', 'audio/ogg', 'application/octet-stream'])(
    'refuses a %s sticker with a 400 before the send',
    async mimetype => {
      // What Util.formatToWebpSticker throws for it, in Node, before the page send.
      const sendMessage = jest.fn().mockRejectedValue(new Error('Invalid media format'));

      const error = await refusal(ready({ sendMessage }).sendStickerMessage(GROUP, { mimetype, data: 'aGk=' }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(provesNothingSent(error)).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['image/png', 'video/mp4'])('hands a %s sticker to whatsapp-web.js to convert', async mimetype => {
    const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'true_x_M1' }, timestamp: 1 });

    await ready({ sendMessage }).sendStickerMessage(GROUP, { mimetype, data: 'aGk=' });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the quote 404 of a retry unmarked, since the first attempt may have been sent', async () => {
    const sendMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('No LID for user'))
      .mockRejectedValueOnce(QUOTE_REFUSED);
    const getNumberId = jest
      .fn()
      .mockResolvedValueOnce({ _serialized: PHONE })
      .mockResolvedValueOnce({ _serialized: LID });

    const error = await refusal(
      messaging(ready({ sendMessage, getNumberId })).sendTextMessage(PHONE, 'hi', undefined, { quotedMessageId: 'Q1' }),
    );

    expect(error).toBeInstanceOf(MessageNotFoundError);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(provesNothingSent(error)).toBe(false);
  });
});
