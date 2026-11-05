import { EventEmitter } from 'events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { isMentionWid } from '../../modules/message/dto/is-mention-wid.validator';

/**
 * The send DTOs accept a mention in any spelling of an individual id (padding, upper case, the `s.whatsapp.net`
 * dialect, a `:device` suffix), because the validator parses a trimmed, lower-cased copy and the value itself is
 * not rewritten. WhatsApp Web maps every entry through its strict id parser, so each accepted spelling has to reach
 * it as the one neutral id it names, as the Baileys adapter folds them.
 */
describe('a whatsapp-web.js mention in another spelling of an individual id', () => {
  const CHAT = '628111222333@c.us';
  const NEUTRAL = '628123456789@c.us';
  const SPELLINGS = [' 628123456789@c.us', '628123456789@C.US', '628123456789@s.whatsapp.net', '628123456789:5@c.us'];
  const FOLDED = SPELLINGS.map(() => NEUTRAL);
  const SENT = { id: { _serialized: 'true_628111222333@c.us_M1' }, timestamp: 1 };
  const PIXEL = Buffer.from([1]).toString('base64');

  function ready(client: Record<string, unknown>): WhatsAppWebJsAdapter {
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

  const getNumberId = () => jest.fn().mockResolvedValue({ _serialized: CHAT });
  const mentionsOf = (send: jest.Mock): unknown =>
    (send.mock.calls as Array<[unknown, unknown, { mentions?: string[] }]>)[0][2].mentions;

  it('is accepted by the mention validator in every spelling', () => {
    expect(SPELLINGS.map(isMentionWid)).toEqual(SPELLINGS.map(() => true));
  });

  it('reaches the page as the neutral id on a text send', async () => {
    const sendMessage = jest.fn().mockResolvedValue(SENT);

    await ready({ sendMessage, getNumberId: getNumberId() }).sendTextMessage(CHAT, 'hi @628123456789', SPELLINGS);

    expect(mentionsOf(sendMessage)).toEqual(FOLDED);
  });

  it('reaches the page as the neutral id on a media caption', async () => {
    const sendMessage = jest.fn().mockResolvedValue(SENT);

    await ready({ sendMessage, getNumberId: getNumberId() }).sendImageMessage(CHAT, {
      mimetype: 'image/jpeg',
      data: 'aGk=',
      caption: 'hi @628123456789',
      mentions: SPELLINGS,
    });

    expect(mentionsOf(sendMessage)).toEqual(FOLDED);
  });

  it('reaches the page as the neutral id on a sticker', async () => {
    const sendMessage = jest.fn().mockResolvedValue(SENT);

    await ready({ sendMessage, getNumberId: getNumberId() }).sendStickerMessage(CHAT, {
      mimetype: 'image/webp',
      data: PIXEL,
      mentions: SPELLINGS,
    });

    expect(mentionsOf(sendMessage)).toEqual(FOLDED);
  });

  it('reaches the page as the neutral id on a reply', async () => {
    const reply = jest.fn().mockResolvedValue(SENT);
    const fetchMessages = jest.fn().mockResolvedValue([{ id: { _serialized: 'Q1' }, reply }]);
    const getChatById = jest.fn().mockResolvedValue({ fetchMessages });

    await ready({ getChatById, getNumberId: getNumberId() }).replyToMessage(CHAT, 'Q1', 'hi @628123456789', SPELLINGS);

    expect(reply).toHaveBeenCalledWith('hi @628123456789', CHAT, { mentions: FOLDED });
  });

  it('reaches the page as the neutral id on an edit', async () => {
    const edit = jest.fn().mockResolvedValue(SENT);
    const fetchMessages = jest.fn().mockResolvedValue([{ id: { _serialized: 'M1' }, edit }]);
    const getChatById = jest.fn().mockResolvedValue({ fetchMessages });

    await ready({ getChatById }).editMessage(CHAT, 'M1', 'new @628123456789', SPELLINGS);

    expect(edit).toHaveBeenCalledWith('new @628123456789', { mentions: FOLDED });
  });

  it.each([
    ['a lid', '159442138038327@lid', '159442138038327@lid'],
    ['an upper-case lid', '159442138038327@LID', '159442138038327@lid'],
    ['a hosted lid', '159442138038327@hosted.lid', '159442138038327@lid'],
    ['a hosted phone id', '628123456789@hosted', NEUTRAL],
  ])('folds %s to its neutral id without turning a lid into a phone id', async (_name, typed, folded) => {
    const sendMessage = jest.fn().mockResolvedValue(SENT);

    await ready({ sendMessage, getNumberId: getNumberId() }).sendTextMessage(CHAT, 'hi', [typed]);

    expect(mentionsOf(sendMessage)).toEqual([folded]);
  });

  it('hands a mention that is not a string on untouched instead of failing the send', async () => {
    const sendMessage = jest.fn().mockResolvedValue(SENT);
    const odd = 5 as unknown as string;

    await ready({ sendMessage, getNumberId: getNumberId() }).sendTextMessage(CHAT, 'hi', [SPELLINGS[0], odd]);

    expect(mentionsOf(sendMessage)).toEqual([NEUTRAL, odd]);
  });

  // A message:sending plugin may rewrite the list into a single string, which the library wraps itself.
  it('hands a mention list that is not an array on untouched instead of failing the send', async () => {
    const sendMessage = jest.fn().mockResolvedValue(SENT);
    const single = SPELLINGS[0] as unknown as string[];

    await ready({ sendMessage, getNumberId: getNumberId() }).sendTextMessage(CHAT, 'hi', single);

    expect(mentionsOf(sendMessage)).toBe(single);
  });
});
