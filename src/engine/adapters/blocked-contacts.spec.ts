import { WwebjsContacts } from './wwebjs-contacts';
import { BaileysContacts } from './baileys-contacts';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import type { Client } from 'whatsapp-web.js';
import type { WASocket } from '@whiskeysockets/baileys';

/**
 * The blocklist READ — the missing half of the exposed block/unblock writes. The neutral shape is
 * a bare array of ids: whatsapp-web.js resolves full Contact models but Baileys' blocklist query
 * answers only jids, and inventing the other fields on one engine would make the two engines claim
 * different things about the same account.
 */

const logger = createLogger('blocked-contacts.spec');

describe('WwebjsContacts.getBlockedContacts', () => {
  function makeContacts(): { contacts: WwebjsContacts; client: { getBlockedContacts: jest.Mock } } {
    const client = { getBlockedContacts: jest.fn() };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    return { contacts: new WwebjsContacts(host), client };
  }

  it('maps the blocked Contact models to their neutral ids', async () => {
    const { contacts, client } = makeContacts();
    client.getBlockedContacts.mockResolvedValue([
      { id: { _serialized: '628111@c.us' } },
      { id: { _serialized: '628222@c.us' } },
    ]);

    await expect(contacts.getBlockedContacts()).resolves.toEqual(['628111@c.us', '628222@c.us']);
  });

  it('drops an entry whose id is unreadable rather than reporting "undefined"', async () => {
    const { contacts, client } = makeContacts();
    client.getBlockedContacts.mockResolvedValue([{ id: {} }, { id: { _serialized: '628333@c.us' } }]);

    await expect(contacts.getBlockedContacts()).resolves.toEqual(['628333@c.us']);
  });

  it('resolves [] for an empty blocklist', async () => {
    const { contacts, client } = makeContacts();
    client.getBlockedContacts.mockResolvedValue([]);

    await expect(contacts.getBlockedContacts()).resolves.toEqual([]);
  });
});

describe('BaileysContacts.getBlockedContacts', () => {
  function makeContacts(): { contacts: BaileysContacts; sock: { fetchBlocklist: jest.Mock } } {
    const sock = { fetchBlocklist: jest.fn() };
    const host = {
      ensureReady: jest.fn(),
      getSocket: () => sock as unknown as WASocket,
      logger,
      toNeutralJid: (jid: string) => jid.replace('@s.whatsapp.net', '@c.us'),
    };
    return { contacts: new BaileysContacts(host as never), sock };
  }

  it('neutralises the blocklist jids', async () => {
    const { contacts, sock } = makeContacts();
    sock.fetchBlocklist.mockResolvedValue(['628111@s.whatsapp.net', '628222@s.whatsapp.net']);

    await expect(contacts.getBlockedContacts()).resolves.toEqual(['628111@c.us', '628222@c.us']);
  });

  it('drops undefined jid attrs (a wire item without a jid carries nothing addressable)', async () => {
    const { contacts, sock } = makeContacts();
    sock.fetchBlocklist.mockResolvedValue([undefined, '628333@s.whatsapp.net']);

    await expect(contacts.getBlockedContacts()).resolves.toEqual(['628333@c.us']);
  });

  it('resolves [] for an empty blocklist', async () => {
    const { contacts, sock } = makeContacts();
    sock.fetchBlocklist.mockResolvedValue([]);

    await expect(contacts.getBlockedContacts()).resolves.toEqual([]);
  });
});
