import { BadRequestException } from '@nestjs/common';
import { clientFacingSsrfError } from './client-facing-ssrf-error';
import { provesNothingSent } from '../errors/engine-not-sent.error';
import { LoggerService } from '../services/logger.service';
import { SSRF_BLOCKED_CLIENT_MESSAGE, SsrfBlockedError } from '../security/ssrf-guard';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/run-idempotent-send';

describe('clientFacingSsrfError', () => {
  const detail = 'Host files.example resolves to a blocked internal address: 169.254.169.254';
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('answers a refused media URL with a generic 400 that never names the address', () => {
    const mapped = clientFacingSsrfError(new SsrfBlockedError(detail));

    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as BadRequestException).getStatus()).toBe(400);
    expect((mapped as BadRequestException).message).toBe(SSRF_BLOCKED_CLIENT_MESSAGE);
    expect(JSON.stringify((mapped as BadRequestException).getResponse())).not.toContain('169.254.169.254');
  });

  it('keeps the guard detail in the log', () => {
    clientFacingSsrfError(new SsrfBlockedError(detail));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(detail));
  });

  it('proves nothing was sent, so a keyed send frees its key and a paced one its admission', () => {
    const mapped = clientFacingSsrfError(new SsrfBlockedError(detail));

    expect(provesNothingSent(mapped)).toBe(true);
    expect(sendFailureProvesNothingSent(mapped)).toBe(true);
    expect(sentNothing(mapped)).toBe(true);
    expect(countsTowardSendBreaker(mapped)).toBe(false);
  });

  it.each([
    ['an engine error', new Error('socket closed')],
    ['an HTTP error of its own', new BadRequestException('Media fetch failed')],
    ['a value that is no error', 'not an error'],
    ['nothing', undefined],
  ])('returns %s unchanged', (_label, other) => {
    expect(clientFacingSsrfError(other)).toBe(other);
    expect(warn).not.toHaveBeenCalled();
  });
});
