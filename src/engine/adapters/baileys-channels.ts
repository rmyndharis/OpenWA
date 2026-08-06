import type { WASocket } from '@whiskeysockets/baileys';
import { Channel } from '../interfaces/whatsapp-engine.interface';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { mapServerRefusal } from './baileys-groups';

/**
 * Channel-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysChannelsHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
}

export class BaileysChannels {
  constructor(private readonly host: BaileysChannelsHost) {}

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.host.ensureReady();
    // newsletterMetadata resolves ANY channel by jid (richer than the wwjs subscribed-list lookup).
    const meta = await this.sock().newsletterMetadata('jid', channelId);
    return meta ? this.toChannel(meta) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await this.sock().newsletterMetadata('invite', inviteCode);
    if (!meta) {
      throw new ChannelNotFoundError(inviteCode);
    }
    await this.sock().newsletterFollow(meta.id);
    return this.toChannel(meta);
  }

  async createChannel(name: string, description?: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await mapServerRefusal('Creating the channel', () => this.sock().newsletterCreate(name, description));
    return this.toChannel(meta);
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Deleting the channel', () => this.sock().newsletterDelete(channelId));
  }

  async muteChannel(channelId: string, mute: boolean): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal(mute ? 'Muting the channel' : 'Unmuting the channel', () =>
      mute ? this.sock().newsletterMute(channelId) : this.sock().newsletterUnmute(channelId),
    );
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().newsletterUnfollow(channelId);
  }

  /** Map a Baileys NewsletterMetadata to the neutral Channel shape (optionals only when present). */
  private toChannel(meta: {
    id: string;
    name: string;
    description?: string;
    invite?: string;
    creation_time?: number;
    subscribers?: number;
    picture?: { url?: string };
    verification?: string;
    thread_metadata?: { creation_time?: number };
  }): Channel {
    const createdAt = meta.creation_time ?? meta.thread_metadata?.creation_time;
    return {
      id: meta.id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.invite ? { inviteCode: meta.invite } : {}),
      ...(meta.subscribers !== undefined ? { subscriberCount: meta.subscribers } : {}),
      ...(meta.picture?.url ? { picture: meta.picture.url } : {}),
      ...(meta.verification ? { verified: meta.verification === 'VERIFIED' } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
}
