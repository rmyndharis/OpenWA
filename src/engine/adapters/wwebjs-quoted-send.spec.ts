import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * whatsapp-web.js attaches a quote as a plain send option, orthogonal to the content kind:
 * `quotedMessageId` is copied into `internalOptions` (in `Client.sendMessage`) BEFORE the content-kind
 * dispatch that moves the payload into `.media` / `.location` / `.poll` / `.contactCard`, so a quote
 * never competes with what is being sent.
 *
 * The reason these tests assert `ignoreQuoteErrors: false` rather than just the id: the library
 * default is TRUE (`Client.sendMessage` documents `[ignoreQuoteErrors = true]` and applies it), which
 * makes an unresolvable quote send the message ANYWAY, unquoted, and report success. A caller who
 * asked for a reply and got a loose message with a 201 has no way to detect it. Opting out turns
 * that into an error the caller can see.
 */

const logger = createLogger('wwebjs-quoted-send.spec');

const QUOTED = 'true_628111@c.us_3EB0ABCD';

function makeMessaging(): { messaging: WwebjsMessaging; client: { sendMessage: jest.Mock } } {
  const client = {
    sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 }),
  };
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    config: {},
    getNumberId: jest.fn(),
    capInboundMediaFor: jest.fn(),
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), client };
}

const optionsOf = (client: { sendMessage: jest.Mock }): Record<string, unknown> => {
  const [, , options] = client.sendMessage.mock.calls[0] as unknown[];
  return (options ?? {}) as Record<string, unknown>;
};

const CHAT = '628111@c.us';
// Base64 rather than a URL: a URL payload runs the real remote-media loader through the SSRF guard,
// so the test would exercise the network instead of the option plumbing it is about.
const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimetype: 'image/png',
};

