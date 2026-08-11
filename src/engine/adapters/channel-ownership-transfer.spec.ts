import { Boom } from '@hapi/boom';
import type { Client } from 'whatsapp-web.js';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysChannels, type BaileysChannelsHost } from './baileys-channels';
import { WwebjsChannels } from './wwebjs-channels';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Hand a channel to a new owner — the last of the 29.5.3 backlog, and the only irreversible one.
 * Once it lands the account is no longer the owner and cannot take the channel back.
 *
 * **Only Baileys can deliver it.** `Client.transferChannelOwnership` exists and its page function is
 * present, but on Web `2.3000.1044824727-alpha` it rejects every call LOCALLY with
 * `contact-not-found-in-newsletter-subscriber-list` — 4-9ms against a 352-531ms known-server
 * baseline taken in the same page, so it never asks WhatsApp. Subscribing the target, promoting it
 * to admin, and restarting the session all left it unchanged, and the only list-repopulation path
 * (`NewsletterMetadataCollection.update`) is `undefined` in this Web version. The library discards
 * that reason into a bare `false`, so the wwjs adapter answers 501 instead of claiming support.
 *
 * **`shouldDismissSelfAsAdmin` is deliberately not exposed.** That branch calls
 * `window.require('WAWebContactCollection').getMeContact()`, and a module probe against a live
 * session on Web `2.3000.1044824727-alpha` returned `getMeContact: undefined`. Since the branch sits
 * inside the same swallowing try, passing the option would throw, be caught, and surface as a plain
 * `false` — a silent failure dressed as a refusal. Not offering it beats offering one that lies.
 *
 * Baileys resolves `void` through `executeWMexQuery`, so a refusal is a Boom on the w:mex channel.
 * Unlike `createChannel` this call IS bounded: a retry after a transfer that actually succeeded is
 * refused (the account no longer owns the channel), whereas a retried create leaves a duplicate
 * channel behind — so the argument that keeps `createChannel` unbounded does not apply here, and a
 * `503` saying "may or may not have applied" beats a request that hangs.
 */

const logger = createLogger('channel-ownership-transfer.spec');
const CHANNEL = '120363000000000000@newsletter';
const NEW_OWNER = '628111222333@c.us';
const never = (): Promise<never> => new Promise<never>(() => undefined);

function wwebjs(client: Record<string, jest.Mock>): WwebjsChannels {
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
  } as unknown as WwebjsEngineHost;
  return new WwebjsChannels(host);
}

function baileys(sock: Record<string, jest.Mock>, budgetMs = 500): BaileysChannels {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    toEngineJid: (jid: string) => jid.replace('@c.us', '@s.whatsapp.net'),
  } as unknown as BaileysChannelsHost;
  return new BaileysChannels(host, budgetMs);
}

describe('WwebjsChannels.transferChannelOwnership', () => {
  it('answers 501 rather than calling a library method the page refuses locally', async () => {
    const transferChannelOwnership = jest.fn();
    await expect(
      wwebjs({ transferChannelOwnership }).transferChannelOwnership(CHANNEL, NEW_OWNER),
    ).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  // Wiring it would be a phantom-support row. The page rejects every call in 4-9ms with
  // `contact-not-found-in-newsletter-subscriber-list` — measured against a 352-531ms known-server
  // baseline in the same page, so it never reaches WhatsApp — and the library then discards that
  // reason into a bare `false`.
  it('does not reach the library at all, so a caller gets a verdict instead of a silent false', async () => {
    const transferChannelOwnership = jest.fn();
    await expect(wwebjs({ transferChannelOwnership }).transferChannelOwnership(CHANNEL, NEW_OWNER)).rejects.toThrow();
    expect(transferChannelOwnership).not.toHaveBeenCalled();
  });
});

describe('BaileysChannels.transferChannelOwnership', () => {
  it('maps the new owner to the engine dialect and leaves the channel id alone', async () => {
    const newsletterChangeOwner = jest.fn().mockResolvedValue(undefined);
    await expect(
      baileys({ newsletterChangeOwner }).transferChannelOwnership(CHANNEL, NEW_OWNER),
    ).resolves.toBeUndefined();
    expect(newsletterChangeOwner).toHaveBeenCalledWith(CHANNEL, '628111222333@s.whatsapp.net');
  });

  // executeWMexQuery throws `Boom(msg, { statusCode: errorCode, data: firstError })` with the GraphQL
  // error NODE as `data` — an object. A numeric `data` is the IQ channel's shape and would exercise a
  // branch of wmexRefusalCode this path cannot reach.
  it('maps a w:mex refusal to a refusal', async () => {
    const newsletterChangeOwner = jest.fn().mockRejectedValue(
      new Boom('GraphQL server error: not-authorized', {
        statusCode: 403,
        data: { message: 'not-authorized', error_code: 403 },
      }),
    );
    await expect(
      baileys({ newsletterChangeOwner }).transferChannelOwnership(CHANNEL, NEW_OWNER),
    ).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('reports an unanswered query instead of a bare 500', async () => {
    await expect(
      baileys({ newsletterChangeOwner: jest.fn(never) }, 15).transferChannelOwnership(CHANNEL, NEW_OWNER),
    ).rejects.toBeInstanceOf(EngineTransportError);
  });
});
