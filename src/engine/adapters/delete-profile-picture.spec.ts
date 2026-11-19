import type { WASocket } from '@whiskeysockets/baileys';
import type { Client } from 'whatsapp-web.js';
import { BaileysContacts, type BaileysContactsHost } from './baileys-contacts';
import { WwebjsProfile } from './wwebjs-profile';
import { deleteGroupPictureInPage } from './wwebjs-groups';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Delete the account's OWN profile picture, the fourth of the §29.5.3 backlog.
 *
 * whatsapp-web.js sends the request in the page, as the removal of a group's picture does, and answers by the status
 * WhatsApp gave (wwebjs-profile-picture-delete.spec.ts runs the page job against the library's own page code). The
 * library's `Client.deleteProfilePicture(): Promise<boolean>` reads every status as `false`, which left a rate limit or
 * a server error reading as a refusal, and asks WhatsApp only when the page's own copy of the picture allows it.
 *
 * Baileys resolves `void` and has no refusal signal at all, so it reports success whenever the
 * write is acknowledged. Its `removeProfilePicture` takes a JID and is already wired for
 * `deleteGroupPicture`; the own-account call is the same symbol with the self JID, which is why
 * an unknown self JID has to fail loudly rather than silently target nothing.
 */

const logger = createLogger('delete-profile-picture.spec');

describe('WwebjsProfile.deleteProfilePicture', () => {
  const OWN = '628000000001@c.us';

  /** A client whose page answers the delete with `answer`. */
  function clientAnswering(answer: number | 'missing') {
    return { info: { wid: { _serialized: OWN } }, pupPage: { evaluate: jest.fn().mockResolvedValue(answer) } };
  }

  function makeProfile(client: unknown): WwebjsProfile {
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as Client,
      logger,
    } as unknown as WwebjsEngineHost;
    return new WwebjsProfile(host);
  }

  it('a confirmed delete resolves, and the page job is asked for the account itself', async () => {
    const client = clientAnswering(200);
    await expect(makeProfile(client).deleteProfilePicture()).resolves.toBeUndefined();
    expect(client.pupPage.evaluate).toHaveBeenCalledTimes(1);
    expect(client.pupPage.evaluate).toHaveBeenCalledWith(deleteGroupPictureInPage, OWN);
  });

  it('reports a status WhatsApp refused with as a refusal', async () => {
    await expect(makeProfile(clientAnswering(403)).deleteProfilePicture()).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('reports a rate limit as the retryable failure it is', async () => {
    await expect(makeProfile(clientAnswering(429)).deleteProfilePicture()).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('answers 501 for a page without the job', async () => {
    await expect(makeProfile(clientAnswering('missing')).deleteProfilePicture()).rejects.toBeInstanceOf(
      EngineNotSupportedError,
    );
  });
});

describe('BaileysContacts.deleteProfilePicture', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  function makeContacts(
    sock: Record<string, jest.Mock>,
    opts: { selfJid?: string; budgetMs?: number } = {},
  ): BaileysContacts {
    const host = {
      ensureReady: () => undefined,
      getSocket: () => sock as unknown as WASocket,
      logger,
      normalizedSelfJid: () => (opts.selfJid === undefined ? '628177@s.whatsapp.net' : opts.selfJid),
      listContacts: () => [],
      findContact: () => null,
      resolvePhone: () => null,
      listChats: () => [],
      lastMessage: () => null,
      toEngineJid: (j: string) => j,
      toNeutralJid: (j: string) => j,
    } as unknown as BaileysContactsHost;
    return new BaileysContacts(host, opts.budgetMs ?? 500);
  }

  it("removes the picture for the account's OWN jid", async () => {
    const removeProfilePicture = jest.fn().mockResolvedValue(undefined);
    await expect(makeContacts({ removeProfilePicture }).deleteProfilePicture()).resolves.toBeUndefined();
    expect(removeProfilePicture).toHaveBeenCalledWith('628177@s.whatsapp.net');
  });

  // Mirrors setProfilePicture: an unknown self JID must fail loudly. Passing an empty string would
  // send the removal at nothing while the endpoint reported success.
  it('fails loudly when the own JID is not known yet', async () => {
    const removeProfilePicture = jest.fn().mockResolvedValue(undefined);
    await expect(makeContacts({ removeProfilePicture }, { selfJid: '' }).deleteProfilePicture()).rejects.toThrow(
      /own JID/i,
    );
    expect(removeProfilePicture).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed write rather than resolving on a silent socket', async () => {
    const contacts = makeContacts({ removeProfilePicture: jest.fn(never) }, { budgetMs: 15 });
    await expect(contacts.deleteProfilePicture()).rejects.toBeInstanceOf(EngineTransportError);
  });
});
