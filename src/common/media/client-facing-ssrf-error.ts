import { BadRequestException } from '@nestjs/common';
import { markNothingSent } from '../errors/engine-not-sent.error';
import { SSRF_BLOCKED_CLIENT_MESSAGE, SsrfBlockedError } from '../security/ssrf-guard';
import { createLogger } from '../services/logger.service';

const logger = createLogger('RemoteMedia');

/**
 * What a route throws when the SSRF guard refuses a media URL the caller supplied (a blocked or unresolvable address,
 * or any redirect): the caller's input, so a 400 that proves nothing was sent. A keyed send frees its Idempotency-Key
 * for it and a paced one gives its admission back, as for any other unfetchable URL. The guard's own message names
 * the resolved internal address, a recon and DNS-rebind oracle, so the client gets a generic text and the detail
 * stays in the log. Any other error is returned unchanged.
 *
 * `loadRemoteMediaBuffer` keeps throwing `SsrfBlockedError` itself: bulk results, the send pacing and the
 * `message:failed` hook test for that class. Every route that hands a caller's media URL to it maps the error here.
 */
export function clientFacingSsrfError(error: unknown): unknown {
  if (!(error instanceof SsrfBlockedError)) return error;
  logger.warn(`Outbound media fetch blocked by SSRF guard: ${error.message}`);
  return markNothingSent(new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE));
}
