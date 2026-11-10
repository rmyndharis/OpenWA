import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, lastValueFrom, Observable, of } from 'rxjs';
import { claimIdempotentSend, runClaimedSend } from './run-idempotent-send';
import { isValidIdempotencyKey, SendIdempotencyService } from './send-idempotency.service';

export { sendFailureProvesNothingSent } from './run-idempotent-send';

/** Request header a client sets to make a send safe to retry. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Response header set on an answer replayed from an earlier request with the same key. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

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
    const claim = await claimIdempotentSend(this.store, {
      sessionId,
      key,
      route: context.getHandler().name,
      body: request.body,
    });

    switch (claim.kind) {
      case 'unclaimed':
        return next.handle();
      case 'replay':
        context.switchToHttp().getResponse<Response>().setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        return of(claim.body);
      case 'claimed':
        return from(runClaimedSend(this.store, claim.id, () => lastValueFrom(next.handle())));
    }
  }
}
