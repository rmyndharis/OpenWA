import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysChannels, BaileysChannelsHost } from './baileys-channels';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';

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
    [
      'unsubscribeFromChannel',
      'newsletterUnfollow',
      (c: BaileysChannels) => c.unsubscribeFromChannel('120363@newsletter'),
    ],
  ])('%s', async (_n, method, call) => {
    const sock = { [method]: jest.fn().mockRejectedValue(wmexRefusal(403)) };
    await expect(call(channels(sock, 500))).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('subscribeToChannel: a refused follow', async () => {
    const sock = {
      newsletterMetadata: jest.fn().mockResolvedValue({ id: '120363@newsletter', name: 'N' }),
      newsletterFollow: jest.fn().mockRejectedValue(wmexRefusal(403)),
    };
    await expect(channels(sock, 500).subscribeToChannel('CODE')).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('maps any 4xx the GraphQL payload reports, not only 403', async () => {
    const newsletterDelete = jest.fn().mockRejectedValue(wmexRefusal(404));
    await expect(channels({ newsletterDelete }, 500).deleteChannel('120363@newsletter')).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });
});

describe('a refused channel lookup is "no such channel", not a bare 500', () => {
  it('getChannelById resolves null, which the service answers 404', async () => {
    const newsletterMetadata = jest.fn().mockRejectedValue(wmexRefusal(404));
    await expect(channels({ newsletterMetadata }, 500).getChannelById('120363@newsletter')).resolves.toBeNull();
  });

  it('subscribeToChannel with a refused invite lookup throws ChannelNotFoundError', async () => {
    const sock = { newsletterMetadata: jest.fn().mockRejectedValue(wmexRefusal(404)), newsletterFollow: jest.fn() };
    await expect(channels(sock, 500).subscribeToChannel('BAD')).rejects.toBeInstanceOf(ChannelNotFoundError);
    expect(sock.newsletterFollow).not.toHaveBeenCalled();
  });

  it('a dead socket on the lookup answers 503 and the no-answer shape still propagates, neither as 404', async () => {
    const connectionClosed = new Boom('Connection Closed', { statusCode: 428 });
    const closedLookup = jest.fn().mockRejectedValue(connectionClosed);
    await expect(
      channels({ newsletterMetadata: closedLookup }, 500).getChannelById('120363@newsletter'),
    ).rejects.toBeInstanceOf(EngineTransportError);
    const noAnswer = new Boom('Failed to newsletter metadata, unexpected response structure.', { statusCode: 400 });
    const newsletterMetadata = jest.fn().mockRejectedValue(noAnswer);
    await expect(channels({ newsletterMetadata }, 500).getChannelById('120363@newsletter')).rejects.toBe(noAnswer);
  });

  it("Baileys' own send timeout on the lookup propagates, not as 404", async () => {
    // promiseTimeout (Utils/generics.js) rejects a stalled send with an OBJECT data and a 408 code.
    const timedOut = new Boom('Timed Out', { statusCode: 408, data: { stack: 'Error\n    at x' } });
    const newsletterMetadata = jest.fn().mockRejectedValue(timedOut);
    await expect(channels({ newsletterMetadata }, 500).getChannelById('120363@newsletter')).rejects.toBe(timedOut);
  });

  it('a lookup WhatsApp rate-limits or times out answers 503, not 404 or a bare 500', async () => {
    for (const code of [408, 429]) {
      const newsletterMetadata = jest.fn().mockRejectedValue(wmexRefusal(code));
      await expect(channels({ newsletterMetadata }, 500).getChannelById('120363@newsletter')).rejects.toBeInstanceOf(
        EngineTransportError,
      );
      const sock = { newsletterMetadata, newsletterFollow: jest.fn() };
      await expect(channels(sock, 500).subscribeToChannel('INVITE')).rejects.toBeInstanceOf(EngineTransportError);
      expect(sock.newsletterFollow).not.toHaveBeenCalled();
    }
  });

  it('an unanswered lookup still answers 503', async () => {
    const newsletterMetadata = jest.fn(() => new Promise<never>(() => undefined));
    await expect(channels({ newsletterMetadata }, 15).getChannelById('120363@newsletter')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });
});

describe('what must NOT be classified as a refusal', () => {
  it('a dead socket answers a retryable 503 rather than becoming a 403', async () => {
    const connectionClosed = new Boom('Connection Closed', { statusCode: 428 });
    const newsletterDelete = jest.fn().mockRejectedValue(connectionClosed);
    await expect(channels({ newsletterDelete }, 500).deleteChannel('120363@newsletter')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it("Baileys' own send timeout still propagates rather than becoming a 403", async () => {
    const timedOut = new Boom('Timed Out', { statusCode: 408, data: { stack: 'Error\n    at x' } });
    const newsletterUnfollow = jest.fn().mockRejectedValue(timedOut);
    await expect(channels({ newsletterUnfollow }, 500).unsubscribeFromChannel('120363@newsletter')).rejects.toBe(
      timedOut,
    );
  });

  it('an unanswered query still answers 503, not a 403', async () => {
    const newsletterDelete = jest.fn(() => new Promise<never>(() => undefined));
    await expect(channels({ newsletterDelete }, 15).deleteChannel('120363@newsletter')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('a WhatsApp 408 on channel create stays opaque rather than becoming a retryable 503', async () => {
    // A server timeout does not say whether the channel was created, and a 503 invites a retried POST.
    const timedOut = wmexRefusal(408);
    const newsletterCreate = jest.fn().mockRejectedValue(timedOut);
    const result = channels({ newsletterCreate }, 500).createChannel('N');
    await expect(result).rejects.toBe(timedOut);
    await expect(result).rejects.not.toBeInstanceOf(EngineTransportError);
  });

  it('the WMex no-answer shape is not a refusal either — its data is null', async () => {
    // executeWMexQuery's other throw: Boom(..., { statusCode: 400, data: result }) with result
    // undefined, which Boom normalises to null.
    const noAnswer = new Boom('Failed to newsletter metadata, unexpected response structure.', { statusCode: 400 });
    const newsletterDelete = jest.fn().mockRejectedValue(noAnswer);
    await expect(channels({ newsletterDelete }, 500).deleteChannel('120363@newsletter')).rejects.toBe(noAnswer);
  });
});
