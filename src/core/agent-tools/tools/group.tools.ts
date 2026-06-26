import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { GroupService } from '../../../modules/group/group.service';
import type { ToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function groupTools(group: GroupService): ToolDescriptor[] {
  return [
    {
      name: 'GroupFindAll',
      description: 'List all groups the session is a member of. Use limit/offset to page.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: (input: { sessionId: string; limit?: number; offset?: number }) =>
        group.getGroups(input.sessionId, { limit: input.limit, offset: input.offset }),
    },
    {
      name: 'GroupFindOne',
      description: 'Get detailed info for a specific group including participants list.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
      }),
      handler: (input: { sessionId: string; groupId: string }) => group.getGroupInfo(input.sessionId, input.groupId),
    },
    {
      name: 'GroupGetInviteCode',
      description: 'Get the invite code and link for a group.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
      }),
      handler: async (input: { sessionId: string; groupId: string }) => {
        const inviteCode = await group.getGroupInviteCode(input.sessionId, input.groupId);
        return { inviteCode, inviteLink: `https://chat.whatsapp.com/${inviteCode}` };
      },
    },
    {
      name: 'GroupCreate',
      description: 'Create a new WhatsApp group with a name and initial participants. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        name: z.string().min(1).describe('Group subject/name'),
        participants: z.array(z.string()).min(1).describe('Participant WhatsApp JIDs (e.g. 628123456789@c.us)'),
      }),
      handler: (input: { sessionId: string; name: string; participants: string[] }) =>
        group.createGroup(input.sessionId, input.name, input.participants),
    },
    {
      name: 'GroupAddParticipants',
      description: 'Add participants to an existing group. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
        participants: z.array(z.string()).min(1).describe('Participant WhatsApp JIDs to add'),
      }),
      handler: async (input: { sessionId: string; groupId: string; participants: string[] }) => {
        await group.addParticipants(input.sessionId, input.groupId, input.participants);
        return { success: true, message: 'Participants added' };
      },
    },
    {
      name: 'GroupSetSubject',
      description: 'Change the group name/subject. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
        subject: z.string().min(1).describe('New group subject/name'),
      }),
      handler: async (input: { sessionId: string; groupId: string; subject: string }) => {
        await group.setGroupSubject(input.sessionId, input.groupId, input.subject);
        return { success: true, message: 'Group subject updated' };
      },
    },
    {
      name: 'GroupSetDescription',
      description: 'Change the group description. Pass empty string to clear it. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
        description: z.string().describe('New group description (may be empty to clear)'),
      }),
      handler: async (input: { sessionId: string; groupId: string; description: string }) => {
        await group.setGroupDescription(input.sessionId, input.groupId, input.description);
        return { success: true, message: 'Group description updated' };
      },
    },
  ];
}
