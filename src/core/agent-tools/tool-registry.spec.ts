import { ToolRegistryService } from './tool-registry.service';
import type { ToolDescriptor } from './tool-descriptor';
import type { SessionService } from '../../modules/session/session.service';
import type { MessageService } from '../../modules/message/message.service';
import type { ContactService } from '../../modules/contact/contact.service';
import type { GroupService } from '../../modules/group/group.service';
import type { WebhookService } from '../../modules/webhook/webhook.service';
import { z } from 'zod';
import { sessionTools } from './tools/session.tools';
import { messageTools } from './tools/message.tools';
import { contactTools } from './tools/contact.tools';
import { groupTools } from './tools/group.tools';
import { webhookTools } from './tools/webhook.tools';

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
    ].sort();

    const actualNames = [
      ...sessionTools({} as unknown as SessionService),
      ...messageTools({} as unknown as MessageService),
      ...contactTools({} as unknown as ContactService),
      ...groupTools({} as unknown as GroupService),
      ...webhookTools({} as unknown as WebhookService),
    ]
      .map(t => t.name)
      .sort();

    expect(actualNames).toEqual(expected);
    expect(expected).toHaveLength(39);
  });
});
