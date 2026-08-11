import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysChannels, BaileysChannelsHost } from './baileys-channels';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

/**
 * Every channel operation goes through Baileys' `executeWMexQuery`, which on an unanswered query
 * falls past its `if (child?.content)` guard and throws
 * `Boom('Failed to …, unexpected response structure.', { statusCode: 400, data: result })` with
 * result undefined — so `data` is null, `refusedStatusCode` cannot place it, and the raw Boom
 * escapes as a bare 500.
 *
 * `newsletterCreate` is deliberately left unbounded, for the same reason as `groupCreate`: it is
 * non-idempotent, and 503 is a status the Go SDK retries for POST.
 */

const never = (): Promise<never> => new Promise<never>(() => undefined);
/** What executeWMexQuery throws when nothing came back. */
const noAnswer = () => new Boom('Failed to newsletter metadata, unexpected response structure.', { statusCode: 400 });

function channels(sock: Record<string, jest.Mock>, budgetMs: number): BaileysChannels {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    toEngineJid: (jid: string) => jid,
  } as unknown as BaileysChannelsHost;
  return new BaileysChannels(host, budgetMs);
}

const META = { id: '120363000000000000@newsletter', name: 'Release notes' };

describe('channel operations report an unanswered query instead of a bare 500', () => {
  it.each([
    ['getChannelById', 'newsletterMetadata', (c: BaileysChannels) => c.getChannelById('120363@newsletter')],
    ['subscribeToChannel', 'newsletterMetadata', (c: BaileysChannels) => c.subscribeToChannel('CODE')],
    ['deleteChannel', 'newsletterDelete', (c: BaileysChannels) => c.deleteChannel('120363@newsletter')],
    ['muteChannel', 'newsletterMute', (c: BaileysChannels) => c.muteChannel('120363@newsletter', true)],
    ['unmuteChannel', 'newsletterUnmute', (c: BaileysChannels) => c.muteChannel('120363@newsletter', false)],
    ['unsubscribeFromChannel', 'newsletterUnfollow', (c: BaileysChannels) => c.unsubscribeFromChannel('120363@n')],
    [
      'demoteChannelAdmin',
      'newsletterDemote',
      (c: BaileysChannels) => c.demoteChannelAdmin('120363@n', '628@s.whatsapp.net'),
    ],
  ])('%s', async (_name, sockMethod, call) => {
    await expect(call(channels({ [sockMethod]: jest.fn(never) }, 15))).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('subscribeToChannel is bounded on the follow too, not only the metadata read', async () => {
    const sock = {
      newsletterMetadata: jest.fn().mockResolvedValue(META),
      newsletterFollow: jest.fn(never),
    };
    await expect(channels(sock, 15).subscribeToChannel('CODE')).rejects.toBeInstanceOf(EngineTransportError);
    expect(sock.newsletterMetadata).toHaveBeenCalled();
  });
});

describe('channel operations that must not change', () => {
  it('createChannel maps a WA refusal to a refusal', async () => {
    const newsletterCreate = jest.fn().mockRejectedValue(new Boom('not-authorized', { data: 403 }));
    await expect(channels({ newsletterCreate }, 500).createChannel('N')).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('createChannel lets an unanswered query propagate — deliberately NOT a 503', async () => {
    // Non-idempotent: 503 is retried for POST by the Go SDK, which would risk duplicate channels.
    const err = noAnswer();
    const newsletterCreate = jest.fn().mockRejectedValue(err);
    await expect(channels({ newsletterCreate }, 500).createChannel('N')).rejects.toBe(err);
  });

  it('still returns the channel when WhatsApp answers inside the budget', async () => {
    const newsletterMetadata = jest.fn().mockResolvedValue(META);
    await expect(channels({ newsletterMetadata }, 500).getChannelById('120363@newsletter')).resolves.toMatchObject({
      id: '120363000000000000@newsletter',
    });
  });
});
