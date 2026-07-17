/**
 * Channels resource — WhatsApp Channels / Newsletters.
 *
 * Backed by `src/modules/channel/channel.controller.ts` (`@Controller('sessions/:sessionId/channels')`).
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
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
}
