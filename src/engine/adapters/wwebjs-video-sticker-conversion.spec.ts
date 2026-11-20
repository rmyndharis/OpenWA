import { EventEmitter } from 'events';
import { BadRequestException } from '@nestjs/common';
import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSentError } from '../../common/errors/engine-not-sent.error';
import { EnginePageError } from '../../common/errors/engine-page.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpeg = require('fluent-ffmpeg') as { setFfmpegPath(path: string): void };
const { Client } = wwebjs as unknown as {
  Client: { prototype: { sendMessage: (...args: unknown[]) => Promise<unknown> } };
};

/**
 * whatsapp-web.js converts a video sticker with the ffmpeg of the host, inside `Client.sendMessage` and before it calls
 * the page. A conversion that fails is a plain Error from fluent-ffmpeg, which the send read as an engine outcome: a 500
 * that counted toward the session's send breaker (five in a row refused every send of the session for fifteen minutes)
 * and kept the Idempotency-Key of a keyed send, though nothing had left the gateway. It is the caller's 400 when ffmpeg
 * refused the video, and a 503 that says nothing about the account when the host cannot run ffmpeg or its ffmpeg takes
 * none of the options the library passes. Both prove nothing was sent.
 */
describe('a video sticker that the ffmpeg conversion of whatsapp-web.js fails on', () => {
  const PHONE = '628123456789@c.us';

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const LID = '159442138038327@lid';
  const found = (id: string): { _serialized: string } => ({ _serialized: id });
  const video = (): { data: string; mimetype: string } => ({
    data: Buffer.from('not a video').toString('base64'),
    mimetype: 'video/mp4',
  });

  const build = (sendMessage: jest.Mock, getNumberId: jest.Mock = jest.fn().mockResolvedValue(found(PHONE))) => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = { getNumberId, sendMessage };
    return adapter;
  };

  const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => 'sent',
      (error: unknown) => error,
    );

  /** The text of each failure, as fluent-ffmpeg builds it from the process it ran (`ffmpeg exited with code N: stderr`). */
  const INPUT_REFUSED: Array<[string, string]> = [
    ['an input ffmpeg cannot decode', 'ffmpeg exited with code 1: pipe:0: Invalid data found when processing input'],
    ['a truncated input', 'ffmpeg exited with code 183: pipe:0: moov atom not found'],
    ['a declared type with no ffmpeg format', 'Input format quicktime is not available'],
  ];
  const HOST_CANNOT_RUN: Array<[string, string]> = [
    [
      'a host whose ffmpeg no longer reads -vsync',
      "ffmpeg exited with code 8: Unrecognized option 'vsync'.\nError splitting the argument list: Option not found",
    ],
    ['a build without the webp encoder', "ffmpeg exited with code 1: Unknown encoder 'libwebp'"],
    ['an output ffmpeg cannot open', 'ffmpeg exited with code 254: Error opening output file /tmp/x.webp.'],
    ['a host with no ffmpeg', 'Cannot find ffmpeg'],
    ['a host that cannot start ffmpeg', 'spawn ffmpeg ENOENT'],
    ['an ffmpeg the host killed', 'ffmpeg was killed with signal SIGKILL'],
    ['an ffmpeg with no webp muxer', 'Output format webp is not available'],
  ];

  describe.each([
    ['refused', INPUT_REFUSED, BadRequestException, 400],
    ['unusable', HOST_CANNOT_RUN, EngineNotSentError, 503],
  ] as const)('ffmpeg %s', (_kind, cases, expected, status) => {
    it.each(cases)(
      'answers %i for %s, which was never sent and does not count toward the breaker',
      async (_case, text) => {
        const sendMessage = jest.fn().mockRejectedValue(new Error(text));
        const error = (await failureOf(build(sendMessage).sendStickerMessage(PHONE, video()))) as {
          getStatus(): number;
        };

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(error).toBeInstanceOf(expected);
        expect(error.getStatus()).toBe(status);
        expect(sentNothing(error)).toBe(true);
        expect(countsTowardSendBreaker(error)).toBe(false);
        // A keyed send frees its Idempotency-Key for it.
        expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(true);
      },
    );
  });

  it('tells the caller what ffmpeg refused', async () => {
    const sendMessage = jest
      .fn()
      .mockRejectedValue(new Error('ffmpeg exited with code 1: pipe:0: Invalid data found when processing input'));

    await expect(build(sendMessage).sendStickerMessage(PHONE, video())).rejects.toThrow(
      'The video could not be converted to a sticker: ffmpeg exited with code 1: pipe:0: Invalid data found when processing input',
    );
  });

  it('keeps the host reason out of the answer and in the log', async () => {
    const adapter = build(jest.fn().mockRejectedValue(new Error('spawn ffmpeg ENOENT')));
    const warn = jest
      .spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    const error = (await failureOf(adapter.sendStickerMessage(PHONE, video()))) as Error;

    expect(error.message).not.toContain('ENOENT');
    expect(warn).toHaveBeenCalledWith(
      'ffmpeg could not convert a video sticker on this host',
      expect.objectContaining({ reason: 'spawn ffmpeg ENOENT' }),
    );
  });

  // Known-negative controls: what is not a conversion failure keeps the answer and the accounting it had.
  it.each([
    ['a plain engine error', new Error('boom')],
    ['an error of the page', new Error('Execution context was destroyed, most likely because of a navigation.')],
    ['a message that only mentions ffmpeg', new Error('the engine said ffmpeg exited with code 1')],
  ])('leaves %s alone', async (_case, thrown) => {
    const error = await failureOf(build(jest.fn().mockRejectedValue(thrown)).sendStickerMessage(PHONE, video()));

    expect(error).toBe(thrown);
    expect(countsTowardSendBreaker(error)).toBe(true);
    expect(sentNothing(error)).toBe(false);
  });

  it('still reads an error the page threw as the page error it is', async () => {
    const thrown = new Error('page threw ' + JSON.stringify({ name: 'TypeError', message: 'x is not a function' }));

    const error = await failureOf(build(jest.fn().mockRejectedValue(thrown)).sendStickerMessage(PHONE, video()));

    expect(error).toBeInstanceOf(EnginePageError);
    expect(countsTowardSendBreaker(error)).toBe(true);
  });

  // A retry after "No LID for user" follows an attempt that reached the page: a conversion that fails on the retry
  // says nothing about the first attempt, so the keyed send keeps its key, and the breaker still ignores it.
  it('leaves the outcome unknown when the conversion fails only on the retry', async () => {
    const sendMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('No LID for user'))
      .mockRejectedValueOnce(new Error('ffmpeg exited with code 1: pipe:0: Invalid data found when processing input'));
    const getNumberId = jest.fn().mockResolvedValueOnce(found(PHONE)).mockResolvedValueOnce(found(LID));

    const error = await failureOf(build(sendMessage, getNumberId).sendStickerMessage(PHONE, video()));

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(sentNothing(error)).toBe(false);
    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(false);
    expect(countsTowardSendBreaker(error)).toBe(false);
  });

  it('sends a converted webp as a sticker', async () => {
    const sendMessage = jest
      .fn()
      .mockResolvedValue({ id: { _serialized: 'true_628123456789@c.us_ABC' }, timestamp: 1 });
    const media = { data: Buffer.from('RIFF').toString('base64'), mimetype: 'image/webp' };

    await expect(build(sendMessage).sendStickerMessage(PHONE, media)).resolves.toEqual({
      id: 'true_628123456789@c.us_ABC',
      timestamp: 1,
    });

    expect(sendMessage).toHaveBeenCalledWith(PHONE, expect.objectContaining({ mimetype: 'image/webp' }), {
      sendMediaAsSticker: true,
    });
  });

  // The library's own path, with no ffmpeg to run: the failure comes out of the real Client.sendMessage and the real
  // conversion, and the page is never reached, which is what makes the 503 a proof that nothing was sent.
  describe('on the send path of the library with no ffmpeg on the host', () => {
    it('answers the 503 before the page is called', async () => {
      ffmpeg.setFfmpegPath('/nonexistent-fc/ffmpeg');
      const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn() });
      const library = { pupPage };
      const sendMessage = jest.fn((to: string, content: unknown, options: unknown) =>
        Client.prototype.sendMessage.call(library, to, content, options),
      );

      const error = await failureOf(build(sendMessage).sendStickerMessage(PHONE, video()));

      expect(error).toBeInstanceOf(EngineNotSentError);
      expect(pupPage.evaluate).not.toHaveBeenCalled();
      expect(sentNothing(error)).toBe(true);
      expect(countsTowardSendBreaker(error)).toBe(false);
    });
  });
});
