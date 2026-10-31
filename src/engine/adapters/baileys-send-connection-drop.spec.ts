import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { BaileysStatus } from './baileys-status';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';

/**
 * A send in flight when the WhatsApp connection drops. The lifecycle keeps the dropped socket as `sock`
 * through the reconnect backoff (it drops the status to INITIALIZING and waits up to a minute before it
 * opens the next one), so the send's own socket is still the one in place when its failure arrives.
 *
 * Baileys writes the message stanza last: every query a send awaits (devices, sessions, group roster)
 * comes before it, and nothing after it is awaited. A failure of the closed connection therefore means
 * the stanza was never written: `sendRawMessage` refuses a socket that is not open with
 * `Boom('Connection Closed', 428)`, and a query cut off by the close rejects with that Boom or with the
 * bare close code the WebSocket emitted (Socket/socket.js, sendRawMessage and waitForMessage).
 */
describe('Baileys send on a connection that closed before the message was written', () => {
  function messaging(failure: unknown) {
    const sock = {
      ws: { isOpen: false },
      sendMessage: jest.fn().mockRejectedValue(failure),
    } as unknown as WASocket;
    const host = {
      sessionProxyUrl: () => undefined,
      ensureReady: () => undefined,
      getSocket: () => sock,
      // Still the dropped socket: the reconnect has not opened the next one yet.
      getSocketOrNull: () => sock,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (jid: string) => jid,
      toEngineJid: (jid: string) => jid,
      normalizedSelfJid: () => '628999@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: (ts: unknown) => Number(ts ?? 0),
      loadLib: () => Promise.reject(new Error('the library is not needed before the send')),
      putStoredMessage: () => undefined,
      recordMessage: jest.fn(),
      recordMessageEdit: jest.fn(),
      rememberOwnSend: jest.fn(),
      getStoredMessage: () => undefined,
      updateStoredMessage: () => undefined,
      wasDeletedForEveryone: () => false,
      markDeletedForEveryone: jest.fn(),
      pendingEditOf: () => undefined,
      recordLidMapping: jest.fn(),
      getOnMessageCreate: () => undefined,
      mapMessage: jest.fn(),
    } as unknown as BaileysMessagingHost;
    return { delegate: new BaileysMessaging(host), sock };
  }

  it.each([
    ['the closed-socket refusal', new Boom('Connection Closed', { statusCode: 428 })],
    ['the WebSocket close code a pending query rejects with', 1006],
  ])('reports %s as a send that handed nothing to WhatsApp', async (_label, failure) => {
    const { delegate, sock } = messaging(failure);

    const error: unknown = await delegate.sendTextMessage('207948726362210@lid', 'hello').then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    // The idempotency key is freed and the pacing admission handed back only for a send that provably
    // sent nothing, and a dropped connection is not the account standing the send breaker measures.
    expect(sendFailureProvesNothingSent(error)).toBe(true);
    expect(sentNothing(error)).toBe(true);
    expect(countsTowardSendBreaker(error)).toBe(false);
  });

  // A write the socket itself failed, or one that timed out, may have left: those keep an unknown outcome.
  it.each([
    ['a write the WebSocket failed', new Error('WebSocket is not open: readyState 2 (CLOSING)')],
    ['a write that timed out', new Boom('Timed Out', { statusCode: 408, data: { stack: 'at sendRawMessage' } })],
    ['a plain error that only names the closed connection', new Error('Connection Closed')],
  ])('leaves %s with its unknown outcome', async (_label, failure) => {
    const { delegate } = messaging(failure);

    const error: unknown = await delegate.sendTextMessage('207948726362210@lid', 'hello').then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBe(failure);
    expect(sendFailureProvesNothingSent(error)).toBe(false);
  });

  it('reports a status post cut off by the closed connection as one that posted nothing', async () => {
    const sock = {
      sendMessage: jest.fn().mockRejectedValue(new Boom('Connection Closed', { statusCode: 428 })),
    } as unknown as WASocket;
    const status = new BaileysStatus({
      sessionProxyUrl: () => undefined,
      ensureReady: () => undefined,
      getSocket: () => sock,
      getSocketOrNull: () => sock,
      toEngineJid: (jid: string) => jid,
      normalizedSelfJid: () => '628999@s.whatsapp.net',
      toUnixSeconds: (ts: unknown) => Number(ts ?? 0),
      rememberOwnSend: jest.fn(),
    });

    const error: unknown = await status.postTextStatus('hello', { recipients: ['628111@c.us'] }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(sentNothing(error)).toBe(true);
    expect(countsTowardSendBreaker(error)).toBe(false);
  });
});