describe('WwebjsMessaging — a quote rides along with every content kind', () => {
  // Each of these builds its own options object (or, for location and poll, had none at all before
  // this change), so covering only the shared media funnel would leave the others silently unquoted.
  it.each([
    ['image', (m: WwebjsMessaging) => m.sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    ['document', (m: WwebjsMessaging) => m.sendDocumentMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    ['sticker', (m: WwebjsMessaging) => m.sendStickerMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    [
      'location',
      (m: WwebjsMessaging) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2, quotedMessageId: QUOTED }),
    ],
    [
      'contact',
      (m: WwebjsMessaging) => m.sendContactMessage(CHAT, { name: 'Alice', number: '628999', quotedMessageId: QUOTED }),
    ],
    [
      'poll',
      (m: WwebjsMessaging) => m.sendPollMessage(CHAT, { name: 'Q', options: ['a', 'b'], quotedMessageId: QUOTED }),
    ],
    ['text', (m: WwebjsMessaging) => m.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: QUOTED })],
  ])('%s send forwards the quoted id with quote errors made visible', async (_kind, send) => {
    const { messaging, client } = makeMessaging();

    await send(messaging);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(optionsOf(client).quotedMessageId).toBe(QUOTED);
    // The library would otherwise send unquoted and report success on a bad id.
    expect(optionsOf(client).ignoreQuoteErrors).toBe(false);
  });

  // Known-negative control: without it an implementation that hardcoded the keys onto every send
  // would satisfy every assertion above while changing behaviour for unquoted callers too.
  it('adds no quote keys at all when no id is supplied', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendImageMessage(CHAT, IMAGE);

    expect(optionsOf(client)).not.toHaveProperty('quotedMessageId');
    expect(optionsOf(client)).not.toHaveProperty('ignoreQuoteErrors');
  });

  it('keeps the caption and mentions it already sent alongside the quote', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendImageMessage(CHAT, {
      ...IMAGE,
      caption: 'look',
      mentions: ['628222@c.us'],
      quotedMessageId: QUOTED,
    });

    expect(optionsOf(client)).toMatchObject({
      caption: 'look',
      mentions: ['628222@c.us'],
      quotedMessageId: QUOTED,
    });
  });

  it('keeps sendMediaAsDocument, which shares the options object with the quote', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendDocumentMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED });

    expect(optionsOf(client).sendMediaAsDocument).toBe(true);
    expect(optionsOf(client).quotedMessageId).toBe(QUOTED);
  });

  /**
   * Opting out of `ignoreQuoteErrors` only gets the caller an error; it does not decide WHICH error.
   * The page throws a bare `Error`, and two things ride on that being remapped: the caller sees the
   * same 404 the Baileys adapter returns for the identical request (and that `docs/06` publishes for
   * both engines), and `countsTowardSendBreaker` treats anything that is not an HttpException as an
   * account-standing failure — so an unmapped error let a caller's own stale id trip the send breaker.
   */
  describe('an id the page cannot resolve', () => {
    const pageError = (): Error => new Error('Evaluation failed: Error: Could not get the quoted message.');

    it.each([
      ['image', (m: WwebjsMessaging) => m.sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
      ['sticker', (m: WwebjsMessaging) => m.sendStickerMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
      [
        'location',
        (m: WwebjsMessaging) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2, quotedMessageId: QUOTED }),
      ],
      [
        'contact',
        (m: WwebjsMessaging) =>
          m.sendContactMessage(CHAT, { name: 'Alice', number: '628999', quotedMessageId: QUOTED }),
      ],
      [
        'poll',
        (m: WwebjsMessaging) => m.sendPollMessage(CHAT, { name: 'Q', options: ['a', 'b'], quotedMessageId: QUOTED }),
      ],
      ['text', (m: WwebjsMessaging) => m.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: QUOTED })],
    ])('is a 404 naming the id, not a bare 500, on a %s send', async (_kind, send) => {
      const { messaging, client } = makeMessaging();
      client.sendMessage.mockRejectedValue(pageError());

      // getStatus() rather than a `status` property: that is what NestJS exposes, and what
      // message-not-found.error.spec.ts already pins the 404 mapping on.
      await expect(send(messaging)).rejects.toBeInstanceOf(MessageNotFoundError);
      const err = (await send(messaging).catch((e: unknown) => e)) as MessageNotFoundError;
      expect(err.getStatus()).toBe(404);
      expect(err.message).toContain(QUOTED);
    });

    // Known-negative control: the remap keys off the id the caller supplied, so a send that asked
    // for no quote must still surface the page's own error rather than a fabricated not-found.
    it('leaves the error of an unquoted send untouched', async () => {
      const { messaging, client } = makeMessaging();
      client.sendMessage.mockRejectedValue(pageError());

      const err = (await messaging.sendImageMessage(CHAT, IMAGE).catch((e: unknown) => e)) as Error;
      expect(err).not.toBeInstanceOf(MessageNotFoundError);
      expect(err.message).toContain('Could not get the quoted message');
    });

    /**
     * The LID retry runs the send a SECOND time against a freshly resolved recipient, through its own
     * catch — which the first attempt's remap does not cover. Re-resolving the RECIPIENT says nothing
     * about the quoted message, so a send that gets past the stale id and only then fails on the quote
     * is the same caller fault. Without the second remap, one request answers 404 or 500 depending on
     * whether the recipient happened to need re-resolving.
     */
    it('is still a 404 when the quote fails on the LID retry rather than the first attempt', async () => {
      const { messaging, client } = makeMessaging();
      const host = (messaging as unknown as { host: { getNumberId: jest.Mock } }).host;
      // First resolve yields nothing (the send goes to the raw @c.us); after the LID failure the
      // re-resolve returns a DIFFERENT id, which is what makes sendResolved retry at all.
      host.getNumberId.mockResolvedValueOnce(undefined).mockResolvedValueOnce('999@lid');
      client.sendMessage
        .mockRejectedValueOnce(new Error('Evaluation failed: Error: No LID for user'))
        .mockRejectedValueOnce(pageError());

      const err = (await messaging
        .sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })
        .catch((e: unknown) => e)) as MessageNotFoundError;

      expect(client.sendMessage).toHaveBeenCalledTimes(2); // the retry really ran
      expect(err).toBeInstanceOf(MessageNotFoundError);
      expect(err.getStatus()).toBe(404);
      expect(err.message).toContain(QUOTED);
    });

    // Second control: an unrelated failure on a QUOTED send must not be relabelled not-found.
    it('does not relabel an unrelated send failure as a missing quote', async () => {
      const { messaging, client } = makeMessaging();
      client.sendMessage.mockRejectedValue(new Error('Evaluation failed: Error: something else broke'));

      const err = (await messaging
        .sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })
        .catch((e: unknown) => e)) as Error;
      expect(err).not.toBeInstanceOf(MessageNotFoundError);
      expect(err.message).toContain('something else broke');
    });
  });
});
