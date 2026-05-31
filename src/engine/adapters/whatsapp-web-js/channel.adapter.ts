import { Channel, ChannelMessage } from '../../interfaces/whatsapp-engine.interface';
import { BusinessClient, WwjsChannelData } from '../../types/whatsapp-web-js.types';
import { AdapterContext } from './context';

/**
 * Channel/Newsletter concern: subscribed channels, lookup, subscribe/
 * unsubscribe, message history. Bodies moved verbatim from the monolithic
 * adapter; behavior is identical.
 */
export class ChannelAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async getSubscribedChannels(): Promise<Channel[]> {
    const client = this.ctx.requireClient();
    const channels = await (client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    const client = this.ctx.requireClient();
    try {
      const ch = await (client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
        verified: ch.verified ? Boolean(ch.verified) : undefined,
      };
    } catch (error) {
      this.ctx.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    const client = this.ctx.requireClient();
    const ch = await (client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.ctx.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    const client = this.ctx.requireClient();
    await (client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.ctx.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    // Gate outside the try so a not-ready error propagates (original behavior)
    // rather than being swallowed into an empty array.
    const client = this.ctx.requireClient();
    try {
      const ch = await (client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        throw new Error(`Channel ${channelId} not found`);
      }
      const messages = await ch.fetchMessages({ limit });
      if (!messages) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.ctx.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }
}
