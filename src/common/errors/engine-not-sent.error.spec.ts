import {
  EngineNotSentError,
  hasUnknownOutcome,
  markNothingSent,
  markOutcomeUnknown,
  provesNothingSent,
} from './engine-not-sent.error';
import { markEngineSendFailure } from './engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

describe('provesNothingSent and the unknown-outcome mark', () => {
  it('proves nothing was sent for an EngineNotSentError and for an error marked nothing-sent', () => {
    expect(provesNothingSent(new EngineNotSentError('lookup timed out'))).toBe(true);
    expect(provesNothingSent(markNothingSent(new Error('upload refused')))).toBe(true);
    expect(provesNothingSent(new Error('plain'))).toBe(false);
  });

  // A send retried inside the adapter: the first attempt reached the page, the retry then failed before it could
  // send. The class says nothing was sent, the adapter says the message may have gone out; the adapter knows more.
  it('does not prove it for an EngineNotSentError the adapter marked unknown', () => {
    const error = markOutcomeUnknown(new EngineNotSentError('Cannot find ffmpeg'));

    expect(hasUnknownOutcome(error)).toBe(true);
    expect(provesNothingSent(error)).toBe(false);
  });

  it('keeps the Idempotency-Key taken, keeps the admission and does not count the breaker for it', () => {
    const error = markOutcomeUnknown(new EngineNotSentError('Cannot find ffmpeg'));

    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(false);
    expect(sentNothing(error)).toBe(false);
    expect(countsTowardSendBreaker(error)).toBe(false);
  });

  it('still frees the key for an EngineNotSentError nobody marked unknown', () => {
    const error = new EngineNotSentError('lookup timed out');

    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(true);
    expect(sentNothing(error)).toBe(true);
  });
});
