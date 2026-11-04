import type { Client } from 'whatsapp-web.js';
import { CAPTURED_PAGE_ERROR_PREFIX } from './wwebjs-lifecycle';
import { EnginePageError } from '../../common/errors/engine-page.error';
import { WwebjsMessaging } from './wwebjs-messaging';
import { WwebjsStatus } from './wwebjs-status';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * WhatsApp Web loads a video into a `<video>` element before it uploads it and throws a bare
 * `TimeoutError` after 20 s when that load neither finishes nor fails. The gateway cannot tell why
 * from the error, so the failed send also logs what the page answers about the two conditions worth
 * checking first (#1902).
 */

/** A send failure as puppeteer hands it over once scripts/patch-wwebjs-send-error.js captured it. */
const captured = (name: string, message: string): Error =>
  new Error(CAPTURED_PAGE_ERROR_PREFIX + JSON.stringify({ build: '2.3000.1', ctor: 't', name, message }));

const timeout = (): Error => captured('TimeoutError', 'TimeoutError');

const CHAT = '628111@c.us';
const VIDEO = { mimetype: 'video/mp4', data: 'aGk=' };
const IMAGE = { mimetype: 'image/jpeg', data: 'aGk=' };
const WARNING = 'WhatsApp Web timed out loading a video. See docs/12-troubleshooting-faq.md.';

/** The probe is not awaited by the send, so let it settle before reading the log. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Run the page function against a stub document, as the page would. */
const pageAnswering =
  (visibility: string, h264Aac: string) =>
  <T>(fn: () => T): Promise<T> => {
    const g = globalThis as unknown as { document?: unknown };
    g.document = { visibilityState: visibility, createElement: () => ({ canPlayType: () => h264Aac }) };
    try {
      return Promise.resolve(fn());
    } finally {
      delete g.document;
    }
  };

function makeHost(evaluate: jest.Mock): {
  host: WwebjsEngineHost;
  client: { sendMessage: jest.Mock };
  warn: jest.Mock;
} {
  const client = {
    sendMessage: jest.fn(),
    pupPage: { evaluate },
    pupBrowser: { version: jest.fn().mockResolvedValue('Chrome/153.0.8010.36') },
  };
  const warn = jest.fn();
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger: { warn, log: jest.fn(), debug: jest.fn(), error: jest.fn() },
    config: { sessionId: 'sess-1' },
    getNumberId: jest.fn(),
    capInboundMediaFor: jest.fn(),
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { host, client, warn };
}

describe('a video send WhatsApp Web timed out on', () => {
  it('logs what the page answers, and the caller still gets the page error', async () => {
    const { host, client, warn } = makeHost(jest.fn(pageAnswering('hidden', 'probably')));
    client.sendMessage.mockRejectedValue(timeout());

    await expect(new WwebjsMessaging(host).sendVideoMessage(CHAT, VIDEO)).rejects.toBeInstanceOf(EnginePageError);
    await flush();

    expect(warn).toHaveBeenCalledWith(WARNING, {
      sessionId: 'sess-1',
      action: 'video_load_timeout',
      pageVisibility: 'hidden',
      h264Aac: 'probably',
      browser: 'Chrome/153.0.8010.36',
    });
  });

  it('logs the same for a video status post', async () => {
    const { host, client, warn } = makeHost(jest.fn(pageAnswering('visible', '')));
    client.sendMessage.mockRejectedValue(timeout());

    await expect(new WwebjsStatus(host).postVideoStatus(VIDEO, {})).rejects.toBeInstanceOf(EnginePageError);
    await flush();

    expect(warn).toHaveBeenCalledWith(
      WARNING,
      expect.objectContaining({ action: 'video_load_timeout', pageVisibility: 'visible', h264Aac: '' }),
    );
  });

  it('logs nothing more when the page cannot answer', async () => {
    const { host, client, warn } = makeHost(jest.fn().mockRejectedValue(new Error('Target closed')));
    client.sendMessage.mockRejectedValue(timeout());

    await expect(new WwebjsMessaging(host).sendVideoMessage(CHAT, VIDEO)).rejects.toBeInstanceOf(EnginePageError);
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });

  it('rethrows the original error when the media carries no mimetype', async () => {
    const { host, client } = makeHost(jest.fn());
    const raw = new Error('boom');
    client.sendMessage.mockRejectedValue(raw);

    const send = new WwebjsMessaging(host).sendVideoMessage(CHAT, { data: 'aGk=' } as unknown as typeof VIDEO);
    await expect(send).rejects.toBe(raw);
  });

  it.each([
    ['another page error on a video', VIDEO, () => captured('MediaUnsupportedError', 'no dims')],
    ['a timeout on an image', IMAGE, timeout],
  ])('does not read the page for %s', async (_label, media, failure) => {
    const evaluate = jest.fn();
    const { host, client } = makeHost(evaluate);
    client.sendMessage.mockRejectedValue(failure());
    const messaging = new WwebjsMessaging(host);

    const send = media === IMAGE ? messaging.sendImageMessage(CHAT, media) : messaging.sendVideoMessage(CHAT, media);
    await expect(send).rejects.toBeInstanceOf(EnginePageError);
    await flush();

    expect(evaluate).not.toHaveBeenCalled();
  });
});
