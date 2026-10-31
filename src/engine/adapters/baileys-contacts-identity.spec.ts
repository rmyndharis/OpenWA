import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { BaileysMessaging, BaileysMessagingHost } from './baileys-messaging';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { createLogger } from '../../common/services/logger.service';
import { toNeutralJid } from '../identity/wa-id';

const operations: Array<[string, (contacts: BaileysContacts) => Promise<unknown>]> = [
  ['mute', contacts => contacts.muteChat('628111@c.us', null)],
  ['pin', contacts => contacts.pinChat('628111@c.us', true)],
  ['unread', contacts => contacts.markUnread('628111@c.us')],
  ['clear', contacts => contacts.clearChatMessages('628111@c.us')],
  ['archive', contacts => contacts.archiveChat('628111@c.us', true)],
  ['delete', contacts => contacts.deleteChat('628111@c.us')],
  ['receipt', contacts => contacts.sendSeen('628111@c.us')],
  ['contact', contacts => contacts.getContactById('628111@c.us')],
];

class Query {
  withLIDProtocol(): this {
    return this;
  }
  withContext(): this {
    return this;
  }
  withUser(): this {
    return this;
  }
}
class User {
  withId(): this {
    return this;
  }
}

describe.each(['stored read', 'next key'] as const)('Read receipt identity after %s', phase => {
  it.each(['unchanged', 'retired', 'replaced'] as const)('keeps preparation on the %s socket', async state => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const result = (lid: string) => ({ list: [{ id: '628111@s.whatsapp.net', lid }] });
    const makeSocket = () => ({
      executeUSyncQuery: jest.fn().mockResolvedValue(result('222@lid')),
      readMessages: jest.fn().mockResolvedValue(undefined),
    });
    const first = makeSocket();
    first.executeUSyncQuery.mockResolvedValueOnce(result('111@lid'));
    const replacement = makeSocket();
    let current: typeof first | null = first;
    const changeSocket = () => {
      if (state === 'retired') current = null;
      if (state === 'replaced') current = replacement;
    };
    const recordLidMapping = jest.fn(() => {
      if (phase === 'next key') changeSocket();
    });
    const host = {
      ensureReady: () => undefined,
      getSocket: () => {
        if (!current) throw new EngineNotReadyError();
        return current as unknown as WASocket;
      },
      loadLib: () => Promise.resolve({ USyncQuery: Query, USyncUser: User }),
      getStoredMessages: async () => {
        if (phase === 'stored read') {
          entered();
          await gate;
        }
        return ['111', '222'].map((lid, i) => ({
          key: { id: `M${i + 1}`, remoteJid: `${lid}@lid`, fromMe: false },
        }));
      },
      findPersistedLidPhone: () => Promise.resolve(null),
      recordLidMapping,
      toEngineJid: (jid: string) => jid.replace('@c.us', '@s.whatsapp.net'),
    } as unknown as BaileysContactsHost;
    const pending = new BaileysContacts(host).sendSeen('628111@c.us', ['M1', 'M2']).catch((error: unknown) => error);
    if (phase === 'stored read') {
      await started;
      changeSocket();
      release();
    }
    const outcome: unknown = await pending;
    if (state === 'unchanged') expect(outcome).toBe(true);
    else expect(outcome).toBeInstanceOf(EngineNotReadyError);
    const reports = state === 'unchanged' ? 2 : phase === 'next key' ? 1 : 0;
    expect(recordLidMapping).toHaveBeenCalledTimes(reports);
    expect(first.executeUSyncQuery).toHaveBeenCalledTimes(reports);
    expect(replacement.executeUSyncQuery).not.toHaveBeenCalled();
    expect(first.readMessages).toHaveBeenCalledTimes(state === 'unchanged' ? 1 : 0);
    expect(replacement.readMessages).not.toHaveBeenCalled();
  });
});

