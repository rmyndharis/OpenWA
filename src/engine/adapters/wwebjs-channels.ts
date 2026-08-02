import { type Client } from 'whatsapp-web.js';
import { Channel, ChannelMessage } from '../interfaces/whatsapp-engine.interface';
import { BusinessClient, WwjsChannelData } from '../types/whatsapp-web-js.types';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Channel/Newsletter operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so
 * the delegate never touches lifecycle state directly.
 */
export class WwebjsChannels {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getSubscribedChannels(): Promise<Channel[]> {
    this.host.ensureReady();
    const channels = await (this.client() as unknown as BusinessClient).getChannels();
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
    this.host.ensureReady();
    // wwebjs 1.34.x exposes no client.getChannelById; resolve from the subscribed-channel list (#625).
    const channels = await this.getSubscribedChannels();
    return channels.find(c => c.id === channelId) ?? null;
  }

  // whatsapp-web.js `Client.subscribeToChannel(channelId)` takes a channel ID and resolves a
  // boolean (index.d.ts:71; Client.js:2533) — the interface contract here is subscribe-by-INVITE-CODE
  // returning the subscribed Channel. The old wiring passed the invite code straight in and mapped
  // the returned boolean as if it were a Channel, fabricating `{ id: "undefined" }`: a reported
  // success that never subscribed anything. A real wiring is the two-step
  // `getChannelByInviteCode(inviteCode)` (Client.js:1707) → `subscribeToChannel(channel.id)` flow;
  // until that is verified against a live session, an honest 501 beats a phantom success.
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async subscribeToChannel(_inviteCode: string): Promise<Channel> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('subscribeToChannel');
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    // Resolves false instead of throwing when the unsubscription did not complete (Client.js:2556)
    // — surface the refusal rather than reporting a false success.
    const ok = await (this.client() as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    if (!ok) {
      throw new EngineRefusedError(`Failed to unsubscribe from channel ${channelId}`);
    }
    this.host.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.host.ensureReady();
    // wwebjs 1.34.x has no client.getChannelById (calling it threw and the error was swallowed into an
    // empty list, #625). The subscribed Channel instances returned by getChannels() carry fetchMessages(),
    // so resolve the channel from that list and read its messages. A missing channel surfaces as a
    // ChannelNotFoundError (→ 404, like getChannelById) so callers can tell "no messages" apart from
    // "wrong/unsubscribed channel" instead of getting a silent [].
    const channels = await (this.client() as unknown as BusinessClient).getChannels();
    const channel = channels?.find(c => (typeof c.id === 'object' ? c.id._serialized : c.id) === channelId);
    if (!channel) {
      throw new ChannelNotFoundError(channelId);
    }
    // wwebjs Channel.fetchMessages only honors a limit > 0: its load-earlier loop AND the final
    // splice are both gated on `searchOptions.limit > 0` (Channel.js:352), so a 0/negative/NaN
    // limit fails OPEN and returns every loaded message. Substitute the default instead.
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 50;
    const messages = await channel.fetchMessages({ limit: safeLimit });
    return (messages ?? []).map(msg => ({
      // Read `$1` before the sentinel (#747), and don't `String()` the object branch: that turned an
      // unreadable id into the literal "undefined" rather than the empty sentinel every other path
      // uses. Read-only endpoint — never persisted, never ack-matched — so `''` carries no collision
      // risk here; it just means "id unreadable".
      id: (typeof msg.id === 'object' ? (msg.id?._serialized ?? msg.id?.$1) : msg.id) || '',
      body: String(msg.body || ''),
      timestamp: Number(msg.timestamp),
      hasMedia: Boolean(msg.hasMedia),
      mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
    }));
  }
}
