import { BadRequestException } from '@nestjs/common';
import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { readChatModels } from './wwebjs-chats';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { provesNothingSent } from '../../common/errors/engine-not-sent.error';

const { GroupChat, Chat } = wwebjs as unknown as {
  GroupChat: { prototype: { getInviteCode: () => Promise<string> } };
  Chat: {
    prototype: {
      sendSeen: () => Promise<boolean>;
      clearMessages: () => Promise<boolean>;
      markUnread: () => Promise<void>;
      delete: () => Promise<boolean>;
      sendStateTyping: () => Promise<boolean>;
      fetchMessages: (opts: unknown) => Promise<unknown[]>;
      getLabels: () => Promise<unknown[]>;
    };
  };
};

describe('WhatsAppWebJsAdapter group operations when groupMetadata.update hits invariant 76137', () => {
  const GROUP = '120363000000000001@g.us';
  const INVARIANT = new Error('Evaluation failed: Invariant Violation: Minified invariant #76137; %s');

  const localGroupModel = {
    id: { _serialized: GROUP },
    name: 'Coexistence Group',
    isGroup: true,
    isMuted: false,
    groupMetadata: {
      announce: false,
      restrict: false,
      participants: [{ id: { _serialized: '628111@c.us', user: '628111' }, isAdmin: true, isSuperAdmin: false }],
    },
    metadataRefreshError: 'Invariant Violation: Minified invariant #76137; %s',
  };

  const readyAdapter = (client: Record<string, unknown>): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    jest.restoreAllMocks();
  });

  it('serves requireGroupChat actions (getGroupInviteCode) from local group metadata on a page invariant', async () => {
    jest.spyOn(GroupChat.prototype, 'getInviteCode').mockResolvedValue('INVITE123');
    const getChatById = jest.fn().mockRejectedValue(INVARIANT);
    const evaluate = jest.fn((fn: unknown, arg?: unknown) => {
      if (fn === readChatModels) {
        expect(arg).toEqual([GROUP]);
        return Promise.resolve([localGroupModel]);
      }
      return Promise.resolve(undefined);
    });

    const adapter = readyAdapter({ getChatById, pupPage: { evaluate } });

    await expect(adapter.getGroupInviteCode(GROUP)).resolves.toBe('INVITE123');
  });

  it('allows muteChat and pinChat on a group whose metadata refresh fails with a page invariant', async () => {
    const getChatById = jest.fn().mockRejectedValue(INVARIANT);
    const muteChat = jest.fn().mockResolvedValue({ isMuted: true, muteExpiration: 1700000060 });
    const pinChat = jest.fn().mockResolvedValue(true);
    const evaluate = jest.fn((fn: unknown) =>
      fn === readChatModels ? Promise.resolve([localGroupModel]) : Promise.resolve(undefined),
    );

    const adapter = readyAdapter({ getChatById, muteChat, pinChat, pupPage: { evaluate } });

    await expect(adapter.muteChat(GROUP, 60_000)).resolves.toBeUndefined();
    expect(muteChat).toHaveBeenCalledWith(GROUP, expect.any(Date));

    await expect(adapter.pinChat(GROUP, true)).resolves.toBe(true);
    expect(pinChat).toHaveBeenCalledWith(GROUP);
  });

  it('executes single-chat actions (sendSeen, clearChatMessages, markUnread, deleteChat, sendChatState) on a group whose metadata refresh fails with a page invariant', async () => {
    const sendSeenSpy = jest.spyOn(Chat.prototype, 'sendSeen').mockResolvedValue(true);
    const clearSpy = jest.spyOn(Chat.prototype, 'clearMessages').mockResolvedValue(true);
    const unreadSpy = jest.spyOn(Chat.prototype, 'markUnread').mockResolvedValue(undefined);
    const deleteSpy = jest.spyOn(Chat.prototype, 'delete').mockResolvedValue(true);
    const typingSpy = jest.spyOn(Chat.prototype, 'sendStateTyping').mockResolvedValue(true);
    const getChatById = jest.fn().mockRejectedValue(INVARIANT);
    const evaluate = jest.fn((fn: unknown) =>
      fn === readChatModels ? Promise.resolve([localGroupModel]) : Promise.resolve(undefined),
    );

    const adapter = readyAdapter({ getChatById, pupPage: { evaluate } });

    await expect(adapter.sendSeen(GROUP)).resolves.toBe(true);
    await expect(adapter.clearChatMessages(GROUP)).resolves.toBe(true);
    await expect(adapter.markUnread(GROUP)).resolves.toBe(true);
    await expect(adapter.deleteChat(GROUP)).resolves.toBe(true);
    await expect(adapter.sendChatState(GROUP, 'typing')).resolves.toBeUndefined();
    expect(sendSeenSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(unreadSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(typingSpy).toHaveBeenCalledTimes(1);
  });

  it('reads and updates chat labels on a group whose metadata refresh fails with a page invariant', async () => {
    jest.spyOn(Chat.prototype, 'getLabels').mockRejectedValue(INVARIANT);
    (globalThis as unknown as { window?: unknown }).window = {
      WWebJS: {
        getChat: jest.fn((id: string, opts: { getAsModel: boolean }) => {
          expect(opts).toEqual({ getAsModel: false });
          return Promise.resolve(id === GROUP ? { labels: ['1'] } : null);
        }),
        getLabel: (id: string) => ({ id, name: 'VIP', hexColor: '#ff0000' }),
      },
    };
    const getChatById = jest.fn().mockRejectedValue(INVARIANT);
    const addOrRemoveLabels = jest.fn().mockResolvedValue(undefined);
    const getLabels = jest.fn().mockResolvedValue([
      { id: '1', name: 'VIP', hexColor: '#ff0000' },
      { id: '2', name: 'Urgent', hexColor: '#00ff00' },
    ]);
    const evaluate = jest.fn((fn: (arg: unknown) => unknown, arg?: unknown) => {
      if (fn === readChatModels) return Promise.resolve([localGroupModel]);
      return Promise.resolve(fn(arg));
    });

    const adapter = readyAdapter({ getChatById, addOrRemoveLabels, getLabels, pupPage: { evaluate } });

    await expect(adapter.getChatLabels(GROUP)).resolves.toEqual([{ id: '1', name: 'VIP', hexColor: '#ff0000' }]);
    await expect(adapter.addLabelToChat(GROUP, '2')).resolves.toBeUndefined();
    expect(addOrRemoveLabels).toHaveBeenCalledWith(['1', '2'], [GROUP]);
  });

  it('fetches chat history and runs message lookups on a group whose metadata refresh fails with a page invariant', async () => {
    const react = jest.fn().mockResolvedValue(undefined);
    const edit = jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1700000001 });
    const del = jest.fn().mockResolvedValue(undefined);
    const pin = jest.fn().mockResolvedValue(true);
    const reply = jest.fn().mockResolvedValue({ id: { _serialized: 'M2' }, timestamp: 1700000002 });
    const fetchMessagesSpy = jest.spyOn(Chat.prototype, 'fetchMessages').mockResolvedValue([
      {
        id: { _serialized: 'M1', id: 'M1' },
        from: '628111@c.us',
        to: GROUP,
        body: 'hello group',
        type: 'chat',
        timestamp: 1700000000,
        fromMe: false,
        hasMedia: false,
        hasQuotedMsg: false,
        hasReaction: false,
        react,
        edit,
        delete: del,
        pin,
        reply,
      },
    ]);
    const getChatById = jest.fn().mockRejectedValue(INVARIANT);
    const evaluate = jest.fn((fn: unknown) =>
      fn === readChatModels ? Promise.resolve([localGroupModel]) : Promise.resolve(undefined),
    );

    const adapter = readyAdapter({ getChatById, pupPage: { evaluate } });

    const history = await adapter.getChatHistory(GROUP, 10, false);
    expect(fetchMessagesSpy).toHaveBeenCalledWith({ limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: 'M1', chatId: GROUP, body: 'hello group', isGroup: true });

    await expect(adapter.replyToMessage(GROUP, 'M1', 'ack')).resolves.toEqual({ id: 'M2', timestamp: 1700000002 });
    await expect(adapter.reactToMessage(GROUP, 'M1', '👍')).resolves.toBeUndefined();
    await expect(adapter.editMessage(GROUP, 'M1', 'edited')).resolves.toEqual({ id: 'M1', timestamp: 1700000001 });
    await expect(adapter.deleteMessage(GROUP, 'M1', true)).resolves.toBe('M1');
    await expect(adapter.pinMessage(GROUP, 'M1', 86400)).resolves.toBeUndefined();
    expect(react).toHaveBeenCalledWith('👍');
    expect(edit).toHaveBeenCalledWith('edited');
    expect(del).toHaveBeenCalledWith(true);
    expect(pin).toHaveBeenCalledWith(86400);
  });

  it('does not fall back to readChatModels on a non-invariant getChatById rejection', async () => {
    const ordinary = new Error('No LID for user');
    const getChatById = jest.fn().mockRejectedValue(ordinary);
    const evaluate = jest.fn();
    const adapter = readyAdapter({ getChatById, pupPage: { evaluate } });

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBe(ordinary);
    await expect(adapter.muteChat(GROUP, 60_000)).rejects.toBeInstanceOf(BadRequestException);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('marks pre-send reply failure as nothing-sent when the session stops while the recovery read runs', async () => {
    const fetchMessagesSpy = jest.spyOn(Chat.prototype, 'fetchMessages').mockResolvedValue([]);
    const evaluate = jest.fn((fn: unknown) => {
      if (fn !== readChatModels) return Promise.resolve(undefined);
      // The session stops after the recovery read began, and the read fails with it.
      (adapter as unknown as { status: EngineStatus }).status = EngineStatus.DISCONNECTED;
      return Promise.reject(new Error('Session closed during the read'));
    });
    const getChatById = jest.fn().mockRejectedValue(INVARIANT);
    const adapter = readyAdapter({ getChatById, pupPage: { evaluate } });

    const error = await adapter.replyToMessage(GROUP, 'M1', 'ack').catch((e: unknown) => e);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(provesNothingSent(error)).toBe(true);
    expect(fetchMessagesSpy).not.toHaveBeenCalled();
  });

  it('does not log a TypeError warning in getGroupInfo when getChatById resolves undefined for a missing group', async () => {
    const getChatById = jest.fn().mockResolvedValue(undefined);
    const adapter = readyAdapter({ getChatById });
    const logger = (adapter as unknown as { logger: { warn: (m: string, meta?: unknown) => void } }).logger;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(adapter.getGroupInfo('120363000000000999@g.us')).resolves.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
