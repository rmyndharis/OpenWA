import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, lastValueFrom, Observable, of } from 'rxjs';
import { createLogger } from '../../../common/services/logger.service';
import { isEngineSendFailure } from '../../../common/errors/engine-send-failure';
import { provesNothingSent } from '../../../common/errors/engine-not-sent.error';
import { EngineThrottledError } from '../../../common/errors/engine-throttled.error';
import { hashSendRequest, isValidIdempotencyKey, SendIdempotencyService } from './send-idempotency.service';

/** Request header a client sets to make a send safe to retry. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Response header set on an answer replayed from an earlier request with the same key. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
/** The most characters of a session id worth a claim: session ids are UUIDs, and the handler refuses a longer segment. */
const CLAIMABLE_SESSION_ID_MAX_LENGTH = 255;

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

/**
 * Opt-in `Idempotency-Key` support for the message send routes.
 *
 * Without the header the request runs exactly as before; nothing is read or written. With it, the
 * key is claimed for (session, key) before the send runs, and:
 * - a retry of a send that succeeded gets the stored response again, marked `Idempotent-Replayed:
 *   true`, and nothing is sent;
 * - a retry while the first request still runs gets 409 `IDEMPOTENCY_KEY_IN_PROGRESS`;
 * - a retry after a failure that may have sent the message gets 409 `IDEMPOTENCY_OUTCOME_UNKNOWN`
 *   (check the chat, then send again with a NEW key if it did not arrive);
 * - the same key with a different route or body gets 422 `IDEMPOTENCY_KEY_REUSED`.
 * A failure that proves nothing was sent frees the key, so a corrected retry may reuse it.
 *
 * Route-scoped (applied with `@UseInterceptors` on each send route) rather than global, so it runs
 * after the guards and after SessionProxyInterceptor: a request forwarded to the owning node is
 * claimed there, once, not on the hop.
 */
@Injectable()
export class SendIdempotencyInterceptor implements NestInterceptor {
  private readonly logger = createLogger('SendIdempotency');

  constructor(private readonly store: SendIdempotencyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (raw === undefined) return next.handle();

    const key = Array.isArray(raw) ? undefined : raw;
    if (key === undefined || !isValidIdempotencyKey(key)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Idempotency-Key must be one value of 1-255 visible ASCII characters.',
        code: 'IDEMPOTENCY_KEY_INVALID',
      });
    }

    const sessionId = String((request.params as Record<string, string | undefined>).sessionId ?? '');
    // Not claimed: the handler answers such a segment itself, where the claim would insert a value
    // PostgreSQL cannot index and answer 500.
    if (sessionId.length > CLAIMABLE_SESSION_ID_MAX_LENGTH) return next.handle();
    const route = context.getHandler().name;
    const claim = await this.store.claim({
      sessionId,
      key,
      route,
      requestHash: hashSendRequest(route, request.body),
    });

    switch (claim.kind) {
      case 'replay':
        context.switchToHttp().getResponse<Response>().setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        return of(claim.body);
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
        return from(this.runClaimed(claim.id, next));
    }
  }

  private async runClaimed(id: string, next: CallHandler): Promise<unknown> {
    let body: unknown;
    try {
      body = await lastValueFrom(next.handle());
    } catch (error) {
      await this.settle(id, sendFailureProvesNothingSent(error) ? 'release' : 'fail');
      throw error;
    }
    await this.settle(id, 'complete', body);
    return body;
  }

  /**
   * Record the outcome. Best-effort: the send already happened (or was refused), and failing the
   * request over bookkeeping would make the client retry a send that went through. A row left
   * 'pending' reads as in-progress, then outcome-unknown, so a retry still cannot double-send.
   */
  private async settle(id: string, outcome: 'complete' | 'release' | 'fail', body?: unknown): Promise<void> {
    try {
      if (outcome === 'complete') await this.store.complete(id, body);
      else if (outcome === 'release') await this.store.release(id);
      else await this.store.markFailed(id);
    } catch (error) {
      this.logger.warn('Could not record the outcome of an idempotent send', {
        claimId: id,
        outcome,
        error: error instanceof Error ? error.message : String(error),
        action: 'send_idempotency_settle_failed',
      });
    }
  }
}
