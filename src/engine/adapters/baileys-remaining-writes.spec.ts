import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { BaileysMessaging, BaileysMessagingHost } from './baileys-messaging';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * The last group of writes whose confirmation the library discards. Same reasoning as the group and
 * profile writes: `chatModify`, the addressbook writes and the block toggles all await a query and
 * return void, so the call resolves identically whether WhatsApp applied the change or never
 * answered. One case per call site — a missing wrapper is invisible any other way.
 */
const never = (): Promise<never> => new Promise<never>(() => undefined);
const stub = () => jest.fn(never);
const LAST = { key: { id: 'M1', remoteJid: '628123@s.whatsapp.net' }, timestamp: 1 };

function contacts(sock: Record<string, jest.Mock>, budgetMs: number): BaileysContacts {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    listChats: () => [],
    lastMessage: () => LAST,
    toEngineJid: (j: string) => j,
  } as unknown as BaileysContactsHost;
  return new BaileysContacts(host, budgetMs);
}

function messaging(sock: Record<string, jest.Mock>, budgetMs: number): BaileysMessaging {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    toNeutralJid: (j: string) => j,
    toEngineJid: (j: string) => j,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    getEphemeralExpiration: () => undefined,
    toUnixSeconds: () => 1,
    loadLib: () => Promise.resolve({} as never),
    getStoredMessage: () => Promise.resolve({ key: { ...LAST.key, fromMe: true }, message: {}, messageTimestamp: 1 }),
    putStoredMessage: () => undefined,
    recordLidMapping: () => undefined,
    getOnMessageCreate: () => undefined,
    mapMessage: () => Promise.resolve({} as never),
  } as unknown as BaileysMessagingHost;
  return new BaileysMessaging(host, budgetMs);
}

describe('contact and chat-state writes report an unconfirmed write', () => {
  it.each([
    ['upsertContact', 'addOrEditContact', (c: BaileysContacts) => c.upsertContact('628123@c.us', 'Ada')],
    ['deleteContact', 'removeContact', (c: BaileysContacts) => c.deleteContact('628123@c.us')],
    ['blockContact', 'updateBlockStatus', (c: BaileysContacts) => c.blockContact('628123@c.us')],
    ['unblockContact', 'updateBlockStatus', (c: BaileysContacts) => c.unblockContact('628123@c.us')],
    ['markUnread', 'chatModify', (c: BaileysContacts) => c.markUnread('628123@c.us')],
    ['clearChatMessages', 'chatModify', (c: BaileysContacts) => c.clearChatMessages('628123@c.us')],
    ['archiveChat', 'chatModify', (c: BaileysContacts) => c.archiveChat('628123@c.us', true)],
    ['deleteChat', 'chatModify', (c: BaileysContacts) => c.deleteChat('628123@c.us')],
  ])('%s', async (_n, method, call) => {
    await expect(call(contacts({ [method]: stub() }, 15))).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const updateBlockStatus = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ updateBlockStatus }, 500).blockContact('628123@c.us')).resolves.toBeUndefined();
  });
});

describe('message chat-state writes report an unconfirmed write', () => {
  it.each([
    ['deleteMessage (for me)', (m: BaileysMessaging) => m.deleteMessage('628123@s.whatsapp.net', 'M1', false)],
    ['starMessage', (m: BaileysMessaging) => m.starMessage('628123@s.whatsapp.net', 'M1', true)],
  ])('%s', async (_n, call) => {
    await expect(call(messaging({ chatModify: stub() }, 15))).rejects.toBeInstanceOf(EngineTransportError);
  });
});
