import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { isAddressableParticipant, toParticipantWid } from '../../engine/identity/wa-id';

/**
 * Owns engine access for channel/newsletter operations so the "session not started" guard
 * and channel business rules (not-found mapping) live behind the service boundary.
 */
@Injectable()
export class ChannelService {
  private static readonly MAX_CHANNEL_HISTORY_LIMIT = 100;

  constructor(private readonly engines: EngineRegistry) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  getSubscribedChannels(sessionId: string) {
    return this.getEngine(sessionId).getSubscribedChannels();
  }

  async getChannelById(sessionId: string, channelId: string) {
    const channel = await this.getEngine(sessionId).getChannelById(channelId);
    if (!channel) {
      throw new NotFoundException(`Channel ${channelId} not found`);
    }
    return channel;
  }

  /**
   * `limit` is clamped to [1, 100] (and falls back to 50 for non-finite input) so a caller cannot
   * ask the engine for an unbounded history window — the wwjs engine treats a limit < 1 as "no
   * limit" and would return every loaded message (same clamp discipline as MessageService.getChatHistory).
   */
  getChannelMessages(sessionId: string, channelId: string, limit = 50) {
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), ChannelService.MAX_CHANNEL_HISTORY_LIMIT)
      : 50;
    return this.getEngine(sessionId).getChannelMessages(channelId, safeLimit);
  }

  /** Create a channel. The account owns it, which is what makes deleting it possible later. */
  createChannel(sessionId: string, name: string, description?: string) {
    return this.getEngine(sessionId).createChannel(name, description);
  }

  /** Delete a channel this account owns. Irreversible, and its subscribers lose it. */
  deleteChannel(sessionId: string, channelId: string) {
    return this.getEngine(sessionId).deleteChannel(channelId);
  }

  /** Mute or unmute a channel's notifications. Subscription is untouched either way. */
  muteChannel(sessionId: string, channelId: string, mute: boolean) {
    return this.getEngine(sessionId).muteChannel(channelId, mute);
  }

  /**
   * The user id both admin writes address, qualified for the engine.
   *
   * Their DTOs only require a non-empty string, and `toEngineJid` passes anything it cannot
   * classify through verbatim — so free text, a group id or a bare `@c.us` reached the socket and
   * failed opaquely, while the group participant writes reject the same input with a naming 400.
   *
   * Guarded here rather than in the DTO to match where the group guard sits, so the rule holds for
   * any caller and not only the HTTP body. Note the group guard's stated reason does NOT carry over
   * verbatim: it covers the agent tools because `AgentToolDeps` injects `GroupService`, and there is
   * no channel tool family — `src/core/agent-tools/tools/index.ts` wires session, message, contact,
   * group, webhook, labels and automation, and nothing else. Today the controller is the only
   * caller; the placement is for the next one.
   */
  private addressableUser(userId: string): string {
    if (!isAddressableParticipant(userId)) {
      throw new BadRequestException(
        `Not an individual user id: ${userId} — pass a phone number, <phone>@c.us or <lid>@lid`,
      );
    }
    return toParticipantWid(userId);
  }

  /** Demote a channel admin back to a subscriber. There is no promote counterpart on either engine. */
  demoteChannelAdmin(sessionId: string, channelId: string, userId: string) {
    const engine = this.getEngine(sessionId);
    return engine.demoteChannelAdmin(channelId, this.addressableUser(userId));
  }

  /** Hand the channel to a new owner. Irreversible — the account stops being the owner. */
  transferChannelOwnership(sessionId: string, channelId: string, newOwnerId: string) {
    const engine = this.getEngine(sessionId);
    return engine.transferChannelOwnership(channelId, this.addressableUser(newOwnerId));
  }

  subscribeToChannel(sessionId: string, inviteCode: string) {
    return this.getEngine(sessionId).subscribeToChannel(inviteCode);
  }

  unsubscribeFromChannel(sessionId: string, channelId: string) {
    return this.getEngine(sessionId).unsubscribeFromChannel(channelId);
  }
}
