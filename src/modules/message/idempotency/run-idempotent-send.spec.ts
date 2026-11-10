import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LoggerService } from '../../../common/services/logger.service';
import {
  CLAIMABLE_SESSION_ID_MAX_LENGTH,
  claimIdempotentSend,
  runClaimedSend,
  runIdempotentSend,
} from './run-idempotent-send';
import { hashSendRequest, SendIdempotencyService } from './send-idempotency.service';

// The interceptor spec covers these paths through the HTTP seam. This one pins them for the agent tools, which
// have no interceptor chain and call runIdempotentSend directly.
describe('runIdempotentSend', () => {
  let store: jest.Mocked<Pick<SendIdempotencyService, 'claim' | 'complete' | 'release' | 'markFailed'>>;
  const request = { sessionId: 's1', key: 'k1', route: 'mcp:MessageSendText', body: { chatId: 'c', text: 't' } };
  const asStore = () => store as unknown as SendIdempotencyService;

  beforeEach(() => {
    store = {
      claim: jest.fn().mockResolvedValue({ kind: 'claimed', id: 'row-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('claims (session, key) with the route and the hash of the arguments, runs the send once and stores its answer', async () => {
    const send = jest.fn().mockResolvedValue({ messageId: 'm1' });

    await expect(runIdempotentSend(asStore(), request, send)).resolves.toEqual({
      replayed: false,
      body: { messageId: 'm1' },
    });

    expect(store.claim).toHaveBeenCalledWith({
      sessionId: 's1',
      key: 'k1',
      route: 'mcp:MessageSendText',
      requestHash: hashSendRequest('mcp:MessageSendText', request.body),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith('row-1', { messageId: 'm1' });
  });

  it('replays a completed key without running the send', async () => {
    store.claim.mockResolvedValue({ kind: 'replay', body: { messageId: 'm1' } });
    const send = jest.fn();

    await expect(runIdempotentSend(asStore(), request, send)).resolves.toEqual({
      replayed: true,
      body: { messageId: 'm1' },
    });

    expect(send).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['mismatch', UnprocessableEntityException, 'IDEMPOTENCY_KEY_REUSED'],
    ['in_progress', ConflictException, 'IDEMPOTENCY_KEY_IN_PROGRESS'],
    ['outcome_unknown', ConflictException, 'IDEMPOTENCY_OUTCOME_UNKNOWN'],
  ] as const)('refuses a %s claim with its code and runs nothing', async (kind, exception, code) => {
    store.claim.mockResolvedValue({ kind });
    const send = jest.fn();

    const error: unknown = await runIdempotentSend(asStore(), request, send).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(exception);
    expect((error as { getResponse(): { code: string } }).getResponse().code).toBe(code);
    expect(send).not.toHaveBeenCalled();
  });

  it('frees the key when the send was refused before it reached WhatsApp, and rethrows', async () => {
    const refusal = new BadRequestException('Session is not started');

    await expect(runIdempotentSend(asStore(), request, jest.fn().mockRejectedValue(refusal))).rejects.toBe(refusal);

    expect(store.release).toHaveBeenCalledWith('row-1');
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('keeps the key taken when the send failed without saying whether it went out, and rethrows', async () => {
    const unknown = new InternalServerErrorException('socket closed');

    await expect(runIdempotentSend(asStore(), request, jest.fn().mockRejectedValue(unknown))).rejects.toBe(unknown);

    expect(store.markFailed).toHaveBeenCalledWith('row-1');
    expect(store.release).not.toHaveBeenCalled();
  });

  it('leaves a session id no session can have to the send, claiming nothing', async () => {
    const send = jest.fn().mockResolvedValue({ messageId: 'm1' });
    const sessionId = 's'.repeat(CLAIMABLE_SESSION_ID_MAX_LENGTH + 1);

    await expect(runIdempotentSend(asStore(), { ...request, sessionId }, send)).resolves.toEqual({
      replayed: false,
      body: { messageId: 'm1' },
    });

    expect(store.claim).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('still answers the send when recording its outcome fails', async () => {
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    store.complete.mockRejectedValue(new Error('database is locked'));

    try {
      await expect(
        runIdempotentSend(asStore(), request, jest.fn().mockResolvedValue({ messageId: 'm1' })),
      ).resolves.toEqual({ replayed: false, body: { messageId: 'm1' } });
      expect(warn).toHaveBeenCalledWith(
        'Could not record the outcome of an idempotent send',
        expect.objectContaining({ claimId: 'row-1', outcome: 'complete' }) as unknown,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('claimIdempotentSend and runClaimedSend', () => {
  it('hand a claim to the caller that drives the send itself, as the interceptor does', async () => {
    const complete = jest.fn().mockResolvedValue(undefined);
    const store = {
      claim: jest.fn().mockResolvedValue({ kind: 'claimed', id: 'row-9' }),
      complete,
      release: jest.fn(),
      markFailed: jest.fn(),
    } as unknown as SendIdempotencyService;

    const claim = await claimIdempotentSend(store, { sessionId: 's1', key: 'k1', route: 'sendText', body: {} });
    expect(claim).toEqual({ kind: 'claimed', id: 'row-9' });

    await expect(runClaimedSend(store, 'row-9', () => Promise.resolve('sent'))).resolves.toBe('sent');
    expect(complete).toHaveBeenCalledWith('row-9', 'sent');
  });
});
