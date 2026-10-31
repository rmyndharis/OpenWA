import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  HttpStatus,
  InternalServerErrorException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { EngineNotReadyError } from '../../../common/errors/engine-not-ready.error';
import { markEngineSendFailure } from '../../../common/errors/engine-send-failure';
import { EngineNotSentError, markNothingSent } from '../../../common/errors/engine-not-sent.error';
import { EngineThrottledError } from '../../../common/errors/engine-throttled.error';
import { EngineTransportError } from '../../../common/errors/engine-transport.error';
import { SendIdempotencyInterceptor, sendFailureProvesNothingSent } from './send-idempotency.interceptor';
import { hashSendRequest, SendIdempotencyService } from './send-idempotency.service';

describe('SendIdempotencyInterceptor', () => {
  let store: jest.Mocked<Pick<SendIdempotencyService, 'claim' | 'complete' | 'release' | 'markFailed'>>;
  let interceptor: SendIdempotencyInterceptor;
  let setHeader: jest.Mock;

  const contextFor = (
    headers: Record<string, string | string[]>,
    body: unknown = { chatId: 'c', text: 't' },
    rawHeaders?: string[],
    sessionId = 's1',
  ) => {
    setHeader = jest.fn();
    return {
      getType: () => 'http',
      getHandler: () => ({ name: 'sendText' }),
      switchToHttp: () => ({
        getRequest: () => ({ headers, params: { sessionId }, body, rawHeaders }),
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    store = {
      claim: jest.fn().mockResolvedValue({ kind: 'claimed', id: 'row-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    interceptor = new SendIdempotencyInterceptor(store as unknown as SendIdempotencyService);
  });

  const run = async (ctx: ExecutionContext, handler: () => unknown) =>
    lastValueFrom(await interceptor.intercept(ctx, { handle: () => handler() as never }));

  it('rejects duplicate raw headers even when Node joins their values', async () => {
    const handler = jest.fn(() => of({}));
    await expect(
      run(contextFor({ 'idempotency-key': 'a, b' }, {}, ['Idempotency-Key', 'a', 'idempotency-key', 'b']), handler),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.claim).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes a request without the header straight through, touching no storage', async () => {
    const out = await run(contextFor({}), () => of({ messageId: 'm1' }));

    expect(out).toEqual({ messageId: 'm1' });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('claims (session, key) with the route and body hash, and stores the response on success', async () => {
    const body = { chatId: 'c', text: 't' };
    const out = await run(contextFor({ 'idempotency-key': 'k-1' }, body), () => of({ messageId: 'm1' }));

    expect(out).toEqual({ messageId: 'm1' });
    expect(store.claim).toHaveBeenCalledWith({
      sessionId: 's1',
      key: 'k-1',
      route: 'sendText',
      requestHash: hashSendRequest('sendText', body),
    });
    expect(store.complete).toHaveBeenCalledWith('row-1', { messageId: 'm1' });
  });

  it('leaves a path segment no session id can be to the handler, claiming nothing', async () => {
    const headers = { 'idempotency-key': 'k-1' };

    const out = await run(contextFor(headers, undefined, undefined, 'x'.repeat(256)), () =>
      of({ answered: 'by handler' }),
    );
    expect(out).toEqual({ answered: 'by handler' });
    expect(store.claim).not.toHaveBeenCalled();

    await run(contextFor(headers, undefined, undefined, 'x'.repeat(255)), () => of({}));
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  it('replays a completed key without running the send, marking the response', async () => {
    store.claim.mockResolvedValue({ kind: 'replay', body: { messageId: 'm1' } });
    const handler = jest.fn(() => of({ messageId: 'NEW' }));

    const out = await run(contextFor({ 'idempotency-key': 'k-1' }), handler);

    expect(out).toEqual({ messageId: 'm1' });
    expect(handler).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith('idempotent-replayed', 'true');
  });

  it.each([
    ['mismatch', UnprocessableEntityException, 'IDEMPOTENCY_KEY_REUSED'],
    ['in_progress', ConflictException, 'IDEMPOTENCY_KEY_IN_PROGRESS'],
    ['outcome_unknown', ConflictException, 'IDEMPOTENCY_OUTCOME_UNKNOWN'],
  ] as const)('answers a %s claim with %p (%s) and never sends', async (kind, Exc, code) => {
    store.claim.mockResolvedValue({ kind });
    const handler = jest.fn(() => of({}));

    const error = await run(contextFor({ 'idempotency-key': 'k-1' }), handler).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Exc);
    expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({ code }));
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([[''], ['has space'], [['a', 'b']]])('refuses a malformed key %p with 400 before claiming', async key => {
    const error = await run(contextFor({ 'idempotency-key': key }), () => of({})).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({ code: 'IDEMPOTENCY_KEY_INVALID' }),
    );
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('frees the key when the send was refused before reaching WhatsApp', async () => {
    const refusal = new EngineNotReadyError();
    await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => throwError(() => refusal))).rejects.toBe(refusal);

    expect(store.release).toHaveBeenCalledWith('row-1');
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('keeps the key taken when the send failed ambiguously', async () => {
    const boom = new Error('Evaluation failed');
    await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => throwError(() => boom))).rejects.toBe(boom);

    expect(store.markFailed).toHaveBeenCalledWith('row-1');
    expect(store.release).not.toHaveBeenCalled();
  });

  it('releases the key when engine transport explicitly reports nothing was sent', async () => {
    const error = markEngineSendFailure(new EngineNotSentError('recipient lookup timed out'));
    await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => throwError(() => error))).rejects.toBe(error);
    expect(store.release).toHaveBeenCalledWith('row-1');
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('releases the key when WhatsApp rate-limited the request before it ran', async () => {
    const error = markEngineSendFailure(new EngineThrottledError('WhatsApp rate-limited the send (code 429)'));
    await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => throwError(() => error))).rejects.toBe(error);
    expect(store.release).toHaveBeenCalledWith('row-1');
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('still answers the send when recording its outcome fails', async () => {
    store.complete.mockRejectedValue(new Error('db down'));

    await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => of({ messageId: 'm1' }))).resolves.toEqual({
      messageId: 'm1',
    });
  });
});

describe('sendFailureProvesNothingSent', () => {
  it.each([new BadRequestException(), new EngineNotReadyError(), new NotImplementedException()])(
    'keeps an engine-stage %p uncertain regardless of HTTP status',
    error => {
      expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(false);
    },
  );

  it.each([
    [new BadRequestException(), true],
    [new ConflictException(), true],
    [new UnprocessableEntityException(), true],
    [new NotImplementedException(), true],
    [new InternalServerErrorException(), false],
    [new ServiceUnavailableException(), false],
    [new Error('timeout'), false],
    ['string', false],
  ])('%p -> %p', (error, expected) => {
    expect(sendFailureProvesNothingSent(error)).toBe(expected);
  });

  // Media the engine could not fetch or read is refused before anything reaches WhatsApp: the proof
  // outranks the engine-stage marker, and the error keeps its own status.
  it.each([new BadRequestException(), new PayloadTooLargeException(), new InternalServerErrorException()])(
    'frees the key for an engine-stage %p raised before anything was sent',
    error => {
      expect(sendFailureProvesNothingSent(markEngineSendFailure(markNothingSent(error)))).toBe(true);
    },
  );

  it('frees the key for a WhatsApp rate limit, which turned the request away, but not for a timeout', () => {
    expect(sendFailureProvesNothingSent(markEngineSendFailure(new EngineThrottledError('rate limited')))).toBe(true);
    expect(sendFailureProvesNothingSent(markEngineSendFailure(new EngineTransportError('timed out')))).toBe(false);
  });

  it('treats 501 as a refusal', () => {
    expect(HttpStatus.NOT_IMPLEMENTED).toBe(501);
  });
});
