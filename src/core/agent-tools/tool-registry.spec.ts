import { allAgentTools } from './tools';
import { ToolRegistryService } from './tool-registry.service';
import type { ToolDescriptor } from './tool-descriptor';
import { z } from 'zod';

const r: ToolDescriptor = {
  name: 'R',
  description: 'd',
  tier: 'read',
  inputSchema: z.object({}),
  handler: () => Promise.resolve(1),
};
const w: ToolDescriptor = {
  name: 'W',
  description: 'd',
  tier: 'write',
  inputSchema: z.object({}),
  handler: () => Promise.resolve(1),
};

describe('ToolRegistryService', () => {
  it('throws on duplicate tool names', () => {
    expect(() => new ToolRegistryService([r, r])).toThrow(/duplicate/i);
  });
  it('list() returns all; list({readOnly}) returns only read tools', () => {
    const reg = new ToolRegistryService([r, w]);
    expect(
      reg
        .list()
        .map(t => t.name)
        .sort(),
    ).toEqual(['R', 'W']);
    expect(reg.list({ readOnly: true }).map(t => t.name)).toEqual(['R']);
  });
  it('get() resolves by name', () => {
    expect(new ToolRegistryService([r]).get('R')).toBe(r);
  });
});

describe('v1 tool surface snapshot', () => {
  it('exposes exactly the v1 tool surface (locks the agent contract)', () => {
    const expected = [
      'SessionFindAll',
      'SessionFindOne',
      'SessionGetChats',
      'SessionGetStats',
      'SessionSubscribePresence',
      'SessionGetPresence',
      'SessionMarkChatRead',
      'SessionMarkChatUnread',
      'SessionSendChatState',
      'MessageList',
      'MessageHistory',
      'MessageGetReactions',
      'MessageSendText',
      'MessageSendImage',
      'MessageSendVideo',
      'MessageSendAudio',
      'MessageSendDocument',
      'MessageSendLocation',
      'MessageSendContact',
      'MessageSendSticker',
      'MessageSendTemplate',
      'MessageReply',
      'MessageForward',
      'MessageReact',
      'ContactFindAll',
      'ContactFindOne',
      'ContactCheckNumber',
      'ContactResolvePhone',
      'ContactGetProfilePicture',
      'ContactBlock',
      'ContactUnblock',
      'GroupFindAll',
      'GroupFindOne',
      'GroupGetInviteCode',
      'GroupCreate',
      'GroupAddParticipants',
      'GroupSetSubject',
      'GroupSetDescription',
      'WebhooksList',
      'WebhookFindBySession',
      'WebhookFindOne',
      'LabelFindAll',
      'LabelFindOne',
      'LabelListChats',
      'LabelListForChat',
      'LabelUpsert',
      'LabelDelete',
      'LabelAddToChat',
      'LabelRemoveFromChat',
      'AutomationRuleFindAll',
      'AutomationRuleFindOne',
    ].sort();

    const actualNames = [...allAgentTools({} as never)].map(t => t.name).sort();

    expect(actualNames).toEqual(expected);
    expect(expected).toHaveLength(51);
  });
});
