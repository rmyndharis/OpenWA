import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineNotSentError, hasUnknownOutcome } from '../../common/errors/engine-not-sent.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

/**
 * A video sticker whose first attempt reached the page ("No LID for user") and whose retry then fails on a host ffmpeg
 * fault. The retry's error is an EngineNotSentError by class, and the adapter marks it unknown because the first attempt
 * may have gone out: every consumer must read the mark, the Idempotency-Key included, or a client repeat sends the
 * sticker a second time.
 */
describe('a video sticker retry that fails on the host after the first attempt reached the page', () => {
  const PHONE = '628123456789@c.us';
  const LID = '159442138038327@lid';
  const found = (id: string): { _serialized: string } => ({ _serialized: id });
  const video = (): { data: string; mimetype: string } => ({
    data: Buffer.from('not a video').toString('base64'),
    mimetype: 'video/mp4',
  });
  const build = (sendMessage: jest.Mock, getNumberId: jest.Mock) => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = { getNumberId, sendMessage };
    return adapter;
  };

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the Idempotency-Key taken, keeps the admission and does not count the breaker', async () => {
    const sendMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('No LID for user'))
      .mockRejectedValueOnce(new Error('Cannot find ffmpeg'));
    const getNumberId = jest.fn().mockResolvedValueOnce(found(PHONE)).mockResolvedValueOnce(found(LID));

    const error = await build(sendMessage, getNumberId)
      .sendStickerMessage(PHONE, video())
      .then(
        () => 'sent',
        (e: unknown) => e,
      );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(EngineNotSentError);
    expect(hasUnknownOutcome(error)).toBe(true);
    expect(sentNothing(error)).toBe(false);
    expect(countsTowardSendBreaker(error)).toBe(false);
    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(false);
  });
});
