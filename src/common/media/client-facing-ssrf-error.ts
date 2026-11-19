import { BadRequestException } from '@nestjs/common';
import { markNothingSent } from '../errors/engine-not-sent.error';
import { SSRF_BLOCKED_CLIENT_MESSAGE, SsrfBlockedError } from '../security/ssrf-guard';
import { createLogger } from '../services/logger.service';

const logger = createLogger('RemoteMedia');

/**
 * The guard's own account of a refusal (the resolved address, an unresolvable name, a refused redirect), which is for
 * the server log only: it names internal topology, and a redirect carries the caller's URL.
 */
export function logSsrfRefusal(error: SsrfBlockedError): void {
  logger.warn(`Outbound media fetch blocked by SSRF guard: ${error.message}`);
}

/**
 * What a route throws when the SSRF guard refuses a media URL the caller supplied (a blocked or unresolvable address,
 * or any redirect): the caller's input, so a 400 that proves nothing was sent. A keyed send frees its Idempotency-Key
 * for it, and a bulk item or a product send hands its pacing admission back (a single send keeps its FAILED row, which
 * counts), as for any other unfetchable URL. The guard's own message names the resolved internal address, a recon and
 * DNS-rebind oracle, so the client gets a generic text and the detail stays in the log. Any other error is returned
 * unchanged.
 *
 * `loadRemoteMediaBuffer` keeps throwing `SsrfBlockedError` itself: bulk results, the send pacing and the
 * `message:failed` hook test for that class. Every route that hands a caller's media URL to it maps the error here,
 * and a bulk item, which stores and returns only the generic text, logs the detail with `logSsrfRefusal`.
 */
export function clientFacingSsrfError(error: unknown): unknown {
  if (!(error instanceof SsrfBlockedError)) return error;
  logSsrfRefusal(error);
  return markNothingSent(new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE));
}
