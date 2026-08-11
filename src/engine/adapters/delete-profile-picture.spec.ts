import type { WASocket } from '@whiskeysockets/baileys';
import type { Client } from 'whatsapp-web.js';
import { BaileysContacts, type BaileysContactsHost } from './baileys-contacts';
import { WwebjsProfile } from './wwebjs-profile';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Delete the account's OWN profile picture — the fourth of the §29.5.3 backlog.
 *
 * The declared type lies about the outcomes. `Client.deleteProfilePicture(): Promise<boolean>`
 * forwards `WWebJS.deletePicture`, which has THREE exits (`Injected/Utils.js:1404-1418`):
 *   `undefined`  — `collection.canDelete()` was false, so nothing was attempted
 *   `true`       — the delete request came back HTTP 200
 *   `false`      — a `ServerStatusCodeError`, i.e. WhatsApp refused
 * `undefined` is falsy, so a naive `if (!ok) throw` collapses "there was nothing to delete" into
 * "WhatsApp refused" and makes a repeat delete fail with a 403.
 *
 * The contract therefore treats `undefined` as success — deleting an absent picture is a no-op, not
 * an error — and `false` as a refusal, matching how `setProfileName` reports whatsapp-web.js's
 * falsy return. **That split is a decision, not a measurement**: `canDelete()` could equally be a
 * permission check, in which case a genuine refusal would arrive as `undefined` and be swallowed.
 * It is pinned here so the live probe can contradict it visibly rather than silently.
 *
 * Baileys resolves `void` and has no refusal signal at all, so it reports success whenever the
 * write is acknowledged. Its `removeProfilePicture` takes a JID and is already wired for
 * `deleteGroupPicture` — the own-account call is the same symbol with the self JID, which is why
 * an unknown self JID has to fail loudly rather than silently target nothing.
 */

const logger = createLogger('delete-profile-picture.spec');

describe('WwebjsProfile.deleteProfilePicture', () => {
  function makeProfile(client: Record<string, jest.Mock>): WwebjsProfile {
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
    } as unknown as WwebjsEngineHost;
    return new WwebjsProfile(host);
  }

  it('a confirmed delete resolves', async () => {
    const deleteProfilePicture = jest.fn().mockResolvedValue(true);
    await expect(makeProfile({ deleteProfilePicture }).deleteProfilePicture()).resolves.toBeUndefined();
    expect(deleteProfilePicture).toHaveBeenCalledTimes(1);
  });

  // The distinction the declared `Promise<boolean>` hides.
  it('treats undefined as "nothing to delete" rather than a refusal, so a repeat delete is a no-op', async () => {
    const deleteProfilePicture = jest.fn().mockResolvedValue(undefined);
    await expect(makeProfile({ deleteProfilePicture }).deleteProfilePicture()).resolves.toBeUndefined();
  });

  it('reports an explicit false as a refusal', async () => {
    const deleteProfilePicture = jest.fn().mockResolvedValue(false);
    await expect(makeProfile({ deleteProfilePicture }).deleteProfilePicture()).rejects.toBeInstanceOf(
      EngineRefusedError,
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
