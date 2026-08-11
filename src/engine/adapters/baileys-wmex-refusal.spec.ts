import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysChannels, BaileysChannelsHost } from './baileys-channels';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Channels do not fail like the rest of the adapter. executeWMexQuery reports a server refusal as a
 * GraphQL error INSIDE a successful IQ, so it never passes through assertNodeErrorFree and never
 * carries the numeric `data` that refusedStatusCode reads:
 *
 *   throw new Boom(`GraphQL server error: …`, { statusCode: errorCode, data: firstError })
 *
 * `data` is the error OBJECT. Narrowing refusedStatusCode to numeric-only left these unclassified,
 * so a genuine "you do not own this channel" answered a bare 500 instead of 403.
 */
function channels(sock: Record<string, jest.Mock>, budgetMs: number): BaileysChannels {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
  } as unknown as BaileysChannelsHost;
  return new BaileysChannels(host, budgetMs);
}

/** Exactly what mex.js builds for a GraphQL refusal. */
const wmexRefusal = (code: number) =>
  new Boom('GraphQL server error: not authorized', {
    statusCode: code,
    data: { message: 'not authorized', extensions: { error_code: code } },
  });

describe('channel refusals map to 403, not a bare 500', () => {
  it.each([
    ['deleteChannel', 'newsletterDelete', (c: BaileysChannels) => c.deleteChannel('120363@newsletter')],
    ['muteChannel', 'newsletterMute', (c: BaileysChannels) => c.muteChannel('120363@newsletter', true)],
    ['createChannel', 'newsletterCreate', (c: BaileysChannels) => c.createChannel('N')],
  ])('%s', async (_n, method, call) => {
    const sock = { [method]: jest.fn().mockRejectedValue(wmexRefusal(403)) };
    await expect(call(channels(sock, 500))).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('maps any 4xx the GraphQL payload reports, not only 403', async () => {
    const newsletterDelete = jest.fn().mockRejectedValue(wmexRefusal(404));
    await expect(channels({ newsletterDelete }, 500).deleteChannel('120363@newsletter')).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });
});

describe('what must NOT be classified as a refusal', () => {
  it('a dead socket still propagates rather than becoming a 403', async () => {
    const connectionClosed = new Boom('Connection Closed', { statusCode: 428 });
    const newsletterDelete = jest.fn().mockRejectedValue(connectionClosed);
    await expect(channels({ newsletterDelete }, 500).deleteChannel('120363@newsletter')).rejects.toBe(connectionClosed);
  });

  it('an unanswered query still answers 503, not a 403', async () => {
    const newsletterDelete = jest.fn(() => new Promise<never>(() => undefined));
    await expect(channels({ newsletterDelete }, 15).deleteChannel('120363@newsletter')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('the WMex no-answer shape is not a refusal either — its data is null', async () => {
    // executeWMexQuery's other throw: Boom(..., { statusCode: 400, data: result }) with result
    // undefined, which Boom normalises to null.
    const noAnswer = new Boom('Failed to newsletter metadata, unexpected response structure.', { statusCode: 400 });
    const newsletterDelete = jest.fn().mockRejectedValue(noAnswer);
    await expect(channels({ newsletterDelete }, 500).deleteChannel('120363@newsletter')).rejects.toBe(noAnswer);
  });
});
