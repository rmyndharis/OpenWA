import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * `updateBlockStatus` maps the id between the phone-number and privacy-id dialects before it sends
 * anything, and refuses an id it cannot map with `Boom(..., { statusCode: 400 })` (chats.js has
 * three such throws: no PN for a lid, no LID for a phone number, and an id that is neither). Boom is
 * not an HttpException, so those escaped as an opaque `500 Internal server error` for a caller whose
 * request was well-formed and whose id the API itself accepts.
 *
 * whatsapp-web.js already answers `400 RecipientUnreachableError` for the same cause on the send
 * path ("No LID for user"), so this is the engine-parity mapping rather than a new contract.
 */
const host = (sock: Record<string, jest.Mock>): BaileysContactsHost =>
  ({
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    listChats: () => [],
    lastMessage: () => null,
    toEngineJid: (j: string) => j,
  }) as unknown as BaileysContactsHost;

const contacts = (sock: Record<string, jest.Mock>): BaileysContacts => new BaileysContacts(host(sock), 500);

describe('block/unblock on an id WhatsApp cannot map between dialects', () => {
  it.each([
    ['blockContact', (c: BaileysContacts) => c.blockContact('628123456789@s.whatsapp.net')],
    ['unblockContact', (c: BaileysContacts) => c.unblockContact('628123456789@s.whatsapp.net')],
  ])('%s answers 400, not an opaque 500', async (_name, call) => {
    const updateBlockStatus = jest
      .fn()
      .mockRejectedValue(
        new Boom('Unable to resolve LID for PN JID: 628123456789@s.whatsapp.net', { statusCode: 400 }),
      );
    await expect(call(contacts({ updateBlockStatus }))).rejects.toBeInstanceOf(RecipientUnreachableError);
  });

  it('blockContact answers 400 for a privacy id with no phone mapping', async () => {
    // The @lid half of the same guard: block resolves a lid to its phone number first.
    const updateBlockStatus = jest
      .fn()
      .mockRejectedValue(new Boom('Unable to resolve PN JID for LID: 159442138038327@lid', { statusCode: 400 }));
    await expect(contacts({ updateBlockStatus }).blockContact('159442138038327@lid')).rejects.toBeInstanceOf(
      RecipientUnreachableError,
    );
  });

  it('names the contact id so the caller knows which one failed', async () => {
    const updateBlockStatus = jest.fn().mockRejectedValue(new Boom('Unable to resolve LID', { statusCode: 400 }));
    await expect(contacts({ updateBlockStatus }).blockContact('628123456789@s.whatsapp.net')).rejects.toThrow(
      /628123456789@s\.whatsapp\.net/,
    );
  });

  /**
   * The discriminating half. Only a 400 means "this id cannot be used"; a dropped connection carries
   * DisconnectReason.connectionClosed (428) and must stay a transport failure, or a dead socket
   * would be reported to the caller as a bad contact id.
   */
  it('answers a dropped connection as the transport failure it is, not a bad id', async () => {
    const updateBlockStatus = jest.fn().mockRejectedValue(new Boom('Connection Closed', { statusCode: 428 }));
    const rejection = contacts({ updateBlockStatus }).blockContact('628123456789@s.whatsapp.net');
    await expect(rejection).rejects.not.toBeInstanceOf(RecipientUnreachableError);
    await expect(rejection).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('leaves the unconfirmed-write deadline alone', async () => {
    const updateBlockStatus = jest.fn(() => new Promise<never>(() => undefined));
    await expect(
      new BaileysContacts(host({ updateBlockStatus }), 15).blockContact('628123@c.us'),
    ).rejects.toBeInstanceOf(EngineTransportError);
  });
});
