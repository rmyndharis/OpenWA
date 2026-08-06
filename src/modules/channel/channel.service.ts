import { Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

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

  subscribeToChannel(sessionId: string, inviteCode: string) {
    return this.getEngine(sessionId).subscribeToChannel(inviteCode);
  }

  unsubscribeFromChannel(sessionId: string, channelId: string) {
    return this.getEngine(sessionId).unsubscribeFromChannel(channelId);
  }
}
