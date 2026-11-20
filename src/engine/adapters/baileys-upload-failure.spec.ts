import type { WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSentError, hasUnknownOutcome, provesNothingSent } from '../../common/errors/engine-not-sent.error';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/run-idempotent-send';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

/**
 * Baileys' sendMessage builds the message first, which uploads its media with the `upload` option, and relays it
 * only after that. The fake socket keeps that order with the option it is handed, so an upload that fails is a
 * failure raised before anything was written, and the relay is recorded to show it was never reached.
 */
describe('a Baileys send whose media upload fails', () => {
  type UploadOptions = { fileEncSha256B64: string; mediaType: string; timeoutMs?: number };
  type SendOptions = {
    upload: (path: string, options: UploadOptions) => Promise<unknown>;
    mediaUploadTimeoutMs?: number;
  };
  type FakeSock = {
    onWhatsApp: jest.Mock;
    waUploadToServer: jest.Mock;
    sendMessage: jest.Mock;
  };

  const png = { data: Buffer.from('png'), mimetype: 'image/png' };
  const pdf = { data: Buffer.from('pdf'), mimetype: 'application/pdf', filename: 'a.pdf' };
  const recipients = { recipients: ['628111@c.us'] };

  let relayed: string[];
  let sock: FakeSock;
  let current: FakeSock | null;
  let proxyUrl: string | undefined;
  let messaging: BaileysMessaging;
  let statusOps: BaileysStatus;

  /** The upload the library makes while it builds a message: the caller's `upload` option, else its own. */
  const upload = async (target: FakeSock, options?: SendOptions): Promise<void> => {
    await (options?.upload ?? target.waUploadToServer)('/tmp/enc', {
      fileEncSha256B64: 'hash',
      mediaType: 'image',
      timeoutMs: options?.mediaUploadTimeoutMs,
    });
  };

  const fakeSock = (): FakeSock => {
    const target: FakeSock = {
      onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
      waUploadToServer: jest.fn().mockResolvedValue({ mediaUrl: 'https://mmg.example/u', directPath: '/d' }),
      sendMessage: jest.fn(async (jid: string, _content: unknown, options?: SendOptions) => {
        await upload(target, options);
        relayed.push(jid);
        return { key: { id: 'M1' }, messageTimestamp: 1 };
      }),
    };
    return target;
  };

  const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected the send to fail');
      },
      (error: unknown) => error,
    );

  /** What the three rules that read a failed send decide: the key, the pacing admission and the send breaker. */
  const verdict = (error: unknown) => ({
    freesKey: sendFailureProvesNothingSent(markEngineSendFailure(error)),
    givesAdmissionBack: sentNothing(error),
    countsTowardBreaker: countsTowardSendBreaker(error),
  });

  beforeEach(() => {
    relayed = [];
    sock = fakeSock();
    current = sock;
    proxyUrl = undefined;
    const host = {
      ensureReady: () => undefined,
      sessionProxyUrl: () => proxyUrl,
      getSocket: () => {
        if (!current) throw new EngineNotReadyError();
        return current as unknown as WASocket;
      },
      getSocketOrNull: () => current as unknown as WASocket | null,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (j: string) => j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () =>
        Promise.resolve({ normalizeMessageContent: (m: unknown) => m, getContentType: () => undefined } as never),
      getStoredMessage: () => Promise.resolve(null),
      wasDeletedForEveryone: () => false,
      pendingEditOf: () => undefined,
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost & BaileysStatusHost;
    messaging = new BaileysMessaging(host);
    statusOps = new BaileysStatus(host);
  });

  const sends: Array<[string, () => Promise<unknown>]> = [
    ['an image', () => messaging.sendImageMessage('628123456789@c.us', png)],
    ['a document', () => messaging.sendDocumentMessage('628123456789@c.us', pdf)],
    ['an image status', () => statusOps.postImageStatus(png, recipients)],
  ];

  describe.each(sends)('%s', (_kind, send) => {
    it('frees its key, gives its admission back and is not counted by the breaker when the host refuses it', async () => {
      const refusal = new Boom('Media upload failed on all hosts', { statusCode: 500 });
      sock.waUploadToServer.mockRejectedValue(refusal);

      const error = await failureOf(send());

      expect(error).toBe(refusal);
      expect(relayed).toEqual([]);
      expect(provesNothingSent(error)).toBe(true);
      expect(verdict(error)).toEqual({ freesKey: true, givesAdmissionBack: true, countsTowardBreaker: false });
    });

    it('keeps the refusal mapping of the query it makes', async () => {
      sock.waUploadToServer.mockRejectedValue(new Boom('rate-overlimit', { data: 429 }));
      const throttled = await failureOf(send());
      expect(throttled).toBeInstanceOf(EngineThrottledError);
      expect(verdict(throttled)).toEqual({ freesKey: true, givesAdmissionBack: true, countsTowardBreaker: true });

      sock.waUploadToServer.mockRejectedValue(new Boom('timed out', { data: 408 }));
      const timedOut = await failureOf(send());
      expect(timedOut).toBeInstanceOf(EngineTransportError);
      expect(verdict(timedOut)).toEqual({ freesKey: false, givesAdmissionBack: false, countsTowardBreaker: false });

      sock.waUploadToServer.mockRejectedValue(new Boom('Connection Closed', { statusCode: 428 }));
      const closed = await failureOf(send());
      expect(closed).toBeInstanceOf(EngineNotSentError);
      expect(verdict(closed)).toEqual({ freesKey: true, givesAdmissionBack: true, countsTowardBreaker: false });
      expect(relayed).toEqual([]);
    });

    it('passes the upload through to the socket as it is called, and relays after it succeeds', async () => {
      await send();

      expect(sock.waUploadToServer).toHaveBeenCalledWith('/tmp/enc', {
        fileEncSha256B64: 'hash',
        mediaType: 'image',
        timeoutMs: undefined,
      });
      expect(relayed).toHaveLength(1);
    });

    it('still bounds the upload of a proxied session', async () => {
      proxyUrl = 'http://proxy.example:8080';

      await send();

      expect(sock.waUploadToServer).toHaveBeenCalledWith(
        '/tmp/enc',
        expect.objectContaining({ timeoutMs: BAILEYS_QUERY_BUDGET_MS }),
      );
    });

    it('leaves a failure after the upload as unknown', async () => {
      sock.sendMessage.mockImplementation(async (_jid: string, _content: unknown, options?: SendOptions) => {
        await upload(sock, options);
        throw new Boom('write failed', { statusCode: 500 });
      });

      const error = await failureOf(send());

      expect(provesNothingSent(error)).toBe(false);
      expect(verdict(error)).toEqual({ freesKey: false, givesAdmissionBack: false, countsTowardBreaker: true });
    });
  });

  describe('on a socket replaced or stopped meanwhile', () => {
    it('answers 409 as nothing sent when the upload failed, since the write was never reached', async () => {
      sock.waUploadToServer.mockImplementation(() => {
        current = null;
        return Promise.reject(new Boom('Media upload failed on all hosts', { statusCode: 500 }));
      });

      const error = await failureOf(messaging.sendImageMessage('628123456789@c.us', png));

      expect(error).toBeInstanceOf(EngineNotReadyError);
      expect(provesNothingSent(error)).toBe(true);
      expect(hasUnknownOutcome(error)).toBe(false);
      expect(verdict(error)).toEqual({ freesKey: true, givesAdmissionBack: true, countsTowardBreaker: false });
    });

    it('keeps a send cut off after its upload as unknown', async () => {
      sock.sendMessage.mockImplementation(async (_jid: string, _content: unknown, options?: SendOptions) => {
        await upload(sock, options);
        current = null;
        throw new Boom('Connection Closed', { statusCode: 428 });
      });

      const error = await failureOf(messaging.sendImageMessage('628123456789@c.us', png));

      expect(error).toBeInstanceOf(EngineNotReadyError);
      expect(hasUnknownOutcome(error)).toBe(true);
      expect(verdict(error)).toEqual({ freesKey: false, givesAdmissionBack: false, countsTowardBreaker: false });
    });
  });
});
