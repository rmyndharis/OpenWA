import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { WwebjsStatus } from './wwebjs-status';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * A teardown (logout, destroy, reconnect) nulls the adapter's client while a send is parked on an
 * await between ensureReady() and the sendMessage call: the recipient lookup, or a media fetch. The
 * host closure then hands the delegate that null as if it were a Client, so the send died as a
 * TypeError 500 and counted toward the send breaker. It answers the retryable not-ready 409 instead.
 */
const logger = createLogger('wwebjs-messaging-client-gone.spec');

const CHAT = '628111@c.us';
// Base64 rather than a URL: a URL payload runs the real remote-media loader through the SSRF guard.
const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimetype: 'image/png',
};

function makeMessaging(): { messaging: WwebjsMessaging; sendMessage: jest.Mock } {
  const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 });
  let client: unknown = { sendMessage };
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as Client,
    logger,
    config: {},
    // The recipient lookup is the await the teardown lands in.
    getNumberId: jest.fn(() => {
      client = null;
      return Promise.resolve(CHAT);
    }),
    capInboundMediaFor: jest.fn(),
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), sendMessage };
}

describe('WwebjsMessaging when the client is torn down mid-send', () => {
  it.each([
    ['text', (m: WwebjsMessaging) => m.sendTextMessage(CHAT, 'hi')],
    ['image', (m: WwebjsMessaging) => m.sendImageMessage(CHAT, IMAGE)],
    ['location', (m: WwebjsMessaging) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2 })],
  ])('answers the not-ready 409 for a %s send, which the send breaker ignores', async (_kind, send) => {
    const { messaging, sendMessage } = makeMessaging();

    const error: unknown = await send(messaging).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(countsTowardSendBreaker(error)).toBe(false);
    expect(sentNothing(error)).toBe(true);
  });
});

describe('WwebjsStatus when the client is torn down mid-post', () => {
  // A media status awaits its media before it reaches the client, so it has the same gap as a media send, and
  // a TypeError there reaches the status breaker as an account failure.
  it('answers the not-ready 409 for a media status, which the send breaker ignores', async () => {
    const sendMessage = jest.fn();
    let client: unknown = { sendMessage };
    const host = {
      // Readiness passes, then the teardown lands before the post reaches the client.
      ensureReady: jest.fn(() => {
        client = null;
      }),
      getClient: () => client as Client,
      logger,
      config: {},
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;

    const error: unknown = await new WwebjsStatus(host).postImageStatus(IMAGE, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(countsTowardSendBreaker(error)).toBe(false);
  });
});