describe.each(['persisted', 'fresh', 'library'] as const)('Chat identity prepared through %s mapping', source => {
  it.each(operations)('does not carry %s across a socket replacement', async (_name, act) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const makeSocket = () => ({
      chatModify: jest.fn().mockResolvedValue(undefined),
      readMessages: jest.fn().mockResolvedValue(undefined),
      fetchBlocklist: jest.fn().mockResolvedValue([]),
      executeUSyncQuery: jest.fn(async () => {
        entered();
        await gate;
        return { list: [{ id: '628111@s.whatsapp.net', lid: '111@lid' }] };
      }),
    });
    const first = makeSocket();
    const replacement = makeSocket();
    let current = first;
    const recordLidMapping = jest.fn();
    const key = { remoteJid: '111@lid', id: 'M1', fromMe: false };
    const host = {
      ensureReady: () => undefined,
      getSocket: () => current as unknown as WASocket,
      loadLib: async () => {
        if (source === 'library') {
          entered();
          await gate;
        }
        return { USyncQuery: Query, USyncUser: User };
      },
      logger: createLogger('ChatIdentity'),
      findPersistedLidPhone: async () => {
        if (source !== 'persisted') return null;
        entered();
        await gate;
        return '628111';
      },
      recordLidMapping,
      chatJid: () => '111@lid',
      toNeutralJid,
      toEngineJid: (jid: string) => jid,
      lastMessage: () => ({ key, jid: '111@lid', timestamp: 1 }),
      lastInboundMessage: () => ({ key, timestamp: 1 }),
      chatDeletedAt: () => null,
      findContact: () => ({ id: '111@lid', number: '628111', isWAContact: true }),
    } as unknown as BaileysContactsHost;
    const contacts = new BaileysContacts(host);
    const pending = act(contacts).catch((error: unknown) => error);
    await started;
    current = replacement;
    release();
    expect(await pending).toBeInstanceOf(EngineNotReadyError);
    for (const socket of [first, replacement]) {
      expect(socket.chatModify).not.toHaveBeenCalled();
      expect(socket.readMessages).not.toHaveBeenCalled();
      expect(socket.fetchBlocklist).not.toHaveBeenCalled();
    }
    expect(recordLidMapping).not.toHaveBeenCalled();
    if (source === 'library') expect(first.executeUSyncQuery).not.toHaveBeenCalled();
  });
});

it('does not query a retired message socket after the library finishes loading', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = {
    executeUSyncQuery: jest.fn().mockResolvedValue({ list: [{ id: '628111@s.whatsapp.net', lid: '111@lid' }] }),
    chatModify: jest.fn(),
  };
  let current = first;
  const recordLidMapping = jest.fn();
  const host = {
    ensureReady: () => undefined,
    getSocket: () => current,
    getSocketOrNull: () => current,
    loadLib: async () => {
      entered();
      await gate;
      return { USyncQuery: Query, USyncUser: User };
    },
    getStoredMessage: () =>
      Promise.resolve({
        key: { id: 'M1', remoteJid: '111@lid', fromMe: true },
        message: { conversation: 'mine' },
      }),
    wasDeletedForEveryone: () => false,
    pendingEditOf: () => undefined,
    findPersistedLidPhone: () => Promise.resolve(null),
    recordLidMapping,
    toEngineJid: (jid: string) => jid,
    logger: createLogger('MessageIdentity'),
  } as unknown as BaileysMessagingHost;
  const pending = new BaileysMessaging(host).starMessage('628111@c.us', 'M1', true).catch((error: unknown) => error);
  await started;
  current = { ...first, chatModify: jest.fn(), executeUSyncQuery: jest.fn() };
  release();
  expect(await pending).toBeInstanceOf(EngineNotReadyError);
  expect(first.executeUSyncQuery).not.toHaveBeenCalled();
  expect(first.chatModify).not.toHaveBeenCalled();
  expect(current.chatModify).not.toHaveBeenCalled();
  expect(recordLidMapping).not.toHaveBeenCalled();
});

