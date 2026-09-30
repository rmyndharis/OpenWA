import * as path from 'path';
import type { Client } from 'whatsapp-web.js';
import { CAPTURED_PAGE_ERROR_PREFIX, WwebjsLifecycle, toCapturedPageError } from './wwebjs-lifecycle';
import { EnginePageError } from '../../common/errors/engine-page.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { createLogger } from '../../common/services/logger.service';
import { WwebjsMessaging } from './wwebjs-messaging';
import { type WwebjsEngineHost, reportPageDeath } from './wwebjs-host';

/**
 * A send failure scripts/patch-wwebjs-send-error.js captured inside the page quotes WhatsApp Web's
 * own text, and the dead-page classifier reads error text. Without the exemption, a refusal whose
 * summary happened to say "connection closed" would tear down a session whose page had just proved
 * it was alive by running the catch. The patcher's own spec (node:test) covers what the page code
 * builds; this one covers how the gateway reads it.
 */

// The patcher is plain CommonJS under scripts/, loaded by path as engine-patch-status.spec.ts does.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const patcher = require(path.join(__dirname, '..', '..', '..', 'scripts', 'patch-wwebjs-send-error.js')) as {
  PREFIX: string;
};

const isPageTransportError = (error: unknown): boolean =>
  WwebjsLifecycle.prototype.isPageTransportError.call({}, error);

/** A captured error as puppeteer hands it over: a plain Error whose message is the prefix and the JSON. */
const captured = (info: Record<string, string>): Error => new Error(CAPTURED_PAGE_ERROR_PREFIX + JSON.stringify(info));

describe('a send failure captured inside the page', () => {
  it('uses the prefix the patcher builds it with', () => {
    // The patcher cannot import the TS constant (it runs at install time), so the two copies are
    // pinned here instead: a drifted prefix would silently switch the exemption below off.
    expect(patcher.PREFIX).toBe(CAPTURED_PAGE_ERROR_PREFIX);
  });

  it('is never read as a dead page, whatever WhatsApp Web text it quotes', () => {
    for (const quoted of ['connection closed', 'Target closed', 'Protocol error', 'Session closed']) {
      expect(isPageTransportError(captured({ ctor: 't', name: 't', message: quoted }))).toBe(false);
    }
  });

  it('leaves the same words a death when they are not a capture', () => {
    // Non-vacuity: the quoted text above is exactly what the pattern matches on its own, so the
    // exemption, and not the words, is what answers false there.
    expect(isPageTransportError(new Error('connection closed'))).toBe(true);
    expect(isPageTransportError(new Error('Protocol error (Runtime.callFunctionOn): Target closed'))).toBe(true);
    // A prefix that is not at the start is not a capture either.
    expect(isPageTransportError(new Error(`Session closed; ${CAPTURED_PAGE_ERROR_PREFIX}{}`))).toBe(true);
  });
});

