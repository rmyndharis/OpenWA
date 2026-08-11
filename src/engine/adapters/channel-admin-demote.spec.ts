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
 * Demote a channel admin back to a subscriber — the fifth of the 29.5.3 backlog.
 *
 * **There is no promote counterpart to pair this with, on either library.** Baileys exposes
 * `newsletterDemote`, `newsletterChangeOwner` and `newsletterAdminCount` but no promote, and
 * whatsapp-web.js has no `promoteChannelAdmin` at all. So the demote-only surface is the complete
 * upstream capability rather than a half-wired one: an admin is promoted from the WhatsApp app and
 * can then be demoted through this API.
 *
 * **Only Baileys can actually deliver it.** `Client.demoteChannelAdmin` exists and is typed
 * `Promise<boolean>`, but its page body calls
 * `window.require('WAWebDemoteNewsletterAdminAction').demoteNewsletterAdmin` — an export WhatsApp
 * Web no longer provides. Measured live on Web `2.3000.1044824727-alpha` (unpinned): a `TypeError`
 * reaching the caller as a bare 500, while `muteChannel` answered 200 twice on the same session, so
 * the page and its module registry were healthy. The wwjs adapter therefore answers 501 rather than
 * wiring a call that cannot work — see the matrix note on phantom support.
 *
 * Baileys resolves `void` through `executeWMexQuery`, so a refusal arrives as a Boom on the w:mex
 * channel and a silent socket arrives as nothing at all. Both get the same treatment the other
 * channel writes already have.
 */

const logger = createLogger('channel-admin-demote.spec');
const CHANNEL = '120363000000000000@newsletter';
const USER = '628111222333@c.us';
const never = (): Promise<never> => new Promise<never>(() => undefined);

function wwebjs(client: Record<string, jest.Mock>): WwebjsChannels {
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
  } as unknown as WwebjsEngineHost;
  return new WwebjsChannels(host);
}

/** `toEngineJid` mirrors the real session store: neutral `@c.us` becomes engine `@s.whatsapp.net`. */
function baileys(sock: Record<string, jest.Mock>, budgetMs = 500): BaileysChannels {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    toEngineJid: (jid: string) => jid.replace('@c.us', '@s.whatsapp.net'),
  } as unknown as BaileysChannelsHost;
  return new BaileysChannels(host, budgetMs);
}

describe('WwebjsChannels.demoteChannelAdmin', () => {
  it('answers 501 rather than calling a library method whose page module is gone', async () => {
    const demoteChannelAdmin = jest.fn();
    await expect(wwebjs({ demoteChannelAdmin }).demoteChannelAdmin(CHANNEL, USER)).rejects.toBeInstanceOf(
      EngineNotSupportedError,
    );
  });

  // The load-bearing half: wiring the call would produce a phantom-support row — the matrix claiming
  // the capability while every request failed with a bare 500 (`TypeError: window.require(...)
  // .demoteNewsletterAdmin is not a function`, measured live on Web 2.3000.1044824727-alpha).
  it('does not reach the library at all, so a caller gets a verdict instead of a crash', async () => {
    const demoteChannelAdmin = jest.fn();
    await expect(wwebjs({ demoteChannelAdmin }).demoteChannelAdmin(CHANNEL, USER)).rejects.toThrow();
    expect(demoteChannelAdmin).not.toHaveBeenCalled();
  });
});

describe('BaileysChannels.demoteChannelAdmin', () => {
  // The channel id needs no mapping — `@newsletter` in both dialects — but the USER jid does, which
  // is why this delegate gained a mapper the other channel writes never needed.
  it('maps the user id to the engine dialect and leaves the channel id alone', async () => {
    const newsletterDemote = jest.fn().mockResolvedValue(undefined);
    await expect(baileys({ newsletterDemote }).demoteChannelAdmin(CHANNEL, USER)).resolves.toBeUndefined();
    expect(newsletterDemote).toHaveBeenCalledWith(CHANNEL, '628111222333@s.whatsapp.net');
  });

  // The shape executeWMexQuery really throws: `Boom(msg, { statusCode: errorCode, data: firstError })`
  // where `firstError` is the GraphQL error NODE — an OBJECT. A numeric `data` is the IQ channel's
  // shape and would exercise a different branch of wmexRefusalCode than this path can reach.
  it('maps a w:mex refusal to a refusal', async () => {
    const newsletterDemote = jest.fn().mockRejectedValue(
      new Boom('GraphQL server error: not-authorized', {
        statusCode: 403,
        data: { message: 'not-authorized', error_code: 403 },
      }),
    );
    await expect(baileys({ newsletterDemote }).demoteChannelAdmin(CHANNEL, USER)).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('reports an unanswered query instead of a bare 500', async () => {
    await expect(
      baileys({ newsletterDemote: jest.fn(never) }, 15).demoteChannelAdmin(CHANNEL, USER),
    ).rejects.toBeInstanceOf(EngineTransportError);
  });
});
