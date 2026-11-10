import { ConflictException, HttpException, HttpStatus, UnprocessableEntityException } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import { isEngineSendFailure } from '../../../common/errors/engine-send-failure';
import { provesNothingSent } from '../../../common/errors/engine-not-sent.error';
import { EngineThrottledError } from '../../../common/errors/engine-throttled.error';
import { hashSendRequest, SendIdempotencyService } from './send-idempotency.service';

const logger = createLogger('SendIdempotency');

/** The most characters of a session id worth a claim: session ids are UUIDs, and the handler refuses a longer segment. */
export const CLAIMABLE_SESSION_ID_MAX_LENGTH = 255;

/**
 * Whether a failed send proves nothing reached WhatsApp, so the key can be freed for a retry.
 *
 * A 4xx or 501 before the engine call is a refusal. Errors escaping the shared engine-send failure
 * boundary stay uncertain unless the engine proves nothing was handed to WhatsApp (EngineNotSentError, media
 * it could not fetch or read, or a not-ready refusal before the hand-over; see markNothingSent), or WhatsApp itself
 * turned the request away with a rate limit (EngineThrottledError): a socket can report 409 after WhatsApp
 * accepted the message. Other server errors/timeouts also keep the key taken.
 */
export function sendFailureProvesNothingSent(error: unknown): boolean {
  if (provesNothingSent(error) || error instanceof EngineThrottledError) return true;
  if (isEngineSendFailure(error) || !(error instanceof HttpException)) return false;
  const status: number = error.getStatus();
  const notImplemented: number = HttpStatus.NOT_IMPLEMENTED;
  return status < 500 || status === notImplemented;
}

/** One send to run under a key: the session, the key, the route that names the operation and its arguments. */
export interface IdempotentSend {
  sessionId: string;
  key: string;
  route: string;
  body: unknown;
}

export type IdempotentSendClaim =
  /** The session id is no session id, so no claim was made and the send is left to answer it. */
  | { kind: 'unclaimed' }
  /** The key already completed this exact request: answer with the stored body and send nothing. */
  | { kind: 'replay'; body: unknown }
  /** This request owns the key and must run the send through runClaimedSend. */
  | { kind: 'claimed'; id: string };

/**
 * Claim (session, key) for one send. Throws the refusals a retry meets: 422 for a key bound to a different
 * request, 409 while the first request still runs or after a failure that may have sent the message.
 * Not claimed: a session id longer than any session's, which the send itself answers, where the claim would
 * insert a value PostgreSQL cannot index and answer 500.
 */
export async function claimIdempotentSend(
  store: SendIdempotencyService,
  { sessionId, key, route, body }: IdempotentSend,
): Promise<IdempotentSendClaim> {
  if (sessionId.length > CLAIMABLE_SESSION_ID_MAX_LENGTH) return { kind: 'unclaimed' };
  const claim = await store.claim({ sessionId, key, route, requestHash: hashSendRequest(route, body) });
  switch (claim.kind) {
    case 'replay':
      return { kind: 'replay', body: claim.body };
    case 'mismatch':
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'This Idempotency-Key was already used for a different request. Use a new key.',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    case 'in_progress':
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'A request with this Idempotency-Key is still running. Retry after it finishes.',
        code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      });
    case 'outcome_unknown':
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          'An earlier request with this Idempotency-Key failed and the message may have been sent. ' +
          'Check the chat; to send again, use a new key.',
        code: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
      });
    case 'claimed':
      return { kind: 'claimed', id: claim.id };
  }
}

/** Run the send a claim owns and record how it ended: stored for replay, freed for a retry, or kept taken. */
export async function runClaimedSend(
  store: SendIdempotencyService,
  id: string,
  send: () => Promise<unknown>,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await send();
  } catch (error) {
    await settle(store, id, sendFailureProvesNothingSent(error) ? 'release' : 'fail');
    throw error;
  }
  await settle(store, id, 'complete', body);
  return body;
}

/**
 * Run one send under a key. A retry of a send that succeeded gets the stored answer (`replayed`) and nothing
 * is sent; the refusals of claimIdempotentSend apply. The HTTP route lets Nest's interceptor chain drive the
 * two halves itself; an agent tool, which has no chain, calls this.
 */
export async function runIdempotentSend(
  store: SendIdempotencyService,
  request: IdempotentSend,
  send: () => Promise<unknown>,
): Promise<{ replayed: boolean; body: unknown }> {
  const claim = await claimIdempotentSend(store, request);
  if (claim.kind === 'replay') return { replayed: true, body: claim.body };
  if (claim.kind === 'unclaimed') return { replayed: false, body: await send() };
  return { replayed: false, body: await runClaimedSend(store, claim.id, send) };
}

/**
 * Record the outcome. Best-effort: the send already happened (or was refused), and failing the
 * request over bookkeeping would make the client retry a send that went through. A row left
 * 'pending' reads as in-progress, then outcome-unknown, so a retry still cannot double-send.
 */
async function settle(
  store: SendIdempotencyService,
  id: string,
  outcome: 'complete' | 'release' | 'fail',
  body?: unknown,
): Promise<void> {
  try {
    if (outcome === 'complete') await store.complete(id, body);
    else if (outcome === 'release') await store.release(id);
    else await store.markFailed(id);
  } catch (error) {
    logger.warn('Could not record the outcome of an idempotent send', {
      claimId: id,
      outcome,
      error: error instanceof Error ? error.message : String(error),
      action: 'send_idempotency_settle_failed',
    });
  }
}
