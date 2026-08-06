import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { GroupService } from '../../../modules/group/group.service';
import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  GROUP_PARTICIPANTS_MAX,
} from '../../../modules/group/dto/group.dto';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function groupTools(group: GroupService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'GroupFindAll',
      description: 'List all groups the session is a member of. Use limit/offset to page.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: input => group.getGroups(input.sessionId, { limit: input.limit, offset: input.offset }),
    }),
    defineTool({
      name: 'GroupFindOne',
      description: 'Get detailed info for a specific group including participants list.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
      }),
      handler: input => group.getGroupInfo(input.sessionId, input.groupId),
    }),
    defineTool({
      name: 'GroupGetInviteCode',
      description: 'Get the invite code and link for a group.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
      }),
      handler: async input => {
        const inviteCode = await group.getGroupInviteCode(input.sessionId, input.groupId);
        return { inviteCode, inviteLink: `https://chat.whatsapp.com/${inviteCode}` };
      },
    }),
    defineTool({
      name: 'GroupCreate',
      description: 'Create a new WhatsApp group with a name and initial participants. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        name: z.string().min(1).max(GROUP_NAME_MAX_LENGTH).describe('Group subject/name'),
        participants: z
          .array(z.string())
          .min(1)
          .max(GROUP_PARTICIPANTS_MAX)
          .describe('Participant WhatsApp JIDs (e.g. 628123456789@c.us)'),
      }),
      handler: input => group.createGroup(input.sessionId, input.name, input.participants),
    }),
    defineTool({
      name: 'GroupAddParticipants',
      description:
        'Add participants to an existing group. The returned `results` carry the per-participant outcome (a partial refusal does not fail the batch). Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
        participants: z
          .array(z.string())
          .min(1)
          .max(GROUP_PARTICIPANTS_MAX)
          .describe('Participant WhatsApp JIDs to add'),
      }),
      handler: async input => {
        const results = await group.addParticipants(input.sessionId, input.groupId, input.participants);
        // Derive the verdict from the per-participant outcomes instead of asserting it: a batch in
        // which every participant was refused (not registered, already a member) must not report
        // success to an agent that only reads the top-level fields.
        const added = results.filter(r => r.success).length;
        return {
          success: added > 0,
          message:
            added === results.length
              ? 'Participants added'
              : `${added}/${results.length} participants added; see results for per-participant outcomes`,
          results,
        };
      },
    }),
    defineTool({
      name: 'GroupSetSubject',
      description: 'Change the group name/subject. Requires OPERATOR role.',
      tier: 'write',
      destructive: true,
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
        subject: z.string().min(1).max(GROUP_NAME_MAX_LENGTH).describe('New group subject/name'),
      }),
      handler: async input => {
        await group.setGroupSubject(input.sessionId, input.groupId, input.subject);
        return { success: true, message: 'Group subject updated' };
      },
    }),
    defineTool({
      name: 'GroupSetDescription',
      description: 'Change the group description. Pass empty string to clear it. Requires OPERATOR role.',
      tier: 'write',
      destructive: true,
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        groupId: z.string().describe('Group JID (e.g. 120363xxx@g.us)'),
        description: z
          .string()
          .max(GROUP_DESCRIPTION_MAX_LENGTH)
          .describe('New group description (may be empty to clear)'),
      }),
      handler: async input => {
        await group.setGroupDescription(input.sessionId, input.groupId, input.description);
        return { success: true, message: 'Group description updated' };
      },
    }),
  ];
}
