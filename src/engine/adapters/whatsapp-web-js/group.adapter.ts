import { Group, GroupInfo, GroupParticipant } from '../../interfaces/whatsapp-engine.interface';
import { GroupChat, GroupCreateResult } from '../../types/whatsapp-web-js.types';
import { AdapterContext } from './context';

/**
 * Group concern: listing, info, creation, participant/admin management,
 * subject/description, invite codes. Bodies moved verbatim from the monolithic
 * adapter; behavior is identical.
 */
export class GroupAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async getGroups(): Promise<Group[]> {
    const client = this.ctx.requireClient();
    const chats = await client.getChats();

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(p => p.isAdmin && p.id._serialized === client.info?.wid?._serialized),
      };
    });
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    const client = this.ctx.requireClient();
    try {
      const chat = await client.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.ctx.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    const client = this.ctx.requireClient();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await client.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.ctx.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.ctx.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }
}