const messageActions: Array<[string, (messaging: BaileysMessaging) => Promise<unknown>, boolean, boolean]> = [
  ['reply', m => m.replyToMessage('628111@c.us', 'M1', 'reply'), true, true],
  ['forward', m => m.forwardMessage('628111@c.us', '628111@c.us', 'M1'), true, true],
  ['reaction', m => m.reactToMessage('628111@c.us', 'M1', 'yes'), false, true],
  ['edit', m => m.editMessage('628111@c.us', 'M1', 'edited'), true, true],
  ['delete for everyone', m => m.deleteMessage('628111@c.us', 'M1', true), false, true],
  ['delete for me', m => m.deleteMessage('628111@c.us', 'M1', false), false, false],
  ['star', m => m.starMessage('628111@c.us', 'M1', true), false, false],
  ['pin', m => m.pinMessage('628111@c.us', 'M1', 86400), true, true],
  ['unpin', m => m.unpinMessage('628111@c.us', 'M1'), true, true],
  ['button', m => m.clickButton('628111@c.us', 'M1', 'yes'), true, true],
];

describe.each(['stored', 'persisted', 'library', 'recipient'] as const)(
  'Message actions prepared through %s',
  phase => {
    it.each(
      messageActions.filter(
        ([, , library, recipient]) => (phase !== 'library' || library) && (phase !== 'recipient' || recipient),
      ),
    )('does not move %s to a replacement socket', async (_name, act) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const pause = async (stage: string): Promise<void> => {
        if (stage === phase) {
          entered();
          await gate;
        }
      };
      const makeSocket = () => ({
        executeUSyncQuery: jest.fn(),
        chatModify: jest.fn().mockResolvedValue(undefined),
        sendMessage: jest.fn().mockResolvedValue(undefined),
        signalRepository: {
          lidMapping: {
            getLIDForPN: async () => {
              await pause('recipient');
              return '111@lid';
            },
          },
        },
      });
      const first = makeSocket(),
        replacement = makeSocket();
      let current = first;
      const recordLidMapping = jest.fn();
      const library = {
        USyncQuery: Query,
        USyncUser: User,
        normalizeMessageContent: (value: unknown) => value,
        getContentType: () => 'buttonsMessage',
        proto: { PinInChat: { Type: { PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 } } },
      };
      const host = {
        ensureReady: () => undefined,
        getSocket: () => current,
        getSocketOrNull: () => current,
        getStoredMessage: async () => {
          await pause('stored');
          return {
            key: { id: 'M1', remoteJid: '111@lid', fromMe: true },
            message: {
              buttonsMessage: {
                contentText: 'Choose',
                buttons: [{ buttonId: 'yes', buttonText: { displayText: 'Yes' } }],
              },
            },
            messageTimestamp: 1,
          };
        },
        wasDeletedForEveryone: () => false,
        pendingEditOf: () => undefined,
        findPersistedLidPhone: async () => {
          await pause('persisted');
          return '628111';
        },
        loadLib: async () => {
          await pause('library');
          return library;
        },
        toEngineJid: (jid: string) => jid,
        getEphemeralExpiration: () => undefined,
        toUnixSeconds: () => 1,
        recordLidMapping,
        logger: createLogger('MessageEpoch'),
      } as unknown as BaileysMessagingHost;
      const pending = act(new BaileysMessaging(host)).catch((error: unknown) => error);
      await started;
      const reportsBeforeRetire = recordLidMapping.mock.calls.length;
      current = replacement;
      release();
      expect(await pending).toBeInstanceOf(EngineNotReadyError);
      for (const socket of [first, replacement]) {
        expect(socket.chatModify).not.toHaveBeenCalled();
        expect(socket.sendMessage).not.toHaveBeenCalled();
      }
      expect(recordLidMapping).toHaveBeenCalledTimes(reportsBeforeRetire);
    });
  },
);
