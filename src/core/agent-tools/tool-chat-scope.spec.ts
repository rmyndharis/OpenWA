import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { ChatScopeService } from '../../modules/auth/chat-scope.service';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { AuthService } from '../../modules/auth/auth.service';
import type { ContactService } from '../../modules/contact/contact.service';
import type { GroupService } from '../../modules/group/group.service';
import type { LabelService } from '../../modules/label/label.service';
import type { MessageService } from '../../modules/message/message.service';
import type { SessionService } from '../../modules/session/session.service';
import { messageTools } from './tools/message.tools';
import { sessionTools } from './tools/session.tools';
import { contactTools } from './tools/contact.tools';
import { groupTools } from './tools/group.tools';
import { labelTools } from './tools/label.tools';
import { invokeTool } from './tool-invoker';
import { defineTool, type AnyToolDescriptor } from './tool-descriptor';

const CHAT = '628111000111@c.us';
const OTHER = '628222000222@c.us';
const key = { id: 'scoped-key', allowedSessions: ['s1'], allowedChats: [CHAT] };
const auth = {
  validateApiKey: jest.fn().mockResolvedValue(key),
  hasPermission: jest.fn().mockReturnValue(true),
} as unknown as AuthService;

const call = (tool: AnyToolDescriptor, input: unknown, scope = new ChatScopeService()) =>
  invokeTool(tool, input, 'key', auth, undefined, undefined, scope);

describe('chat-restricted tool calls', () => {
  const sendText = jest.fn().mockResolvedValue({ messageId: 'm1' });
  const forward = jest.fn().mockResolvedValue({ messageId: 'm2' });
  const reply = jest.fn().mockResolvedValue({ messageId: 'm3' });
  const tools = messageTools({ sendText, forward, reply } as unknown as MessageService);
  const tool = (name: string) => tools.find(t => t.name === name)!;

  beforeEach(() => jest.clearAllMocks());

  it('allows a send to an allowed chat through the shared invoker', async () => {
    await expect(call(tool('MessageSendText'), { sessionId: 's1', chatId: CHAT, text: 'hello' })).resolves.toEqual({
      messageId: 'm1',
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('refuses an outside destination before sending', async () => {
    await expect(
      call(tool('MessageSendText'), { sessionId: 's1', chatId: OTHER, text: 'hello' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('allows phone dialects and a persisted LID twin but refuses an unmapped LID', async () => {
    const scope = new ChatScopeService({
      findPhoneForLid: jest.fn(lid => Promise.resolve(lid === '123456' ? '628111000111' : undefined)),
      findLidsForPhone: jest.fn().mockResolvedValue(['123456']),
    } as unknown as LidMappingStoreService);
    for (const chatId of ['628111000111@s.whatsapp.net', '123456@lid']) {
      await call(tool('MessageSendText'), { sessionId: 's1', chatId, text: 'hello' }, scope);
    }
    await expect(
      call(tool('MessageSendText'), { sessionId: 's1', chatId: '654321@lid', text: 'hello' }, scope),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('fails closed without the scope service or with an unmarked tool', async () => {
    await expect(
      invokeTool(tool('MessageSendText'), { sessionId: 's1', chatId: CHAT, text: 'hello' }, 'key', auth),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const descriptor = sessionTools({} as SessionService).find(t => t.name === 'SessionGetStats')!;
    await expect(call(descriptor, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('authorizes the parsed destination and records a scope refusal before the handler', async () => {
    const handler = jest.fn();
    const rejected = jest.fn();
    const descriptor = defineTool({
      name: 'NormalizedDestination',
      description: 'Send to a normalized destination',
      tier: 'write',
      chatScope: ['chatId'],
      inputSchema: z.object({ chatId: z.string().transform(() => OTHER) }),
      handler,
    });
    await expect(
      invokeTool(descriptor, { chatId: CHAT }, 'key', auth, undefined, rejected, new ChatScopeService()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handler).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith(expect.any(ForbiddenException));
  });

  it.each([
    { fromChatId: OTHER, toChatId: CHAT },
    { fromChatId: CHAT, toChatId: OTHER },
  ])('fences both endpoints of a forward: %j', async endpoints => {
    await expect(
      call(tool('MessageForward'), { sessionId: 's1', messageId: 'm1', ...endpoints }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('allows forwarding when both endpoints are inside the allowlist', async () => {
    await expect(
      call(tool('MessageForward'), { sessionId: 's1', fromChatId: CHAT, toChatId: CHAT, messageId: 'm1' }),
    ).resolves.toEqual({ messageId: 'm2' });
  });

  it('refuses ordinary send quotes but permits a reply bound to its allowed chat', async () => {
    const input = { sessionId: 's1', chatId: CHAT, text: 'hello', quotedMessageId: 'quoted' };
    await expect(call(tool('MessageSendText'), input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendText).not.toHaveBeenCalled();
    await expect(call(tool('MessageReply'), input)).resolves.toEqual({ messageId: 'm3' });
  });

  it('requires a chat for message listing even when its schema makes chatId optional', async () => {
    await expect(call(tool('MessageList'), { sessionId: 's1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('filters the complete chat list before applying the requested page', async () => {
    const chats = [{ id: OTHER }, { id: CHAT }];
    const listChats = jest.fn().mockResolvedValue(chats);
    const getChats = jest.fn().mockResolvedValue(chats.slice(0, 1));
    const descriptor = sessionTools({ listChats, getChats } as unknown as SessionService).find(
      t => t.name === 'SessionGetChats',
    )!;
    await expect(call(descriptor, { sessionId: 's1', limit: 1 })).resolves.toEqual([{ id: CHAT }]);
    expect(listChats).toHaveBeenCalledWith('s1');
    expect(getChats).not.toHaveBeenCalled();
  });

  it.each(['ContactFindAll', 'GroupFindAll'])(
    'filters %s beyond the first thousand rows before pagination',
    async name => {
      const allowed = [{ id: CHAT }, { id: CHAT, name: 'second' }];
      const all = [...Array.from({ length: 1001 }, () => ({ id: OTHER })), ...allowed];
      const list = jest.fn().mockResolvedValue(all);
      const paged = jest.fn();
      const descriptors =
        name === 'ContactFindAll'
          ? contactTools({ listContacts: list, getContacts: paged } as unknown as ContactService)
          : groupTools({ listGroups: list, getGroups: paged } as unknown as GroupService);
      await expect(
        call(
          descriptors.find(t => t.name === name)!,
          { sessionId: 's1', limit: 1, offset: 1 },
        ),
      ).resolves.toEqual([allowed[1]]);
      expect(list).toHaveBeenCalledWith('s1');
      expect(paged).not.toHaveBeenCalled();
    },
  );

  it('filters label chat membership', async () => {
    const descriptor = labelTools({
      getChatsByLabel: jest.fn().mockResolvedValue([{ id: OTHER }, { id: CHAT }]),
    } as unknown as LabelService).find(t => t.name === 'LabelListChats')!;
    await expect(call(descriptor, { sessionId: 's1', labelId: '1' })).resolves.toEqual([{ id: CHAT }]);
  });
});