describe('the reason a captured page failure gives the caller', () => {
  const summary = {
    build: '2.3000.1',
    ctor: 'MediaFileTooLarge',
    str: 'MediaFileTooLarge: too big',
    name: 'MediaFileTooLarge',
    message: 'too big',
    stack: 'MediaFileTooLarge: too big\n    at send (app.js:1:1)',
    code: '413',
  };

  it('is a 500 EnginePageError naming what WhatsApp Web threw, with no stack in the body', () => {
    const raw = captured(summary);
    const err = toCapturedPageError(raw) as EnginePageError;

    expect(err).toBeInstanceOf(EnginePageError);
    expect(err.getStatus()).toBe(500);
    expect(err.message).toBe('WhatsApp Web rejected the operation: MediaFileTooLarge: too big (build 2.3000.1)');
    expect(err.getResponse()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'ENGINE_PAGE_ERROR',
      message: 'WhatsApp Web rejected the operation: MediaFileTooLarge: too big (build 2.3000.1)',
      pageError: { name: 'MediaFileTooLarge', message: 'too big' },
      build: '2.3000.1',
    });
    expect(JSON.stringify(err.getResponse())).not.toContain('app.js');
    // The full summary stays reachable for the server log.
    expect(err.cause).toBe(raw);
  });

  it('falls back to the constructor and string of a thrown value that is not an Error', () => {
    const err = toCapturedPageError(
      captured({ build: '(unreadable)', ctor: 'String', str: 'boom', name: 'undefined', message: 'undefined' }),
    ) as EnginePageError;

    expect(err.getResponse()).toMatchObject({ pageError: { name: 'String', message: 'boom' } });
    expect(err.getResponse()).not.toHaveProperty('build');
    expect(err.message).toBe('WhatsApp Web rejected the operation: String: boom');
  });

  it('cuts a long name and message', () => {
    const err = toCapturedPageError(captured({ name: 'N'.repeat(500), message: 'm'.repeat(500) })) as EnginePageError;
    const body = err.getResponse() as { pageError: { name: string; message: string } };

    expect(body.pageError.name.length).toBeLessThanOrEqual(203);
    expect(body.pageError.message.length).toBeLessThanOrEqual(203);
  });

  it('leaves everything that is not a parseable capture untouched', () => {
    const malformed = new Error(`${CAPTURED_PAGE_ERROR_PREFIX}{not json`);
    const plain = new Error('Evaluation failed: Error: something else broke');
    for (const value of [malformed, plain, 'text', undefined]) {
      expect(toCapturedPageError(value)).toBe(value);
    }
  });

  const makeMessaging = (): {
    messaging: WwebjsMessaging;
    client: { sendMessage: jest.Mock };
    host: WwebjsEngineHost;
  } => {
    const client = { sendMessage: jest.fn() };
    const host = {
      ensureReady: jest.fn(),
      ensureNotChannelRecipient: jest.fn(),
      getClient: () => client as unknown as Client,
      logger: createLogger('wwebjs-send-page-error.spec'),
      config: {},
      getNumberId: jest.fn(),
      capInboundMediaFor: jest.fn(),
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    return { messaging: new WwebjsMessaging(host), client, host };
  };

  it('reaches the caller of a message send', async () => {
    const { messaging, client } = makeMessaging();
    client.sendMessage.mockRejectedValue(captured(summary));

    await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBeInstanceOf(EnginePageError);
  });

  it('reaches the caller when the send fails on the LID retry', async () => {
    const { messaging, client, host } = makeMessaging();
    (host.getNumberId as jest.Mock).mockResolvedValueOnce(undefined).mockResolvedValueOnce('999@lid');
    client.sendMessage
      .mockRejectedValueOnce(new Error('Evaluation failed: Error: No LID for user'))
      .mockRejectedValueOnce(captured(summary));

    await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBeInstanceOf(EnginePageError);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not take over the recipient remap of a plain No LID failure', async () => {
    const { messaging, client, host } = makeMessaging();
    (host.getNumberId as jest.Mock).mockResolvedValue(undefined);
    client.sendMessage.mockRejectedValue(new Error('Evaluation failed: Error: No LID for user'));

    await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBeInstanceOf(RecipientUnreachableError);
  });

  it('reaches the caller of a status post', async () => {
    const report = jest.fn();
    const host = {
      logger: { warn: jest.fn() },
      config: {},
      isPageTransportError: () => false,
      reportIfPageTransportError: report,
    } as unknown as WwebjsEngineHost;
    const raw = captured(summary);

    await expect(reportPageDeath(host, 'postTextStatus', () => Promise.reject(raw))).rejects.toBeInstanceOf(
      EnginePageError,
    );
    expect(report).toHaveBeenCalledWith(raw, 'postTextStatus');
  });

  it('leaves the full summary of a status post failure in the server log', async () => {
    // The EnginePageError is an HttpException, which Nest does not log, and the status path logs
    // nothing of its own: without this line the stack and own properties reach no log at all.
    const warn = jest.fn();
    const host = {
      logger: { warn },
      config: { sessionId: 'sess-1' },
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    const raw = captured(summary);

    await expect(reportPageDeath(host, 'postTextStatus', () => Promise.reject(raw))).rejects.toBeInstanceOf(
      EnginePageError,
    );
    expect(warn).toHaveBeenCalledWith('WhatsApp Web threw during postTextStatus', {
      sessionId: 'sess-1',
      cause: raw.message,
    });
  });

  it('logs nothing of its own for an error it passes through unchanged', async () => {
    const warn = jest.fn();
    const host = {
      logger: { warn },
      config: { sessionId: 'sess-1' },
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    const plain = new Error('boom');

    await expect(reportPageDeath(host, 'postTextStatus', () => Promise.reject(plain))).rejects.toBe(plain);
    expect(warn).not.toHaveBeenCalled();
  });
});
