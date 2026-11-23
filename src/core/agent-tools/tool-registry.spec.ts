import { allAgentTools } from './tools';
import { ToolRegistryService } from './tool-registry.service';
import type { ToolDescriptor } from './tool-descriptor';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
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
      'MessageSearch',
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
    expect(expected).toHaveLength(52);
  });

  it('places GroupGetInviteCode in the write tier so read-only mounts exclude it', () => {
    const reg = new ToolRegistryService(allAgentTools({} as never));
    const readOnlyNames = reg.list({ readOnly: true }).map(t => t.name);
    const fullNames = reg.list({ readOnly: false }).map(t => t.name);
    const inviteTool = reg.get('GroupGetInviteCode');

    expect(inviteTool).toBeDefined();
    expect(inviteTool?.tier).toBe('write');
    expect(inviteTool?.requiredRole).toBe(ApiKeyRole.OPERATOR);
    expect(inviteTool?.sessionScoped).toBe(true);
    expect(readOnlyNames).not.toContain('GroupGetInviteCode');
    expect(fullNames).toContain('GroupGetInviteCode');
  });

  it('marks read tools returning user-authored WhatsApp text with returnsUntrustedContent', () => {
    const reg = new ToolRegistryService(allAgentTools({} as never));
    const untrustedToolNames = [
      'MessageList',
      'MessageHistory',
      'MessageSearch',
      'MessageGetReactions',
      'SessionGetChats',
      'LabelListChats',
      'ContactFindAll',
      'ContactFindOne',
      'GroupFindAll',
      'GroupFindOne',
    ];
    for (const name of untrustedToolNames) {
      expect(reg.get(name)?.returnsUntrustedContent).toBe(true);
    }

    for (const name of ['SessionFindAll', 'SessionFindOne', 'SessionGetStats', 'WebhooksList']) {
      expect(reg.get(name)?.returnsUntrustedContent).toBeFalsy();
    }
  });
});
