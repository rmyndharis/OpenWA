import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import type { WASocket } from '@whiskeysockets/baileys';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { hasUnknownOutcome, provesNothingSent } from '../../common/errors/engine-not-sent.error';
import { EngineNotSentError } from '../../common/errors/engine-not-sent.error';

/**
 * A status post whose connection was replaced or stopped while the socket was writing it. The chat send answers the
 * not-ready 409 that says the message may or may not have been sent for the same window; the post says the same,
 * since the frame may already be on the wire, unless the failure proves the write was never reached.
 */
describe('BaileysStatus post cut off by a replaced connection', () => {
  const make = (failure: Error): BaileysStatus => {
    let live = true;
    const socket = {
      sendMessage: jest.fn(() => {
        live = false; // the connection is torn down while the write is in flight
        return Promise.reject(failure);
      }),
    } as unknown as WASocket;
    const host = {
      sessionProxyUrl: () => undefined,
      ensureReady: () => undefined,
      getSocket: () => socket,
      getSocketOrNull: () => (live ? socket : null),
      toEngineJid: (jid: string) => jid,
      normalizedSelfJid: () => '628999@s.whatsapp.net',
      toUnixSeconds: () => 1700000000,
      rememberOwnSend: () => undefined,
    } as unknown as BaileysStatusHost;
    return new BaileysStatus(host);
  };
  const post = (failure: Error): Promise<unknown> =>
    make(failure)
      .postTextStatus('hello', { recipients: ['628111@s.whatsapp.net'] })
      .catch((caught: unknown) => caught);

  it('answers the not-ready 409 that says the post may or may not have been published', async () => {
    const error = await post(new Error('Connection Closed'));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect((error as Error).message).toMatch(/may or may not have been published/);
    expect(hasUnknownOutcome(error)).toBe(true);
  });

  it('answers the plain not-ready 409 when the failure proves the write was never reached', async () => {
    const error = await post(new EngineNotSentError('upload refused'));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(hasUnknownOutcome(error)).toBe(false);
    expect(provesNothingSent(error)).toBe(true);
  });

  it('says a revoke cut off the same way may or may not have been removed, not that a post was published', async () => {
    const status = make(new Error('Connection Closed'));
    const audiences = (status as unknown as { audiences: Map<string, { jids: string[]; expiresAt: number }> })
      .audiences;
    audiences.set('S1', { jids: ['628111@s.whatsapp.net'], expiresAt: Date.now() + 60_000 });

    const error = await status.deleteStatus('S1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect((error as Error).message).toMatch(
      /while the status was being revoked, and it may or may not have been removed/,
    );
    expect((error as Error).message).not.toMatch(/posted|published/);
    expect(hasUnknownOutcome(error)).toBe(true);
  });
});
