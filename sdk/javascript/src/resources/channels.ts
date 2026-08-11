/**
 * Channels resource — WhatsApp Channels / Newsletters.
 *
 * Backed by `src/modules/channel/channel.controller.ts` (`@Controller('sessions/:sessionId/channels')`).
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  CreateChannelRequest,
  DemoteChannelAdminRequest,
  MuteChannelRequest,
  TransferChannelOwnershipRequest,
  ChannelMessageQuery,
  ChannelMessageRecord,
  ChannelRecord,
  SubscribeChannelRequest,
  SuccessResult,
} from '../types.js';

export class ChannelsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all channels/newsletters the session is subscribed to. */
  list(sessionId: string): Promise<ChannelRecord[]> {
    return this.client.request<ChannelRecord[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels`,
    });
  }

  /** Get a single channel by id. */
  get(sessionId: string, channelId: string): Promise<ChannelRecord> {
    return this.client.request<ChannelRecord>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}`,
    });
  }

  /** Get recent messages from a channel. */
  messages(sessionId: string, channelId: string, query?: ChannelMessageQuery): Promise<ChannelMessageRecord[]> {
    return this.client.request<ChannelMessageRecord[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}/messages`,
      query,
    });
  }

  /** Create a channel. The account owns it, which is what makes `delete` possible later. */
  create(sessionId: string, body: CreateChannelRequest): Promise<ChannelRecord> {
    return this.client.request<ChannelRecord>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels`,
      body,
    });
  }

  /**
   * Delete a channel this account owns. Irreversible, and every subscriber loses it.
   *
   * Note the path: `unsubscribe` is the `DELETE` route, and these two are deliberately not reachable
   * by the same request — leaving a channel and destroying it are very different acts.
   */
  delete(sessionId: string, channelId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}/delete`,
    });
  }

  /** Mute or unmute a channel's notifications. The subscription is untouched either way. */
  mute(sessionId: string, channelId: string, body: MuteChannelRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}/mute`,
      body,
    });
  }

  /** Subscribe to a channel using its invite code. Requires an OPERATOR-level key. */
  subscribe(sessionId: string, body: SubscribeChannelRequest): Promise<ChannelRecord> {
    return this.client.request<ChannelRecord>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/subscribe`,
      body,
    });
  }

  /** Unsubscribe from a channel. Requires an OPERATOR-level key. */
  unsubscribe(sessionId: string, channelId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}`,
    });
  }
  /**
   * Demote a channel admin back to a subscriber. Requires an OPERATOR-level key.
   *
   * There is no promote counterpart: neither engine library has one, so an admin is promoted from
   * the WhatsApp app and demoted here. The whatsapp-web.js engine answers `501`.
   */
  demoteAdmin(sessionId: string, channelId: string, body: DemoteChannelAdminRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}/admins/demote`,
      body,
    });
  }

  /**
   * Hand a channel to a new owner. Requires an OPERATOR-level key.
   *
   * **Irreversible**: once the transfer lands this account stops being the owner and cannot take the
   * channel back. The whatsapp-web.js engine answers `501`.
   */
  transferOwnership(
    sessionId: string,
    channelId: string,
    body: TransferChannelOwnershipRequest,
  ): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/channels/${encodeSegment(channelId)}/owner/transfer`,
      body,
    });
  }
}
